/**
 * AgentGrade — core inspection engine.
 *
 * Drives a headless Chromium session (with a CDP session attached), runs the
 * in-page inspector, probes the well-known agent descriptors, and assembles a
 * strictly-shaped {@link AuditReport}.
 *
 * The engine is defensive by construction: no single failing stage aborts the
 * scan. Recoverable problems are recorded as {@link ScanDiagnostic}s and the
 * report is downgraded to `partial`; only a completely unusable page yields
 * `failed`.
 */

import { randomUUID } from 'node:crypto';

import { gradeFor } from '../shared/grade.js';
import { checkHost, checkRequestUrl, privateTargetsAllowed } from '../lib/net-guard.js';
import { chromium, type Browser, type BrowserContext, type Page, type Response, type Route } from 'playwright';

import {
  mergeTags,
  probeAllDescriptors,
  scanStaticHtmlForToolTags,
  toolsFromDescriptors,
  toolsFromTags,
  type FetchLike,
} from './declarative-discovery.js';
import {
  EVALUATION_HELPER_SHIM,
  MODEL_CONTEXT_READY_EXPRESSION,
  STEALTH_INIT_SCRIPT,
  inspectAgentSurface,
} from './dom-inspector.js';
import {
  AUDIT_SCHEMA_VERSION,
  type AgentAuditRawData,
  type AuditReport,
  type AuditStatus,
  type DeclarativeToolTag,
  type DescriptorProbe,
  type DiscoveredForm,
  type DomInspectionResult,
  type FrictionTrap,
  type FrictionTrapType,
  type ModelContextProbe,
  type NavigationOutcome,
  type NavigationStatus,
  type PageMetadata,
  type RegisteredTool,
  type RuntimeWebMcpState,
  type ScanDiagnostic,
  type ScanSummary,
  type ScannerOptions,
  type TrapSeverity,
} from './types.js';

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

/** Resolved defaults for every {@link ScannerOptions} field. */
export const DEFAULT_OPTIONS = {
  totalTimeoutMs: 60_000,
  navigationTimeoutMs: 30_000,
  networkIdleTimeoutMs: 5_000,
  modelContextTimeoutMs: 3_000,
  descriptorTimeoutMs: 8_000,
  headless: true,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
  timezoneId: 'America/New_York',
  skipDescriptors: false,
  enableCdp: true,
  bypassCsp: false,
  ignoreHttpsErrors: false,
} as const;

/**
 * Header set that keeps well-behaved bot walls from serving an interstitial.
 * These mirror what a real Chrome sends; nothing here forges identity.
 */
const DEFAULT_HEADERS: Record<string, string> = {
  'accept-language': 'en-US,en;q=0.9',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};

/** Chromium flags that remove the most obvious automation fingerprints. */
const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
];

/** Environment escape hatch for platforms that cannot provide user namespaces. */
export const NO_SANDBOX_ENV = 'AGENTGRADE_NO_SANDBOX';

/**
 * Builds the Chromium argument list.
 *
 * Two flags are deliberately absent from {@link LAUNCH_ARGS}:
 *
 * `--no-sandbox` is the last line of defence between a hostile page's renderer
 * and the host user's SSH keys and npm tokens. This tool points a browser at
 * arbitrary untrusted URLs by design, so the sandbox is opt-in — set
 * `disableSandbox`, or `AGENTGRADE_NO_SANDBOX=1` in an unprivileged container
 * that cannot provide user namespaces.
 *
 * `--disable-features=IsolateOrigins,site-per-process` used to be here to make
 * iframe inspection easier. It disables Site Isolation, re-opening the
 * cross-origin leak defences that exist precisely because pages are hostile —
 * and it bought nothing, since the scanner reads the main frame's DOM rather
 * than cross-origin iframe internals.
 */
export function launchArgs(disableSandbox?: boolean): string[] {
  const args = [...LAUNCH_ARGS];
  if (disableSandbox ?? process.env[NO_SANDBOX_ENV] === '1') {
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }
  return args;
}

