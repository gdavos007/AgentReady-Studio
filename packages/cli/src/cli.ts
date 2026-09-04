/**
 * `agentgrade` — the command line interface.
 *
 * Exit codes are the contract a CI job depends on, so they are explicit and
 * documented rather than incidental:
 *
 * | Code | Meaning                                                    |
 * | ---- | ---------------------------------------------------------- |
 * | 0    | Audit ran and the score met the threshold                  |
 * | 1    | Audit ran and the score is below the threshold (gate fail) |
 * | 2    | Usage error — bad flag, missing target                     |
 * | 3    | Operational failure — the target could not be scanned      |
 *
 * The 1/3 split matters: a red build should tell you whether your site got
 * worse or your staging box was down, and a single non-zero code cannot.
 */

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

import { runAudit } from './audit.js';
import { formatJson } from './formatters/json.js';
import { toCsv } from '@agentgrade/core';

import {
  DEFAULT_CONCURRENCY,
  DEFAULT_DELAY_MS,
  DEFAULT_SITE_TIMEOUT_MS,
  MAX_CONCURRENCY,
  formatFor,
  readTargets,
  runCorpus,
  type CorpusOptions,
} from './corpus.js';
import { formatMarkdown } from './formatters/markdown.js';
import { formatPretty } from './formatters/pretty.js';
import { createStyle, type Style, type StyleName } from './terminal.js';

/** Exit codes, exported so tests assert on names rather than magic numbers. */
export const EXIT_CODES = {
  pass: 0,
  belowThreshold: 1,
  usage: 2,
  scanFailed: 3,
} as const;

/** Output formats `--format` accepts. */
export const FORMATS = ['pretty', 'json', 'markdown'] as const;
export type OutputFormat = (typeof FORMATS)[number];

/** Default minimum score. */
export const DEFAULT_THRESHOLD = 80;

/** Parsed command line. */
export interface ParsedArgs {
  command: 'audit' | 'scan-corpus' | 'help' | 'version';
  url: string | null;
  /** Positional targets for `scan-corpus`: file paths, URLs, or a mix. */
  corpusTargets: string[];
  /** Parallel scans for `scan-corpus`. */
  concurrency: number | null;
  /** Politeness delay between requests to one host, in ms. */
  delayMs: number | null;
  /** Output path for `scan-corpus`; extension selects CSV or JSON. */
  out: string | null;
  threshold: number;
  format: OutputFormat;
  output: string | null;
  proxy: string | null;
  timeoutMs: number | null;
  syntheticGoal: string | null;
  headers: Record<string, string>;
  allowPrivate: boolean;
  noSandbox: boolean;
  bypassCsp: boolean;
  ignoreHttpsErrors: boolean;
  respectRobots: boolean;
  quiet: boolean;
  maxIssues: number | null;
  color: boolean | null;
  /** Set when parsing failed; the message is printed and exit is `usage`. */
  error: string | null;
}

