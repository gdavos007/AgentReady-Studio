/**
 * Corpus scanning — many sites, one table.
 *
 * A single audit answers "is this site agent-ready?". A corpus answers the
 * question that actually settles product decisions: *how does this metric vary
 * across the web?* A score that lands every site in the same band is not
 * measuring anything, and the only way to know is to run a few hundred and look
 * at the distribution.
 *
 * Three properties this module is built around:
 *
 *  1. **One site's failure is a row, not an abort.** A batch that dies on the
 *     fourth of two hundred domains has wasted an hour of scanning. Every
 *     target is isolated, and a refusal is recorded as data.
 *  2. **Progress goes to stderr, results to stdout.** `scan-corpus … > out.csv`
 *     has to produce a clean CSV while still showing a human what is happening.
 *  3. **Politeness is the default.** This drives a real browser against sites
 *     that did not ask to be measured. Concurrency is low, and requests to one
 *     host are spaced.
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises';

import {
  domainOf,
  scanUrl,
  scoreAudit,
  toCorpusRow,
  toFailedRow,
  type CorpusRow,
  type ScannerOptions,
} from '@agentgrade/core';

/** Default parallel scans. Two browsers is already a lot of memory. */
export const DEFAULT_CONCURRENCY = 2;

/** Upper bound on `--concurrency`, whatever the caller asks for. */
export const MAX_CONCURRENCY = 8;

/** Default spacing between requests to the same host, in milliseconds. */
export const DEFAULT_DELAY_MS = 1_000;

/** Default per-site timeout. Generous: a slow site is still a data point. */
export const DEFAULT_SITE_TIMEOUT_MS = 45_000;

/** Options for {@link runCorpus}. */
export interface CorpusOptions {
  /** Parallel scans. Clamped to [1, {@link MAX_CONCURRENCY}]. */
  concurrency?: number;
  /** Politeness delay between requests to the same host. */
  delayMs?: number;
  /** Per-site wall-clock budget, passed to the scanner as its total timeout. */
  timeoutMs?: number;
  /** Called after each site settles, for the progress ticker. */
  onResult?: (row: CorpusRow, done: number, total: number) => void;
  /** Called once before the run starts. */
  onStart?: (total: number, concurrency: number) => void;
  /** Append each row as it completes, so a long run is resumable. */
  onRow?: (row: CorpusRow) => Promise<void> | void;
  /** Scanner overrides, merged into every scan. */
  scanner?: ScannerOptions;
  /** Injected for tests; defaults to the real scanner. */
  scanSite?: (url: string, options: ScannerOptions) => Promise<CorpusRow>;
}

/**
 * Normalises one line of an input list into a URL, or `null` to skip it.
 *
 * Accepts what people actually paste: bare hostnames, full URLs, a CSV's first
 * column, and lines commented with `#`.
 */