/** Text signatures that indicate a bot wall or consent interstitial. */
const BOT_WALL_PATTERNS: ReadonlyArray<{ signal: string; pattern: RegExp }> = [
  { signal: 'captcha', pattern: /\bcaptcha\b/i },
  { signal: 'recaptcha', pattern: /recaptcha/i },
  { signal: 'hcaptcha', pattern: /hcaptcha/i },
  { signal: 'cloudflare-challenge', pattern: /checking your browser|cf-browser-verification|cf-challenge/i },
  { signal: 'human-verification', pattern: /verify (?:you are|you're) (?:a )?human|are you a robot/i },
  { signal: 'access-denied', pattern: /access denied|request blocked|you have been blocked/i },
  { signal: 'unusual-traffic', pattern: /unusual traffic|automated queries/i },
];

/* -------------------------------------------------------------------------- */
/* Small utilities                                                             */
/* -------------------------------------------------------------------------- */

const nowIso = (): string => new Date().toISOString();

const isTimeoutError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'TimeoutError' || /timeout/i.test(error.message));

/**
 * Rejects with a `TimeoutError`-shaped error if `promise` outlives `ms`, or as
 * soon as `deadline` fires — whichever comes first.
 *
 * The deadline is the part that matters. Per-step budgets alone do not bound a
 * scan: each step is floored at a second so it always gets a chance to run, and
 * `page.goto` carries its own navigation timeout, so a target that stalls every
 * stage a little runs well past `totalTimeoutMs` in aggregate. Threading one
 * `AbortSignal` through every awaited step makes the total an actual ceiling
 * rather than the sum of a dozen optimistic ones.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  deadline?: AbortSignal,
): Promise<T> {
  // Claimed first, before any early return. The losing side of the race is
  // abandoned rather than cancelled — a `page.evaluate` we stopped waiting for
  // still rejects when the context closes — and an abandoned rejection with no
  // handler is an unhandled rejection that can take the process down. Note
  // that `promise` was already created by the caller evaluating the argument,
  // so bailing out below without attaching this would leak one.
  promise.catch(() => undefined);

  if (deadline?.aborted) throw budgetExpired(label);

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label} exceeded ${ms}ms`);
          error.name = 'TimeoutError';
          reject(error);
        }, ms);
        if (typeof timer.unref === 'function') timer.unref();

        if (deadline) {
          onAbort = (): void => reject(budgetExpired(label));
          deadline.addEventListener('abort', onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (deadline && onAbort) deadline.removeEventListener('abort', onAbort);
  }
}

/**
 * Upper bound on the served HTML retained for the static discovery pass.
 *
 * The static pass regex-scans this markup for declarative annotations; two
 * megabytes is far past any real document's head-and-body markup, and the
 * annotations it looks for appear in the authored source, not after a
 * megabyte of inlined base64.
 */
export const MAX_SERVED_HTML_CHARS = 2_000_000;

/**
 * Reads the page's HTML with the size decided here rather than by the target.
 *
 * `page.content()` serialises the whole document and ships every byte across
 * the CDP boundary into this process, so a page that generates a gigabyte of
 * markup — trivially, a loop appending nodes — is a remote-triggered OOM in the
 * scanner, not in the browser that is sandboxed and disposable.
 *
 * So the length is measured in the renderer first and only a bounded prefix
 * ever crosses. The count is taken from `documentElement.outerHTML.length`
 * because that is the exact string `page.content()` would have returned;
 * element counts are cheaper but do not bound the byte size of one enormous
 * attribute or text node.
 */
export async function readServedHtml(page: Page, log?: DiagnosticLog): Promise<string> {
  const result = await page.evaluate((limit: number) => {
    const root = document.documentElement;
    if (!root) return { html: '', length: 0, truncated: false };
    const html = root.outerHTML;
    return {
      html: html.length > limit ? html.slice(0, limit) : html,
      length: html.length,
      truncated: html.length > limit,
    };
  }, MAX_SERVED_HTML_CHARS);

  if (result.truncated) {
    // Not silent: the static discovery pass scans this markup for declarative
    // annotations, so a reader has to know that a missing `<tool-definition>`
    // might mean "past the cap" rather than "not there".
    log?.add(
      'warning',
      'dom',
      'served-html-truncated',
      `Document was ${result.length} characters; only the first ${MAX_SERVED_HTML_CHARS} were scanned for declarative annotations.`,
    );
  }

  return result.html;
}

/** The error raised when the whole-scan budget runs out mid-step. */
function budgetExpired(label: string): Error {
  const error = new Error(`${label} abandoned: the total scan budget expired`);
  error.name = 'TimeoutError';
  return error;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message.split('\n')[0] : String(error);

/** Accumulates diagnostics and exposes the counters the summary needs. */
export class DiagnosticLog {
  readonly entries: ScanDiagnostic[] = [];

  constructor(private readonly sink?: (diagnostic: ScanDiagnostic) => void) {}

  add(level: ScanDiagnostic['level'], stage: ScanDiagnostic['stage'], code: string, message: string): void {
    const diagnostic: ScanDiagnostic = { level, stage, code, message: message.slice(0, 2000), at: nowIso() };
    this.entries.push(diagnostic);
    try {
      this.sink?.(diagnostic);
    } catch {
      /* a broken sink must never fail the scan */
    }
  }

  count(level: ScanDiagnostic['level']): number {
    return this.entries.filter((entry) => entry.level === level).length;
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Audits a single URL and returns the raw inspection data.
 *
 * Never throws for page-level problems (bad DNS, 404s, bot walls, timeouts):
 * those are reported through {@link AuditReport.status} and the diagnostics
 * list. It only throws if Chromium itself cannot be launched.
 */
export async function scanUrl(targetUrl: string, options: ScannerOptions = {}): Promise<AuditReport> {
  const startedAtMs = Date.now();
  const startedAt = nowIso();
  const log = new DiagnosticLog(options.onDiagnostic);

  const config = {
    totalTimeoutMs: options.totalTimeoutMs ?? DEFAULT_OPTIONS.totalTimeoutMs,
    navigationTimeoutMs: options.navigationTimeoutMs ?? DEFAULT_OPTIONS.navigationTimeoutMs,
    networkIdleTimeoutMs: options.networkIdleTimeoutMs ?? DEFAULT_OPTIONS.networkIdleTimeoutMs,
    modelContextTimeoutMs: options.modelContextTimeoutMs ?? DEFAULT_OPTIONS.modelContextTimeoutMs,
    descriptorTimeoutMs: options.descriptorTimeoutMs ?? DEFAULT_OPTIONS.descriptorTimeoutMs,
    headless: options.headless ?? DEFAULT_OPTIONS.headless,
    userAgent: options.userAgent ?? DEFAULT_OPTIONS.userAgent,
    viewport: options.viewport ?? { ...DEFAULT_OPTIONS.viewport },
    locale: options.locale ?? DEFAULT_OPTIONS.locale,
    timezoneId: options.timezoneId ?? DEFAULT_OPTIONS.timezoneId,
    skipDescriptors: options.skipDescriptors ?? DEFAULT_OPTIONS.skipDescriptors,
    enableCdp: options.enableCdp ?? DEFAULT_OPTIONS.enableCdp,
    bypassCsp: options.bypassCsp ?? DEFAULT_OPTIONS.bypassCsp,
    ignoreHttpsErrors: options.ignoreHttpsErrors ?? DEFAULT_OPTIONS.ignoreHttpsErrors,
    extraHttpHeaders: options.extraHttpHeaders ?? {},
    allowPrivateTargets: privateTargetsAllowed(options.allowPrivateTargets),
  };

  // Both of these weaken a boundary the scan otherwise relies on, and both are
  // invisible in the finished report unless the report says so. A reader has to
  // be able to tell a clean scan from one gathered with the guardrails down.
  if (config.bypassCsp) {
    log.add(
      'warning',
      'launch',
      'csp-bypassed',
      "Content-Security-Policy was disabled for this scan; the target's script restrictions were not in force.",
    );
  }
  if (config.ignoreHttpsErrors) {
    log.add(
      'warning',
      'launch',
      'tls-errors-ignored',
      'TLS certificate errors were ignored for this scan; the identity of the host that answered was not verified.',
    );
  }

  const normalisedUrl = normaliseUrl(targetUrl);
  if (!normalisedUrl.ok) {
    log.add('error', 'navigate', 'invalid-url', normalisedUrl.error);
    return failedReport({
      requestedUrl: targetUrl,
      origin: '',
      startedAt,
      startedAtMs,
      userAgent: config.userAgent,
      viewport: config.viewport,
      log,
      navigationError: normalisedUrl.error,
      navigationStatus: 'network-error',
    });
  }

  const url = normalisedUrl.url;

  // H1: refuse a private target before a browser is even launched. Checked by
  // resolved address rather than by hostname text, because `evil.test` can have
  // an A record pointing at the metadata endpoint.
  if (!config.allowPrivateTargets) {
    const guard = await guardTarget(url);
    if (guard) {
      log.add('error', 'navigate', 'blocked-private-target', guard);
      return failedReport({
        requestedUrl: url,
        origin: originOf(url),
        startedAt,
        startedAtMs,
        userAgent: config.userAgent,
        viewport: config.viewport,
        log,
        navigationError: guard,
        navigationStatus: 'blocked',
      });
    }
  }

  let browser: Browser | null = null;
  let ownsBrowser = false;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    if (options.browser) {
      browser = options.browser as unknown as Browser;
    } else {
      try {
        browser = await chromium.launch({
          headless: config.headless,
          args: launchArgs(options.disableSandbox),
        });
        ownsBrowser = true;
      } catch (error) {
        log.add('error', 'launch', 'browser-launch-failed', messageOf(error));
        throw error;
      }
    }

    context = await browser.newContext({
      userAgent: config.userAgent,
      viewport: { ...config.viewport },
      locale: config.locale,
      timezoneId: config.timezoneId,
      ignoreHTTPSErrors: config.ignoreHttpsErrors,
      javaScriptEnabled: true,
      bypassCSP: config.bypassCsp,
      serviceWorkers: 'block',
      extraHTTPHeaders: { ...DEFAULT_HEADERS, ...config.extraHttpHeaders },
      ...(options.proxy ? { proxy: options.proxy } : {}),
    });
    // M5: a pre-flight check cannot see a 302. Every request the page makes —
    // the main document, its redirects, and every subresource — is re-checked
    // against its resolved address here. Registered only when private targets
    // are disallowed, so the permitted path pays no DNS cost.
    if (!config.allowPrivateTargets) {
      await context.route(
        '**/*',
        createNetworkGuardRoute((reason) => log.add('warning', 'navigate', 'blocked-private-request', reason)),
      );
    }

    context.setDefaultTimeout(config.navigationTimeoutMs);
    context.setDefaultNavigationTimeout(config.navigationTimeoutMs);
    await context.addInitScript(EVALUATION_HELPER_SHIM);
    await context.addInitScript(STEALTH_INIT_SCRIPT);

    page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => {
      if (consoleErrors.length < 20) consoleErrors.push(messageOf(error));
    });

    if (config.enableCdp) {
      await attachCdpSession(context, page, log);
    }

    const elapsed = (): number => Date.now() - startedAtMs;
    const remaining = (): number => Math.max(1_000, config.totalTimeoutMs - elapsed());

    // The hard ceiling for everything below. `remaining()` still sizes each
    // step so a well-behaved target is not cut off early, but this is what
    // makes `totalTimeoutMs` a ceiling rather than the sum of a dozen
    // optimistic per-step budgets.
    const deadline = AbortSignal.timeout(remaining());

    /* ---- Navigation --------------------------------------------------- */
    const navigation = await navigate(page, url, config, log, deadline);

    if (navigation.status === 'timeout-hard' || navigation.status === 'network-error') {
      return failedReport({
        requestedUrl: url,
        origin: originOf(url),
        startedAt,
        startedAtMs,
        userAgent: config.userAgent,
        viewport: config.viewport,
        log,
        navigationError: navigation.error,
        navigationStatus: navigation.status,
        navigation,
      });
    }

    for (const error of consoleErrors) {
      log.add('info', 'navigate', 'page-error', error);
    }

    /* ---- Served HTML (for the static discovery pass) ------------------- */
    let servedHtml = '';
    try {
      servedHtml = await withTimeout(
        readServedHtml(page, log),
        Math.min(10_000, remaining()),
        'page.content()',
        deadline,
      );
    } catch (error) {
      log.add('warning', 'dom', 'content-read-failed', messageOf(error));
    }

    /* ---- Runtime WebMCP settle wait ----------------------------------- */
    const settleStart = Date.now();
    let runtimeReady = false;
    try {
      await withTimeout(
        page.waitForFunction(MODEL_CONTEXT_READY_EXPRESSION, undefined, {
          timeout: Math.min(config.modelContextTimeoutMs, remaining()),
          polling: 100,
        }),
        Math.min(config.modelContextTimeoutMs, remaining()) + 500,
        'WebMCP settle wait',
        deadline,
      );
      runtimeReady = true;
    } catch (error) {
      if (isTimeoutError(error)) {
        log.add('info', 'runtime', 'model-context-absent', 'No WebMCP runtime registry appeared before the deadline.');
      } else {
        log.add('warning', 'runtime', 'model-context-probe-failed', messageOf(error));
      }
    }
    const settleMs = Date.now() - settleStart;

    /* ---- In-page inspection ------------------------------------------- */
    let inspection: DomInspectionResult | null = null;
    try {
      inspection = await withTimeout(
        page.evaluate(inspectAgentSurface),
        Math.min(20_000, remaining()),
        'DOM inspection',
        deadline,
      );
    } catch (error) {
      log.add('error', 'dom', 'dom-inspection-failed', messageOf(error));
    }

    for (const error of inspection?.errors ?? []) {
      log.add('warning', 'dom', 'dom-inspection-partial', error);
    }

    /* ---- Descriptor probing ------------------------------------------- */
    const origin = originOf(navigation.finalUrl ?? url);
    let descriptors: DescriptorProbe[] = [];
    if (config.skipDescriptors) {
      log.add('info', 'descriptors', 'descriptors-skipped', 'Descriptor probing disabled by options.');
    } else {
      try {
        descriptors = await withTimeout(
          probeAllDescriptors(context.request as unknown as FetchLike, origin, config.descriptorTimeoutMs),
          Math.min(config.descriptorTimeoutMs * 3, remaining()),
          'descriptor probing',
          deadline,
        );
      } catch (error) {
        log.add('warning', 'descriptors', 'descriptor-probe-failed', messageOf(error));
      }
      for (const probe of descriptors) {
        if (probe.error) {
          log.add('info', 'descriptors', 'descriptor-unavailable', `${probe.url}: ${probe.error}`);
        }
      }
    }

    const data = assemble({
      scanId: randomUUID(),
      requestedUrl: url,
      origin,
      startedAt,
      startedAtMs,
      config,
      navigation,
      inspection,
      descriptors,
      servedHtml,
      settleMs,
      runtimeReady,
      log,
    });

    return {
      status: statusFor(data, log),
      generatedAt: nowIso(),
      durationMs: Date.now() - startedAtMs,
      data,
    };
  } finally {
    await closeQuietly(page, context, ownsBrowser ? browser : null, log);
  }
}

/**
 * Scans several URLs sequentially, reusing one Chromium instance. Sequential by
 * design: parallel contexts distort the timing signals the audit relies on.
 */
export async function scanUrls(urls: string[], options: ScannerOptions = {}): Promise<AuditReport[]> {
  if (urls.length === 0) return [];
  if (options.browser) {
    const reports: AuditReport[] = [];
    for (const url of urls) reports.push(await scanUrl(url, options));
    return reports;
  }

  const browser = await chromium.launch({
    headless: options.headless ?? DEFAULT_OPTIONS.headless,
    args: launchArgs(options.disableSandbox),
  });
  try {
    const reports: AuditReport[] = [];
    for (const url of urls) {
      reports.push(await scanUrl(url, { ...options, browser: browser as unknown as ScannerOptions['browser'] }));
    }
    return reports;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/* -------------------------------------------------------------------------- */
/* Stages                                                                      */
/* -------------------------------------------------------------------------- */

function normaliseUrl(input: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return { ok: false, error: 'Target URL is empty' };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: `Target URL is not parseable: ${trimmed}` };
  }
  if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
    return { ok: false, error: `Unsupported protocol "${parsed.protocol}"` };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * The route handler that enforces the SSRF guard on every outbound request.
 *
 * Exported so tests exercise the shipped handler rather than a reimplementation
 * of it — a copy in the test suite would pass while the real one regressed.
 *
 * @param onBlocked Notified with a reason whenever a request is aborted.
 */
export function createNetworkGuardRoute(
  onBlocked?: (reason: string) => void,
): (route: Route) => Promise<void> {
  return async (route: Route): Promise<void> => {
    try {
      const url = route.request().url();
      const verdict = await checkRequestUrl(url);
      if (verdict.allowed) return await route.continue();

      onBlocked?.(`${url}: ${verdict.reason}`);
      return await route.abort('blockedbyclient');
    } catch {
      // A route that can no longer be fulfilled (the page closed mid-flight)
      // must not wedge the scan.
      try {
        await route.abort('failed');
      } catch {
        /* already handled */
      }
    }
  };
}

/**
 * Pre-flight guard for the initial target.
 * Returns a reason string when the target must not be scanned, else `null`.
 */
async function guardTarget(url: string): Promise<string | null> {
  const parsed = new URL(url);

  // `file:` reads the host filesystem. Legitimate for a local library caller,
  // never legitimate for one that did not opt in.
  if (parsed.protocol === 'file:') {
    return 'Refusing to scan a file:// target: set allowPrivateTargets to read local files.';
  }

  const verdict = await checkHost(parsed.hostname);
  return verdict.allowed ? null : `Refusing to scan ${parsed.origin}: ${verdict.reason}`;
}

function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? `${parsed.protocol}//` : parsed.origin;
  } catch {
    return '';
  }
}

/** Attaches a CDP session and cross-checks the WebMCP surface through it. */
async function attachCdpSession(context: BrowserContext, page: Page, log: DiagnosticLog): Promise<void> {
  try {
    const session = await context.newCDPSession(page);
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Network.enable', {});
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);

    // Cross-check the registry through CDP so a page that tampers with the
    // Playwright binding cannot hide its tools from the audit.
    page.once('load', () => {
      void session
        .send('Runtime.evaluate', { expression: MODEL_CONTEXT_READY_EXPRESSION, returnByValue: true })
        .then((result) => {
          const detected = Boolean((result as { result?: { value?: unknown } }).result?.value);
          log.add(
            'info',
            'runtime',
            'cdp-model-context',
            `CDP cross-check reports WebMCP registry ${detected ? 'present' : 'absent'}.`,
          );
        })
        .catch((error: unknown) => {
          log.add('info', 'runtime', 'cdp-evaluate-failed', messageOf(error));
        });

      void session
        .send('Page.getFrameTree')
        .then((tree) => {
          const count = countFrames((tree as { frameTree?: CdpFrameTree }).frameTree);
          log.add('info', 'dom', 'cdp-frame-tree', `CDP frame tree contains ${count} frame(s).`);
        })
        .catch(() => undefined);
    });

    log.add('info', 'launch', 'cdp-attached', 'Chrome DevTools Protocol session attached.');
  } catch (error) {
    log.add('warning', 'launch', 'cdp-attach-failed', messageOf(error));
  }
}