const USAGE = `
agentgrade — audit a site for WebMCP and AI-agent readiness

USAGE
  agentgrade audit <url> [options]
  agentgrade scan-corpus <file|url...> [options]

OPTIONS
  --threshold <number>   Minimum score to pass. Default ${DEFAULT_THRESHOLD}.
                         Exit 0 at or above it, exit 1 below it.
  --format <format>      pretty | json | markdown. Default pretty.
  --output <path>        Write the report to a file instead of stdout.
  --proxy <url>          Egress proxy for navigation and descriptor fetches.
  --timeout <ms>         Navigation timeout. Default 30000.
  --goal <text>          Goal for the synthetic agent evaluation.
  --header <k:v>         Extra request header. Repeatable.
  --allow-private        Permit private, loopback and link-local targets.
                         Off by default so a CI job handed a URL cannot pivot
                         into the runner's network. Also AGENTGRADE_ALLOW_PRIVATE_TARGETS=1.
  --no-sandbox           Launch Chromium without its sandbox. Only for
                         unprivileged containers. Also AGENTGRADE_NO_SANDBOX=1.
  --bypass-csp           Disable the target's Content-Security-Policy.
                         Weakens a real boundary; the report records a warning.
  --ignore-https-errors  Accept invalid or self-signed TLS certificates.
                         The report records that the host was not verified.
  --max-issues <number>  How many issues to show. Default 8 (pretty) / 10 (markdown).
  --no-color             Disable ANSI colour. NO_COLOR is also honoured.
  --quiet                Suppress progress output on stderr.
  -h, --help             Show this help.
  -v, --version          Show the version.

SCAN-CORPUS OPTIONS
  --concurrency <n>      Parallel scans, 1-${MAX_CONCURRENCY}. Default ${DEFAULT_CONCURRENCY} — each one is a
                         browser, so this is a memory budget, not a speed dial.
  --delay <ms>           Politeness delay between requests to the same host.
                         Default ${DEFAULT_DELAY_MS}. Different hosts never wait on each other.
  --timeout <ms>         Per-site budget. Default ${DEFAULT_SITE_TIMEOUT_MS}.
  --out <path>           Write to a file. A .json extension emits JSON, anything
                         else CSV. Omit to write CSV to stdout.
  --respect-robots       Check /robots.txt before launching a browser and skip
                         a target that disallows it, as robots-disallowed. Off
                         by default so local fixtures and your own staging box
                         audit unblocked. Accepted on audit too.

EXIT CODES
  0  score met the threshold
  1  score below the threshold
  2  usage error
  3  the target could not be scanned

EXAMPLES
  agentgrade audit https://example.com
  agentgrade scan-corpus sites.txt --out corpus.csv
  agentgrade scan-corpus a.com b.com --concurrency 4 --delay 2000
  agentgrade scan-corpus sites.txt > corpus.csv   # progress stays on stderr
  agentgrade audit staging.example.com --threshold 70
  agentgrade audit https://example.com --format json | jq .score
  agentgrade audit https://example.com --format markdown --output comment.md
  agentgrade audit http://localhost:3000 --allow-private
`;

