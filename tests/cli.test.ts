/**
 * End-to-end tests for the `agentgrade` CLI.
 *
 * The gate's whole value is its exit code, so these drive the real `main()`
 * against a real Chromium scan of the fixture server and assert on the codes a
 * CI job branches on — not on log text.
 */

import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_THRESHOLD,
  EXIT_CODES,
  FORMATS,
  formatJson,
  formatMarkdown,
  formatPretty,
  main,
  normaliseUrl,
  parseArgs,
  runAudit,
  stripAnsi,
  COMMENT_MARKER,
  type AuditRunResult,
  type CliIo,
} from '../packages/cli/src/index.js';
import { startFixtureServer, type FixtureServer } from './helpers/fixture-server.js';

let server: FixtureServer;
let browser: Browser;
/** One real audit, reused by the formatter tests so Chromium starts once. */
let sample: AuditRunResult;

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  sample = await runAudit(server.url('/'), {
    threshold: 50,
    browser: browser as never,
    syntheticGoal: 'Execute product search',
  });
}, 240_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await server?.close();
});

/** Captures everything a CLI run writes. */
function captureIo(): CliIo & { out: string[]; err: string[]; files: Map<string, string> } {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  return {
    out,
    err,
    files,
    stdout: (chunk) => out.push(chunk),
    stderr: (chunk) => err.push(chunk),
    async writeFile(path, contents) {
      files.set(path, contents);
    },
  };
}

/* -------------------------------------------------------------------------- */

describe('parseArgs', () => {
  it('defaults to a pretty audit at the documented threshold', () => {
    const args = parseArgs(['audit', 'https://example.com']);
    expect(args.error).toBeNull();
    expect(args.command).toBe('audit');
    expect(args.url).toBe('https://example.com');
    expect(args.threshold).toBe(DEFAULT_THRESHOLD);
    expect(args.format).toBe('pretty');
  });

  it('parses every documented option', () => {
    const args = parseArgs([
      'audit',
      'example.com',
      '--threshold', '65',
      '--format', 'markdown',
      '--output', 'report.md',
      '--proxy', 'http://127.0.0.1:8080',
      '--timeout', '45000',
      '--goal', 'Execute product search',
      '--header', 'Authorization: Bearer abc',
      '--header', 'X-Env: staging',
      '--max-issues', '3',
      '--no-color',
      '--quiet',
    ]);

    expect(args.error).toBeNull();
    expect(args.threshold).toBe(65);
    expect(args.format).toBe('markdown');
    expect(args.output).toBe('report.md');
    expect(args.proxy).toBe('http://127.0.0.1:8080');
    expect(args.timeoutMs).toBe(45_000);
    expect(args.syntheticGoal).toBe('Execute product search');
    expect(args.headers).toEqual({ Authorization: 'Bearer abc', 'X-Env': 'staging' });
    expect(args.maxIssues).toBe(3);
    expect(args.color).toBe(false);
    expect(args.quiet).toBe(true);
  });

  it('rejects malformed options with a message naming the flag', () => {
    for (const [argv, needle] of [
      [['audit', 'x', '--threshold', 'high'], '--threshold'],
      [['audit', 'x', '--threshold', '101'], '--threshold'],
      [['audit', 'x', '--format', 'yaml'], '--format'],
      [['audit', 'x', '--timeout', '-5'], '--timeout'],
      [['audit', 'x', '--header', 'nocolon'], '--header'],
      [['audit', 'x', '--max-issues', '1.5'], '--max-issues'],
      [['audit', 'x', '--nope'], '--nope'],
      [['audit', 'one', 'two'], 'only one URL'],
    ] as Array<[string[], string]>) {
      const args = parseArgs(argv);
      expect(args.error, argv.join(' ')).toContain(needle);
    }
  });

  it('treats a flag with no value as an error rather than swallowing the next flag', () => {
    const args = parseArgs(['audit', 'x', '--output', '--quiet']);
    expect(args.error).toContain('--output');
  });

  it('recognises help and version before anything else', () => {
    expect(parseArgs(['--help']).command).toBe('help');
    expect(parseArgs(['audit', 'x', '-v']).command).toBe('version');
  });
});

describe('normaliseUrl', () => {
  it('adds https to a bare hostname', () => {
    expect(normaliseUrl('example.com')).toBe('https://example.com/');
    expect(normaliseUrl('  example.com/path ')).toBe('https://example.com/path');
  });

  it('refuses non-http protocols and empty input', () => {
    expect(() => normaliseUrl('file:///etc/passwd')).toThrow(/http/);
    expect(() => normaliseUrl('')).toThrow(/required/);
    expect(() => normaliseUrl('http://')).toThrow(/not a valid URL/);
  });
});