interface CdpFrameTree {
  childFrames?: CdpFrameTree[];
}

function countFrames(tree: CdpFrameTree | undefined): number {
  if (!tree) return 0;
  return 1 + (tree.childFrames ?? []).reduce((total, child) => total + countFrames(child), 0);
}

async function navigate(
  page: Page,
  url: string,
  config: { navigationTimeoutMs: number; networkIdleTimeoutMs: number },
  log: DiagnosticLog,
  deadline?: AbortSignal,
): Promise<NavigationOutcome> {
  const start = Date.now();
  const outcome: NavigationOutcome = {
    status: 'loaded',
    requestedUrl: url,
    finalUrl: null,
    httpStatus: null,
    title: null,
    durationMs: 0,
    redirectCount: 0,
    botWallDetected: false,
    botWallSignals: [],
    error: null,
  };

  let response: Response | null = null;
  try {
    response = await withTimeout(
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs }),
      config.navigationTimeoutMs + 1_000,
      'navigation',
      deadline,
    );
  } catch (error) {
    outcome.durationMs = Date.now() - start;
    outcome.error = messageOf(error);
    if (isTimeoutError(error)) {
      // The DOM may still be usable even though `goto` gave up.
      // A hung navigation leaves `evaluate` waiting forever, so bound it.
      const usable = await withTimeout(
        page.evaluate(
          () => document.readyState !== 'loading' && !!document.body && document.body.childElementCount > 0,
        ),
        2_000,
        'post-timeout readiness probe',
        deadline,
      ).catch(() => false);
      outcome.status = usable ? 'timeout-soft' : 'timeout-hard';
      log.add(
        usable ? 'warning' : 'error',
        'navigate',
        usable ? 'navigation-timeout-recovered' : 'navigation-timeout',
        outcome.error,
      );
      if (!usable) return outcome;
    } else {
      outcome.status = 'network-error';
      log.add('error', 'navigate', 'navigation-failed', outcome.error);
      return outcome;
    }
  }

  if (response) {
    outcome.httpStatus = response.status();
    let redirect = response.request().redirectedFrom();
    while (redirect && outcome.redirectCount < 20) {
      outcome.redirectCount++;
      redirect = redirect.redirectedFrom();
    }
  }

  try {
    await withTimeout(
      page.waitForLoadState('networkidle', { timeout: config.networkIdleTimeoutMs }),
      config.networkIdleTimeoutMs + 1_000,
      'network idle wait',
      deadline,
    );
  } catch (error) {
    if (outcome.status === 'loaded') outcome.status = 'timeout-soft';
    log.add(
      'info',
      'navigate',
      'network-idle-timeout',
      `Network never went idle within ${config.networkIdleTimeoutMs}ms; inspecting the page as-is.`,
    );
    void error;
  }

  outcome.finalUrl = page.url();
  outcome.title = await page.title().catch(() => null);
  outcome.durationMs = Date.now() - start;

  const detection = await detectBotWall(page, outcome.httpStatus, outcome.title);
  outcome.botWallDetected = detection.detected;
  outcome.botWallSignals = detection.signals;
  if (detection.detected) {
    outcome.status = 'blocked';
    log.add('warning', 'navigate', 'bot-wall-detected', `Bot wall signals: ${detection.signals.join(', ')}`);
  } else if (outcome.httpStatus !== null && outcome.httpStatus >= 400) {
    outcome.status = 'http-error';
    log.add('warning', 'navigate', 'http-error', `Target responded with HTTP ${outcome.httpStatus}.`);
  }

  return outcome;
}