/** Parses argv. Never throws; a problem lands in {@link ParsedArgs.error}. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: 'audit',
    url: null,
    corpusTargets: [],
    concurrency: null,
    delayMs: null,
    out: null,
    threshold: DEFAULT_THRESHOLD,
    format: 'pretty',
    output: null,
    proxy: null,
    timeoutMs: null,
    syntheticGoal: null,
    headers: {},
    allowPrivate: false,
    noSandbox: false,
    bypassCsp: false,
    ignoreHttpsErrors: false,
    respectRobots: false,
    quiet: false,
    maxIssues: null,
    color: null,
    error: null,
  };

  const fail = (message: string): ParsedArgs => ({ ...parsed, error: message });

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    /** Reads the next argv entry, failing when the flag has no value. */
    const value = (): string | null => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) return null;
      index++;
      return next;
    };

    switch (argument) {
      case 'audit':
        parsed.command = 'audit';
        break;
      case 'scan-corpus':
        parsed.command = 'scan-corpus';
        break;
      case '-h':
      case '--help':
        return { ...parsed, command: 'help' };
      case '-v':
      case '--version':
        return { ...parsed, command: 'version' };
      case '--threshold': {
        const raw = value();
        const numeric = Number(raw);
        if (raw === null || !Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
          return fail(`--threshold expects a number between 0 and 100 (got ${JSON.stringify(raw)}).`);
        }
        parsed.threshold = numeric;
        break;
      }
      case '--format': {
        const raw = value();
        if (raw === null || !(FORMATS as readonly string[]).includes(raw)) {
          return fail(`--format expects one of ${FORMATS.join(', ')} (got ${JSON.stringify(raw)}).`);
        }
        parsed.format = raw as OutputFormat;
        break;
      }
      case '--output': {
        const raw = value();
        if (raw === null) return fail('--output expects a file path.');
        parsed.output = raw;
        break;
      }
      case '--proxy': {
        const raw = value();
        if (raw === null) return fail('--proxy expects a URL, e.g. http://127.0.0.1:8080.');
        parsed.proxy = raw;
        break;
      }
      case '--timeout': {
        const raw = value();
        const numeric = Number(raw);
        if (raw === null || !Number.isFinite(numeric) || numeric <= 0) {
          return fail(`--timeout expects a positive number of milliseconds (got ${JSON.stringify(raw)}).`);
        }
        parsed.timeoutMs = numeric;
        break;
      }
      case '--goal': {
        const raw = value();
        if (raw === null) return fail('--goal expects a description of the task to attempt.');
        parsed.syntheticGoal = raw;
        break;
      }
      case '--header': {
        const raw = value();
        if (raw === null) return fail('--header expects "Name: value".');
        const separator = raw.indexOf(':');
        if (separator <= 0) return fail(`--header expects "Name: value" (got ${JSON.stringify(raw)}).`);
        parsed.headers[raw.slice(0, separator).trim()] = raw.slice(separator + 1).trim();
        break;
      }
      case '--max-issues': {
        const raw = value();
        const numeric = Number(raw);
        if (raw === null || !Number.isInteger(numeric) || numeric < 0) {
          return fail(`--max-issues expects a non-negative integer (got ${JSON.stringify(raw)}).`);
        }
        parsed.maxIssues = numeric;
        break;
      }
      case '--allow-private':
        parsed.allowPrivate = true;
        break;
      case '--no-sandbox':
        parsed.noSandbox = true;
        break;
      case '--bypass-csp':
        parsed.bypassCsp = true;
        break;
      case '--ignore-https-errors':
        parsed.ignoreHttpsErrors = true;
        break;
      case '--respect-robots':
        parsed.respectRobots = true;
        break;
      case '--no-color':
        parsed.color = false;
        break;
      case '--color':
        parsed.color = true;
        break;
      case '--quiet':
        parsed.quiet = true;
        break;
      case '--concurrency': {
        const raw = value();
        const numeric = Number(raw);
        if (raw === null || !Number.isInteger(numeric) || numeric < 1 || numeric > MAX_CONCURRENCY) {
          return fail(
            `--concurrency expects an integer between 1 and ${MAX_CONCURRENCY} (got ${JSON.stringify(raw)}).`,
          );
        }
        parsed.concurrency = numeric;
        break;
      }
      case '--delay': {
        const raw = value();
        const numeric = Number(raw);
        if (raw === null || !Number.isFinite(numeric) || numeric < 0) {
          return fail(`--delay expects a non-negative number of milliseconds (got ${JSON.stringify(raw)}).`);
        }
        parsed.delayMs = numeric;
        break;
      }
      case '--out': {
        const raw = value();
        if (raw === null) return fail('--out expects a file path.');
        parsed.out = raw;
        break;
      }
      default:
        if (argument.startsWith('-')) return fail(`Unknown option "${argument}".`);
        if (parsed.command === 'scan-corpus') {
          // A corpus takes any number of positionals: file paths, URLs, or a
          // mix. They are resolved to targets later, where a file can be read.
          parsed.corpusTargets.push(argument);
        } else if (!parsed.url) {
          parsed.url = argument;
        } else {
          return fail(`Unexpected argument "${argument}" — only one URL may be audited at a time.`);
        }
        break;
    }
  }

  return parsed;
}

/** Everything `main` writes to, injected so tests can capture it. */
export interface CliIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  writeFile?: (path: string, contents: string) => Promise<void>;
}

const defaultIo: CliIo = {
  stdout: (chunk) => process.stdout.write(chunk),
  stderr: (chunk) => process.stderr.write(chunk),
  async writeFile(path, contents) {
    const absolute = resolve(path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, 'utf8');
  },
};

/** The package version, injected at build time. */
declare const __AGENTGRADE_VERSION__: string;
const VERSION = typeof __AGENTGRADE_VERSION__ === 'string' ? __AGENTGRADE_VERSION__ : '0.0.0-dev';

/**
 * Runs the CLI and returns the process exit code.
 *
 * Returns rather than exits so it can be driven from a test or another Node
 * program without taking the host process down with it.
 */