/* -------------------------------------------------------------------------- */

describe('agentgrade audit — exit codes', () => {
  it('exits 0 when the score meets the threshold', async () => {
    const io = captureIo();
    const code = await main(['audit', server.url('/'), '--threshold', '50', '--quiet', '--no-color'], io);

    expect(code).toBe(EXIT_CODES.pass);
    const output = io.out.join('');
    expect(output).toContain('PASS');
    expect(output).toContain('AgentGrade');
  }, 240_000);

  it('exits 1 when the score is below the threshold', async () => {
    const io = captureIo();
    const code = await main(['audit', server.url('/'), '--threshold', '80', '--quiet', '--no-color'], io);

    expect(code).toBe(EXIT_CODES.belowThreshold);
    const output = stripAnsi(io.out.join(''));
    expect(output).toContain('FAIL');
    expect(output).toMatch(/below the threshold of 80/);
  }, 240_000);

  it('exits 2 on a usage error without launching a browser', async () => {
    for (const argv of [['audit'], ['audit', 'x', '--format', 'xml'], ['audit', 'file:///etc/passwd']]) {
      const io = captureIo();
      const code = await main(argv, io);
      expect(code, argv.join(' ')).toBe(EXIT_CODES.usage);
      expect(io.err.join('')).toContain('error');
    }
  });

  it('exits 3 when the target cannot be scanned', async () => {
    const io = captureIo();
    const code = await main(
      ['audit', 'http://127.0.0.1:1/', '--timeout', '3000', '--quiet', '--format', 'json'],
      io,
    );

    expect(code).toBe(EXIT_CODES.scanFailed);
    // A scan failure is distinguishable from a low score: a build that goes red
    // has to say whether the site regressed or the deployment was unreachable.
    expect(io.err.join('')).toContain('could not be scanned');
  }, 120_000);

  it('prints help and the version without running an audit', async () => {
    const help = captureIo();
    expect(await main(['--help'], help)).toBe(EXIT_CODES.pass);
    expect(help.out.join('')).toContain('agentgrade audit <url>');
    expect(help.out.join('')).toContain('EXIT CODES');

    const version = captureIo();
    expect(await main(['--version'], version)).toBe(EXIT_CODES.pass);
    expect(version.out.join('').trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('agentgrade audit — output', () => {
  it('writes to a file instead of stdout with --output', async () => {
    const io = captureIo();
    const code = await main(
      ['audit', server.url('/'), '--threshold', '50', '--format', 'json', '--output', 'out/report.json', '--quiet'],
      io,
    );

    expect(code).toBe(EXIT_CODES.pass);
    expect(io.out.join('')).toBe('');
    const written = io.files.get('out/report.json');
    expect(written).toBeTruthy();
    expect(JSON.parse(written!).score).toBeGreaterThan(0);
  }, 240_000);

  it('really writes the file through the default IO', async () => {
    const path = join(tmpdir(), `agentgrade-cli-${Date.now()}.md`);
    try {
      const code = await main(
        ['audit', server.url('/'), '--threshold', '50', '--format', 'markdown', '--output', path, '--quiet'],
        { stdout: () => {}, stderr: () => {} },
      );
      expect(code).toBe(EXIT_CODES.pass);
      const contents = await readFile(path, 'utf8');
      expect(contents).toContain(COMMENT_MARKER);
    } finally {
      await rm(path, { force: true });
    }
  }, 240_000);

  it('keeps progress on stderr so --format json stays pipeable', async () => {
    const io = captureIo();
    await main(['audit', server.url('/'), '--threshold', '50', '--format', 'json'], io);

    expect(() => JSON.parse(io.out.join(''))).not.toThrow();
    expect(io.err.join('')).toContain('Scanning');
  }, 240_000);

  it('never writes ANSI escapes into a file', async () => {
    const io = captureIo();
    await main(
      ['audit', server.url('/'), '--threshold', '50', '--format', 'pretty', '--output', 'report.txt', '--color', '--quiet'],
      io,
    );

    const written = io.files.get('report.txt') ?? '';
    expect(written.length).toBeGreaterThan(100);
    expect(stripAnsi(written)).toBe(written);
  }, 240_000);
});

/* -------------------------------------------------------------------------- */

describe('package entry points', () => {
  it('does not run the CLI when the library entry is imported', async () => {
    // `src/cli.ts` is a library module; only `src/bin.ts` executes. A module
    // that ran itself on import would make `import '@agentgrade/cli'` audit
    // something and set the process exit code.
    const before = process.exitCode;
    const source = await readFile(new URL('../packages/cli/src/cli.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('#!/usr/bin/env node');
    expect(source).not.toMatch(/^\s*(void )?run\(\);/m);
    expect(process.exitCode).toBe(before);

    const bin = await readFile(new URL('../packages/cli/src/bin.ts', import.meta.url), 'utf8');
    expect(bin.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(bin).toContain('void run();');
  });

  it('exposes the documented programmatic surface', () => {
    // These are what `packages/cli/dist/index.d.ts` promises consumers.
    for (const exported of [runAudit, normaliseUrl, formatJson, formatMarkdown, formatPretty, parseArgs, main]) {
      expect(typeof exported).toBe('function');
    }
    expect(EXIT_CODES).toEqual({ pass: 0, belowThreshold: 1, usage: 2, scanFailed: 3 });
    expect(COMMENT_MARKER).toBe('<!-- agentgrade-report -->');
  });
});

describe('formatters', () => {
  it('json emits a stable, flat envelope', () => {
    const payload = JSON.parse(formatJson(sample));
    expect(payload.version).toBe('1.0.0');
    expect(payload.url).toBe(sample.url);
    expect(payload.passed).toBe(true);
    expect(payload.score).toBe(sample.scorecard.overallScore);
    expect(payload.threshold).toBe(50);
    expect(payload.grade).toBe(sample.scorecard.grade);
    expect(payload.pillars).toHaveLength(4);
    expect(payload.issues.length).toBe(sample.scorecard.issues.length);
    expect(payload.frictionTax.headline).toBe(sample.scorecard.benchmark.frictionTax.headline);
    // The full scorecard and scan ride along for consumers that want them.
    expect(payload.scorecard.schemaVersion).toBe('1.0.0');
    expect(payload.report.data.scanId).toBe(sample.report.data.scanId);
  });

  it('markdown produces a PR-ready comment with a stable update marker', () => {
    const body = formatMarkdown(sample, { maxIssues: 3 });
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain('## ✅ **PASS** — AgentGrade');
    expect(body).toContain('### Agent Friction Tax');
    expect(body).toContain('| Tokens |');
    expect(body).toContain('### Pillars');
    expect(body).toContain('### Top deductions');
    expect(body).toContain('<details>');
    expect(body).toContain('```javascript');

    // Exactly three issue rows plus the two header rows.
    const tableRows = body.split('\n').filter((line) => line.startsWith('| 🔴') || line.startsWith('| 🟡') || line.startsWith('| 🔵'));
    expect(tableRows).toHaveLength(3);
  });

  it('markdown escapes pipes so a title cannot break the table', () => {
    const hostile: AuditRunResult = {
      ...sample,
      scorecard: {
        ...sample.scorecard,
        issues: [
          {
            ...sample.scorecard.issues[0],
            title: 'A | B | C',
            remediation: 'Do X | then Y',
          },
        ],
      },
    };
    const body = formatMarkdown(hostile, { includeRemediation: false });
    const row = body.split('\n').find((line) => line.includes('A \\| B'));
    expect(row).toBeTruthy();

    // Count only the delimiters — an escaped pipe is content, not a column
    // boundary. Four cells (icon, title, points, fix) means five delimiters.
    const delimiters = (row!.match(/(^|[^\\])\|/g) ?? []).length;
    expect(delimiters).toBe(5);
    expect(row).toContain('A \\| B \\| C');
    expect(row).toContain('Do X \\| then Y');
  });

  it('markdown states the failure and the shortfall when the gate fails', () => {
    const failing: AuditRunResult = { ...sample, threshold: 95, passed: false };
    const body = formatMarkdown(failing);
    expect(body).toContain('❌ **FAIL**');
    expect(body).toContain('This build is blocked');
  });

  it('pretty renders plain text with colour disabled', () => {
    const plain = formatPretty(sample, { color: false, maxIssues: 2 });
    expect(stripAnsi(plain)).toBe(plain);
    expect(plain).toContain('FRICTION TAX');
    expect(plain).toContain('PILLARS');
    expect(plain).toContain('DOM traversal');
    expect(plain).toContain('WebMCP direct');
    for (const pillar of sample.scorecard.pillars) expect(plain).toContain(pillar.label);
  });

  it('pretty emits colour when asked and strips cleanly', () => {
    const colored = formatPretty(sample, { color: true });
    expect(colored).not.toBe(stripAnsi(colored));
    expect(stripAnsi(colored)).toContain('AgentGrade');
  });

  it('offers exactly the documented formats', () => {
    expect([...FORMATS]).toEqual(['pretty', 'json', 'markdown']);
  });
});