async function detectBotWall(
  page: Page,
  httpStatus: number | null,
  title: string | null,
): Promise<{ detected: boolean; signals: string[] }> {
  const signals: string[] = [];
  if (httpStatus === 403) signals.push('http-403');
  if (httpStatus === 429) signals.push('http-429');

  let sample = title ?? '';
  try {
    sample += ' ' + (await page.evaluate(() => (document.body ? (document.body.innerText || '').slice(0, 4000) : '')));
    const challengeMarkers = await page.evaluate(() =>
      [
        '#cf-challenge-running',
        '#challenge-form',
        'iframe[src*="recaptcha"]',
        'iframe[src*="hcaptcha"]',
        '[data-sitekey]',
        '#px-captcha',
      ].filter((selector) => !!document.querySelector(selector)),
    );
    for (const marker of challengeMarkers) signals.push(`selector:${marker}`);
  } catch {
    /* an unreadable body is handled by the pattern pass below */
  }

  for (const { signal, pattern } of BOT_WALL_PATTERNS) {
    if (pattern.test(sample)) signals.push(signal);
  }

  const unique = Array.from(new Set(signals));
  // A bare 403 without any challenge markup is an authorisation failure, not a
  // bot wall — do not mislabel it.
  const detected = unique.some((signal) => !signal.startsWith('http-')) || unique.length > 1;
  return { detected, signals: unique };
}