export async function main(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const args = parseArgs(argv);
  const style = createStyle(args.color ?? undefined);

  if (args.error) {
    io.stderr(`${style('error', 'brightRed', 'bold')} ${args.error}\n`);
    io.stderr(`Run ${style('agentgrade --help', 'cyan')} for usage.\n`);
    return EXIT_CODES.usage;
  }

  if (args.command === 'help') {
    io.stdout(`${USAGE.trimStart()}`);
    return EXIT_CODES.pass;
  }

  if (args.command === 'version') {
    io.stdout(`${VERSION}\n`);
    return EXIT_CODES.pass;
  }

  if (args.command === 'scan-corpus') {
    return runCorpusCommand(args, io, style);
  }

  if (!args.url) {
    io.stderr(`${style('error', 'brightRed', 'bold')} A target URL is required.\n`);
    io.stderr(`Run ${style('agentgrade --help', 'cyan')} for usage.\n`);
    return EXIT_CODES.usage;
  }

  // Progress goes to stderr so `--format json` stays pipeable.
  const onProgress = args.quiet ? undefined : (message: string) => io.stderr(`${style('·', 'dim')} ${message}\n`);

  let result;
  try {
    result = await runAudit(args.url, {
      threshold: args.threshold,
      timeoutMs: args.timeoutMs ?? undefined,
      proxy: args.proxy ?? undefined,
      syntheticGoal: args.syntheticGoal ?? undefined,
      headers: Object.keys(args.headers).length > 0 ? args.headers : undefined,
      ...(args.allowPrivate ? { allowPrivateTargets: true } : {}),
      ...(args.noSandbox ? { disableSandbox: true } : {}),
      ...(args.bypassCsp ? { bypassCsp: true } : {}),
      ...(args.ignoreHttpsErrors ? { ignoreHttpsErrors: true } : {}),
      ...(args.respectRobots ? { respectRobots: true } : {}),
      onProgress,
    });
  } catch (error) {
    io.stderr(
      `${style('error', 'brightRed', 'bold')} ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return isUsageError(error) ? EXIT_CODES.usage : EXIT_CODES.scanFailed;
  }

  const rendered = render(result, args);

  if (args.output) {
    try {
      await (io.writeFile ?? defaultIo.writeFile!)(args.output, rendered);
      if (!args.quiet) io.stderr(`${style('·', 'dim')} wrote ${args.output}\n`);
    } catch (error) {
      io.stderr(
        `${style('error', 'brightRed', 'bold')} could not write ${args.output}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return EXIT_CODES.scanFailed;
    }
  } else {
    io.stdout(rendered);
  }

  // A target that never loaded is an operational failure, not a low score —
  // reporting it as "below threshold" would send someone to fix a site that
  // was never measured.
  if (result.report.status === 'failed') {
    io.stderr(
      `${style('error', 'brightRed', 'bold')} the target could not be scanned: ${
        result.report.data.navigation.error ?? result.report.data.navigation.status
      }\n`,
    );
    return EXIT_CODES.scanFailed;
  }

  return result.passed ? EXIT_CODES.pass : EXIT_CODES.belowThreshold;
}

function render(result: Awaited<ReturnType<typeof runAudit>>, args: ParsedArgs): string {
  switch (args.format) {
    case 'json':
      return formatJson(result);
    case 'markdown':
      return formatMarkdown(result, { maxIssues: args.maxIssues ?? undefined });
    case 'pretty':
    default:
      return formatPretty(result, {
        maxIssues: args.maxIssues ?? undefined,
        // A file written with `--output` should never contain escape codes.
        color: args.output ? false : (args.color ?? undefined),
      });
  }
}

/** A malformed target is the user's mistake, not the target's. */
function isUsageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /is not a valid URL|Only http and https|A target URL is required/.test(message);
}

/* -------------------------------------------------------------------------- */
/* scan-corpus                                                                 */
/* -------------------------------------------------------------------------- */

/** How a row's status is coloured in the ticker. */
const STATUS_STYLE: Record<string, StyleName> = {
  ok: 'brightGreen',
  partial: 'brightYellow',
  'bot-blocked': 'magenta',
  'robots-disallowed': 'blue',
  unreachable: 'brightRed',
};

/**
 * Runs a corpus scan.
 *
 * Exit codes differ from `audit` on purpose: a corpus has no threshold to
 * clear, so `pass` means "the batch ran", not "the sites were good". A site
 * that refused is a row, not a failure — only an unusable invocation or an
 * unwritable output file is an error.
 */