export function parseTarget(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  // A CSV or TSV export: take the first field.
  const first = trimmed.split(/[,\t]/)[0].trim().replace(/^["']|["']$/g, '');
  if (!first) return null;

  // A header row from a previous corpus run, not a target.
  if (/^(domain|url|host|hostname|site)$/i.test(first)) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(first) ? first : `https://${first}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Reads targets from a file, de-duplicated by URL, order preserved.
 *
 * De-duplication matters more than it looks: published site lists routinely
 * carry the same host twice with different casing or a `www.` prefix, and a
 * duplicate row skews any distribution computed from the output.
 */
export async function readTargets(input: string[]): Promise<string[]> {
  const lines: string[] = [];

  for (const entry of input) {
    // A file path if it resolves to a readable file; otherwise a literal URL.
    let contents: string | null = null;
    try {
      contents = await readFile(entry, 'utf8');
    } catch {
      contents = null;
    }
    if (contents === null) lines.push(entry);
    else lines.push(...contents.split(/\r?\n/));
  }

  const seen = new Set<string>();
  const targets: string[] = [];
  for (const line of lines) {
    const url = parseTarget(line);
    if (!url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(url);
  }
  return targets;
}

/** Scans and scores one site, converting any failure into a row. */
async function defaultScanSite(url: string, options: ScannerOptions): Promise<CorpusRow> {
  try {
    const report = await scanUrl(url, options);
    // A scan that failed at the transport still yields a report, and its
    // navigation outcome is what distinguishes a bot wall from a dead host —
    // so it is scored and classified like any other rather than discarded.
    const scorecard = scoreAudit(report.data);
    return toCorpusRow(url, report, scorecard);
  } catch (error) {
    // Only an unlaunchable browser or a scorer bug reaches here; target-level
    // problems are already inside the report. Either way this site becomes one
    // row and the batch continues.
    return toFailedRow(url, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Spaces requests per host.
 *
 * Keyed by host rather than global: two different domains have no reason to
 * wait for each other, and a global delay would make a 500-site run take hours
 * for no one's benefit. A list that is mostly one host — a corpus of a single
 * retailer's category pages, say — is exactly where the spacing is owed.
 */
class HostThrottle {
  private readonly nextFreeAt = new Map<string, number>();

  constructor(private readonly delayMs: number) {}

  async take(host: string): Promise<void> {
    if (this.delayMs <= 0) return;

    const now = Date.now();
    const earliest = this.nextFreeAt.get(host) ?? 0;
    const waitMs = Math.max(0, earliest - now);

    // Reserved before awaiting, so two workers starting together on the same
    // host queue behind each other instead of both reading the same slot.
    this.nextFreeAt.set(host, Math.max(now, earliest) + this.delayMs);

    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/**
 * Scans every target, at most `concurrency` at a time.
 *
 * Rows come back in completion order, then are sorted back into input order
 * before returning — a diff between two corpus runs is only readable if the
 * rows line up.
 */
export async function runCorpus(
  targets: string[],
  options: CorpusOptions = {},
): Promise<CorpusRow[]> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY));
  const delayMs = Math.max(0, options.delayMs ?? DEFAULT_DELAY_MS);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SITE_TIMEOUT_MS;
  const scanSite = options.scanSite ?? defaultScanSite;

  const throttle = new HostThrottle(delayMs);
  const rows = new Array<CorpusRow>(targets.length);

  options.onStart?.(targets.length, concurrency);

  let cursor = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= targets.length) return;

      const url = targets[index];
      await throttle.take(domainOf(url));

      let row: CorpusRow;
      try {
        row = await scanSite(url, {
          ...options.scanner,
          totalTimeoutMs: timeoutMs,
          // The per-site budget has to bound navigation too, or a hung target
          // sits on a worker for its own navigation timeout regardless.
          navigationTimeoutMs: Math.min(
            options.scanner?.navigationTimeoutMs ?? timeoutMs,
            timeoutMs,
          ),
        });
      } catch (error) {
        // A scanSite that throws is a bug in the injected implementation, not a
        // reason to lose the other 499 rows.
        row = toFailedRow(url, error instanceof Error ? error.message : String(error));
      }

      rows[index] = row;
      done += 1;
      // Captured, not read later: two workers finishing in the same tick would
      // otherwise both observe the final count and the ticker would print
      // "[2/2]" twice while never showing "[1/2]".
      const position = done;

      // Announced before persisting, so a slow disk does not stall the ticker.
      options.onResult?.(row, position, targets.length);

      try {
        await options.onRow?.(row);
      } catch {
        // A failed incremental write must not abort the run; the full table is
        // still returned and written at the end.
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

  return rows.filter((row): row is CorpusRow => row !== undefined);
}

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

/** Chooses a serialisation from the output path's extension. */
export function formatFor(outPath: string | null): 'csv' | 'json' {
  return outPath && /\.json$/i.test(outPath) ? 'json' : 'csv';
}

/** Writes the finished table, or returns it when there is no output path. */
export async function writeCorpus(
  rows: CorpusRow[],
  outPath: string | null,
  body: string,
): Promise<void> {
  if (!outPath) return;
  await writeFile(outPath, body, 'utf8');
}

/** Appends one CSV line, creating the file with a header on the first row. */
export async function appendCsvRow(
  outPath: string,
  line: string,
  isFirst: boolean,
  header: string,
): Promise<void> {
  await appendFile(outPath, isFirst ? `${header}\n${line}\n` : `${line}\n`, 'utf8');
}