async function closeQuietly(
  page: Page | null,
  context: BrowserContext | null,
  browser: Browser | null,
  log: DiagnosticLog,
): Promise<void> {
  for (const [label, closer] of [
    ['page', () => page?.close()],
    ['context', () => context?.close()],
    ['browser', () => browser?.close()],
  ] as const) {
    try {
      await closer();
    } catch (error) {
      log.add('info', 'teardown', `${label}-close-failed`, messageOf(error));
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                    */
/* -------------------------------------------------------------------------- */

interface AssembleInput {
  scanId: string;
  requestedUrl: string;
  origin: string;
  startedAt: string;
  startedAtMs: number;
  config: { userAgent: string; viewport: { width: number; height: number } };
  navigation: NavigationOutcome;
  inspection: DomInspectionResult | null;
  descriptors: DescriptorProbe[];
  servedHtml: string;
  settleMs: number;
  runtimeReady: boolean;
  log: DiagnosticLog;
}

function assemble(input: AssembleInput): AgentAuditRawData {
  const inspection = input.inspection;

  const probes = inspection?.probes ?? [
    emptyProbe('navigator.modelContext'),
    emptyProbe('document.modelContext'),
  ];
  const runtimeTools = dedupeTools(probes.flatMap((probe) => probe.tools));
  const runtime: RuntimeWebMcpState = {
    detected: probes.some((probe) => probe.supportsRegistration || probe.tools.length > 0),
    settleMs: input.settleMs,
    probes,
    tools: runtimeTools,
  };

  const staticTags = scanStaticHtmlForToolTags(input.servedHtml);
  const tags: DeclarativeToolTag[] = mergeTags(inspection?.tags ?? [], staticTags);
  const declarativeTools = dedupeTools([...toolsFromTags(tags), ...toolsFromDescriptors(input.descriptors)]);

  const forms: DiscoveredForm[] = inspection?.forms ?? [];
  const frictionTraps: FrictionTrap[] = inspection?.frictionTraps ?? [];
  const tools = dedupeTools([...runtimeTools, ...declarativeTools]);

  const summary = summarise({
    tools,
    runtimeTools,
    declarativeTags: tags,
    descriptors: input.descriptors,
    forms,
    frictionTraps,
    controlCount: inspection?.controls.length ?? 0,
    runtimeDetected: runtime.detected,
    page: inspection?.page ?? emptyPageMetadata(),
    scanDurationMs: Date.now() - input.startedAtMs,
    warningCount: input.log.count('warning'),
    errorCount: input.log.count('error'),
  });

  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    scanId: input.scanId,
    target: {
      requestedUrl: input.requestedUrl,
      origin: input.origin,
      startedAt: input.startedAt,
      finishedAt: nowIso(),
      userAgent: input.config.userAgent,
      viewport: { ...input.config.viewport },
    },
    navigation: input.navigation,
    page: inspection?.page ?? emptyPageMetadata(),
    runtime,
    declarative: {
      descriptors: input.descriptors,
      tags,
      tools: declarativeTools,
      manifestLinks: inspection?.manifestLinks ?? [],
    },
    tools,
    forms,
    controls: inspection?.controls ?? [],
    frictionTraps,
    summary,
    diagnostics: input.log.entries,
  };
}

function emptyProbe(path: 'navigator.modelContext' | 'document.modelContext'): ModelContextProbe {
  return {
    path,
    present: false,
    valueType: null,
    apiSurface: [],
    supportsRegistration: false,
    tools: [],
    error: 'DOM inspection did not run',
  };
}

function emptyPageMetadata(): PageMetadata {
  return {
    title: null,
    lang: null,
    description: null,
    landmarkCount: 0,
    hasSingleMainLandmark: false,
    headingLevels: [],
    domNodeCount: 0,
    shadowRootCount: 0,
    iframeCount: 0,
    requiresJavaScript: false,
  };
}

/** Keeps the first tool seen for each `id`, preferring executable runtime ones. */
function dedupeTools(tools: RegisteredTool[]): RegisteredTool[] {
  const byKey = new Map<string, RegisteredTool>();
  for (const tool of tools) {
    const key = tool.id;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, tool);
      continue;
    }
    // Prefer the richer record when the same tool is declared twice.
    const existingScore = (existing.executable ? 2 : 0) + (existing.inputSchema.isStructured ? 1 : 0);
    const candidateScore = (tool.executable ? 2 : 0) + (tool.inputSchema.isStructured ? 1 : 0);
    if (candidateScore > existingScore) byKey.set(key, tool);
  }
  return Array.from(byKey.values());
}

