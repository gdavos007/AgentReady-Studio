/**
 * The CLI's audit runner.
 *
 * A thin, dependency-light wrapper over the core engine: scan, score, and
 * report whether the result clears the gate. Kept separate from argument
 * parsing and formatting so it can be called programmatically — a custom CI
 * script that wants the scorecard without the terminal output imports this.
 */

import {
  scanUrl,
  scoreAudit,
  runSyntheticEvaluation,
  type AgentScorecard,
  type AuditReport,
  type ScanDiagnostic,
  type ScannerOptions,
} from '@agentgrade/core';

/** Options for {@link runAudit}. */
export interface RunAuditOptions {
  /** Minimum score the target must reach to pass. */
  threshold: number;
  /** Navigation timeout in milliseconds. */
  timeoutMs?: number;
  /** Egress proxy for both navigation and descriptor fetches. */
  proxy?: string;
  /** Goal for the synthetic evaluator. Omit to skip the active evaluation. */
  syntheticGoal?: string;
  /** Extra HTTP headers, e.g. an auth header for a protected staging site. */
  headers?: Record<string, string>;
  /** Progress sink, called with a one-line status. */
  onProgress?: (message: string) => void;
  /** Reuse a browser across several audits. */
  browser?: ScannerOptions['browser'];
  /**
   * Permit auditing private, loopback, and link-local targets.
   *
   * Off by default, matching the scanner: a CI job that can be handed a URL
   * should not be a pivot into the runner's network. Operators auditing their
   * own staging box on a private address opt in explicitly.
   */
  allowPrivateTargets?: boolean;
  /** Launch Chromium with `--no-sandbox`. Only for unprivileged containers. */
  disableSandbox?: boolean;
  /** Disable the target's CSP. Records a `csp-bypassed` warning in the report. */
  bypassCsp?: boolean;
  /** Accept invalid TLS certificates. Records a `tls-errors-ignored` warning. */
  ignoreHttpsErrors?: boolean;
  /** Consult `/robots.txt` and refuse a target it disallows. */
  respectRobots?: boolean;
}

/** The outcome of one CLI audit. */
export interface AuditRunResult {
  url: string;
  report: AuditReport;
  scorecard: AgentScorecard;
  threshold: number;
  /** True when `scorecard.overallScore >= threshold`. */
  passed: boolean;
  /** Wall-clock duration of the whole run. */
  durationMs: number;
}

/**
 * Scans and scores a URL.
 *
 * Does not throw for target-level problems: a page that will not load still
 * returns a scored result whose `report.status` says `failed`, so the caller
 * decides whether an unreachable staging URL should block a build.
 */
export async function runAudit(url: string, options: RunAuditOptions): Promise<AuditRunResult> {
  const startedAt = Date.now();
  const target = normaliseUrl(url);

  options.onProgress?.(`Scanning ${target}`);

  const report = await scanUrl(target, {
    navigationTimeoutMs: options.timeoutMs,
    ...(options.proxy ? { proxy: { server: options.proxy } } : {}),
    ...(options.headers ? { extraHttpHeaders: options.headers } : {}),
    ...(options.browser ? { browser: options.browser } : {}),
    ...(options.allowPrivateTargets !== undefined
      ? { allowPrivateTargets: options.allowPrivateTargets }
      : {}),
    ...(options.disableSandbox !== undefined ? { disableSandbox: options.disableSandbox } : {}),
    ...(options.bypassCsp !== undefined ? { bypassCsp: options.bypassCsp } : {}),
    ...(options.ignoreHttpsErrors !== undefined
      ? { ignoreHttpsErrors: options.ignoreHttpsErrors }
      : {}),
    ...(options.respectRobots !== undefined ? { respectRobots: options.respectRobots } : {}),
    onDiagnostic: (diagnostic: ScanDiagnostic) => {
      if (diagnostic.level === 'error') options.onProgress?.(`error: ${diagnostic.message}`);
    },
  });

  options.onProgress?.(
    `Found ${report.data.tools.length} tool(s), ${report.data.forms.length} surface(s), ` +
      `${report.data.frictionTraps.length} friction trap(s)`,
  );

  const syntheticEvaluation = options.syntheticGoal
    ? await runSyntheticEvaluation(report.data, { goal: options.syntheticGoal })
    : null;

  const scorecard = scoreAudit(report.data, { syntheticEvaluation });
  options.onProgress?.(`Scored ${scorecard.overallScore}/100 (${scorecard.grade})`);

  return {
    url: target,
    report,
    scorecard,
    threshold: options.threshold,
    passed: scorecard.overallScore >= options.threshold,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Normalises a bare hostname into a URL.
 *
 * `agentgrade audit example.com` is what people type; requiring the scheme is
 * a papercut with no upside.
 */
export function normaliseUrl(input: string): string {
  const trimmed = (input ?? '').trim();
  if (!trimmed) throw new Error('A target URL is required.');
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`"${input}" is not a valid URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http and https targets are supported (got "${parsed.protocol}").`);
  }
  return parsed.toString();
}