async function runCorpusCommand(args: ParsedArgs, io: CliIo, style: Style): Promise<number> {
  if (args.corpusTargets.length === 0) {
    io.stderr(`${style('error', 'brightRed', 'bold')} scan-corpus needs a file of targets, or one or more URLs.\n`);
    io.stderr(`Run ${style('agentgrade --help', 'cyan')} for usage.\n`);
    return EXIT_CODES.usage;
  }

  let targets: string[];
  try {
    targets = await readTargets(args.corpusTargets);
  } catch (error) {
    io.stderr(
      `${style('error', 'brightRed', 'bold')} could not read the target list: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return EXIT_CODES.usage;
  }

  if (targets.length === 0) {
    io.stderr(`${style('error', 'brightRed', 'bold')} no usable targets were found in the input.\n`);
    return EXIT_CODES.usage;
  }

  const counts: Record<string, number> = {
    ok: 0,
    partial: 0,
    'bot-blocked': 0,
    'robots-disallowed': 0,
    unreachable: 0,
  };
  const startedAt = Date.now();

  const options: CorpusOptions = {
    concurrency: args.concurrency ?? undefined,
    delayMs: args.delayMs ?? undefined,
    timeoutMs: args.timeoutMs ?? undefined,
    scanner: {
      ...(args.proxy ? { proxy: { server: args.proxy } } : {}),
      ...(Object.keys(args.headers).length > 0 ? { extraHttpHeaders: args.headers } : {}),
      ...(args.allowPrivate ? { allowPrivateTargets: true } : {}),
      ...(args.noSandbox ? { disableSandbox: true } : {}),
      ...(args.bypassCsp ? { bypassCsp: true } : {}),
      ...(args.ignoreHttpsErrors ? { ignoreHttpsErrors: true } : {}),
      ...(args.respectRobots ? { respectRobots: true } : {}),
    },
  };

  if (!args.quiet) {
    options.onStart = (total, concurrency) => {
      io.stderr(
        `${style('scanning', 'cyan', 'bold')} ${total} site(s), ${concurrency} at a time\n`,
      );
    };
    options.onResult = (row, done, total) => {
      counts[row.status] = (counts[row.status] ?? 0) + 1;

      const width = String(total).length;
      const position = style(`[${String(done).padStart(width)}/${total}]`, 'dim');
      const status = style(row.status.padEnd(12), STATUS_STYLE[row.status] ?? 'white');
      const score = row.overall_score === null ? '  —' : String(row.overall_score).padStart(3);
      const grade = row.letter_grade ?? '-';
      const detail = row.error ? style(` ${row.error.slice(0, 60)}`, 'dim') : '';

      io.stderr(`${position} ${status} ${score} ${grade}  ${row.domain}${detail}\n`);
    };
  }

  const rows = await runCorpus(targets, options);

  const body =
    formatFor(args.out) === 'json'
      ? `${JSON.stringify(rows, null, 2)}\n`
      : toCsv(rows);

  if (args.out) {
    try {
      await (io.writeFile ?? defaultIo.writeFile!)(args.out, body);
    } catch (error) {
      io.stderr(
        `${style('error', 'brightRed', 'bold')} could not write ${args.out}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return EXIT_CODES.scanFailed;
    }
  } else {
    io.stdout(body);
  }

  if (!args.quiet) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const summary = Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${count} ${status}`)
      .join(', ');
    io.stderr(`${style('done', 'brightGreen', 'bold')} ${rows.length} row(s) in ${elapsed}s — ${summary}\n`);
    if (args.out) io.stderr(`${style('wrote', 'cyan')} ${args.out}\n`);
  }

  return EXIT_CODES.pass;
}

/**
 * Entry point for the binary. Sets `process.exitCode` rather than calling
 * `process.exit`, so buffered stdout is flushed before the process ends.
 *
 * Nothing here runs on import: `src/bin.ts` is the only caller, and it is the
 * only file the `bin` entry points at.
 */
export async function run(): Promise<void> {
  process.exitCode = await main(process.argv.slice(2));
}