interface SummaryInput {
  tools: RegisteredTool[];
  runtimeTools: RegisteredTool[];
  declarativeTags: DeclarativeToolTag[];
  descriptors: DescriptorProbe[];
  forms: DiscoveredForm[];
  frictionTraps: FrictionTrap[];
  controlCount: number;
  runtimeDetected: boolean;
  page: PageMetadata;
  scanDurationMs: number;
  warningCount: number;
  errorCount: number;
}

const CRITICAL_CATEGORIES = new Set(['checkout', 'authentication', 'signup', 'search']);
const SEVERITY_WEIGHT: Record<TrapSeverity, number> = { critical: 8, high: 4, medium: 2, low: 1 };

function summarise(input: SummaryInput): ScanSummary {
  const trapsBySeverity: Record<TrapSeverity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  const trapsByType: Partial<Record<FrictionTrapType, number>> = {};
  for (const trap of input.frictionTraps) {
    trapsBySeverity[trap.severity] = (trapsBySeverity[trap.severity] ?? 0) + 1;
    trapsByType[trap.type] = (trapsByType[trap.type] ?? 0) + 1;
  }

  const manifestTools = input.tools.filter(
    (tool) => tool.source === 'well-known-mcp' || tool.source === 'well-known-agent' || tool.source === 'llms-txt',
  );
  const declarativeTools = input.tools.filter(
    (tool) => tool.source === 'declarative-element' || tool.source === 'declarative-form',
  );
  const runtimeToolCount = input.runtimeTools.length;
  const toolsWithSchema = input.tools.filter((tool) => tool.inputSchema.isStructured).length;
  const toolsWithDescription = input.tools.filter((tool) => !!tool.description).length;

  const hasWellKnownManifest = input.descriptors.some(
    (probe) => probe.found && (probe.kind === 'well-known-mcp' || probe.kind === 'well-known-agent'),
  );
  const hasLlmsTxt = input.descriptors.some((probe) => probe.found && probe.kind === 'llms-txt');

  const criticalForms = input.forms.filter((form) => CRITICAL_CATEGORIES.has(form.category));
  const fullyLabelled = input.forms.filter((form) => form.fullyLabelled);

  /* Composite score: capability first, then quality, minus friction. */
  let score = 0;
  if (input.runtimeDetected) score += runtimeToolCount > 0 ? 40 : 15;
  if (hasWellKnownManifest) score += 15;
  if (hasLlmsTxt) score += 5;
  if (declarativeTools.length > 0) score += 10;

  if (input.tools.length > 0) {
    score += Math.round(6 * (toolsWithDescription / input.tools.length));
    score += Math.round(6 * (toolsWithSchema / input.tools.length));
  }

  if (input.forms.length > 0) {
    score += Math.round(12 * (fullyLabelled.length / input.forms.length));
  } else {
    score += 6; // Nothing to mislabel.
  }

  if (input.page.hasSingleMainLandmark) score += 3;
  if (input.page.landmarkCount >= 3) score += 2;
  if (input.page.headingLevels.includes(1)) score += 2;
  if (!input.page.requiresJavaScript) score += 3;

  const penalty = Math.min(
    45,
    input.frictionTraps.reduce((total, trap) => total + SEVERITY_WEIGHT[trap.severity], 0),
  );
  score = Math.max(0, Math.min(100, score - penalty));

  // Graded on the shared scale so the CLI, the API, and the studio never
  // disagree about what a "B" means.
  const grade = gradeFor(score);

  return {
    totalTools: input.tools.length,
    runtimeToolCount,
    declarativeToolCount: declarativeTools.length,
    manifestToolCount: manifestTools.length,
    toolsWithSchema,
    toolsWithDescription,
    formCount: input.forms.length,
    criticalFormCount: criticalForms.length,
    fullyLabelledFormCount: fullyLabelled.length,
    frictionTrapCount: input.frictionTraps.length,
    trapsBySeverity,
    trapsByType,
    hasWebMcpRuntime: input.runtimeDetected,
    hasWellKnownManifest,
    hasLlmsTxt,
    agentReadinessScore: score,
    grade,
    interactiveControlCount: input.controlCount,
    scanDurationMs: input.scanDurationMs,
    warningCount: input.warningCount,
    errorCount: input.errorCount,
  };
}

function statusFor(data: AgentAuditRawData, log: DiagnosticLog): AuditStatus {
  if (data.navigation.status === 'timeout-hard' || data.navigation.status === 'network-error') return 'failed';
  if (log.count('error') > 0) return 'partial';
  if (data.navigation.status !== 'loaded') return 'partial';
  if (log.count('warning') > 0) return 'partial';
  return 'ok';
}

/* -------------------------------------------------------------------------- */
/* Failure path                                                                */
/* -------------------------------------------------------------------------- */

interface FailedReportInput {
  requestedUrl: string;
  origin: string;
  startedAt: string;
  startedAtMs: number;
  userAgent: string;
  viewport: { width: number; height: number };
  log: DiagnosticLog;
  navigationError: string | null;
  navigationStatus: NavigationStatus;
  navigation?: NavigationOutcome;
}

/** Builds a schema-valid report for a target that could not be inspected. */
function failedReport(input: FailedReportInput): AuditReport {
  const navigation: NavigationOutcome = input.navigation ?? {
    status: input.navigationStatus,
    requestedUrl: input.requestedUrl,
    finalUrl: null,
    httpStatus: null,
    title: null,
    durationMs: Date.now() - input.startedAtMs,
    redirectCount: 0,
    botWallDetected: false,
    botWallSignals: [],
    error: input.navigationError,
  };

  const page = emptyPageMetadata();
  const summary = summarise({
    tools: [],
    runtimeTools: [],
    declarativeTags: [],
    descriptors: [],
    forms: [],
    frictionTraps: [],
    controlCount: 0,
    runtimeDetected: false,
    page,
    scanDurationMs: Date.now() - input.startedAtMs,
    warningCount: input.log.count('warning'),
    errorCount: input.log.count('error'),
  });

  return {
    status: 'failed',
    generatedAt: nowIso(),
    durationMs: Date.now() - input.startedAtMs,
    data: {
      schemaVersion: AUDIT_SCHEMA_VERSION,
      scanId: randomUUID(),
      target: {
        requestedUrl: input.requestedUrl,
        origin: input.origin,
        startedAt: input.startedAt,
        finishedAt: nowIso(),
        userAgent: input.userAgent,
        viewport: { ...input.viewport },
      },
      navigation,
      page,
      runtime: {
        detected: false,
        settleMs: 0,
        probes: [emptyProbe('navigator.modelContext'), emptyProbe('document.modelContext')],
        tools: [],
      },
      declarative: { descriptors: [], tags: [], tools: [], manifestLinks: [] },
      tools: [],
      forms: [],
      controls: [],
      frictionTraps: [],
      summary: { ...summary, agentReadinessScore: 0, grade: 'F' },
      diagnostics: input.log.entries,
    },
  };
}
