/**
 * Corpus scanning tests.
 *
 * The unit under test is a batch, so the properties that matter are the ones
 * that only show up at scale: one refusal must not cost the other 499 rows,
 * concurrency must actually be bounded, one host must not be hammered, and the
 * CSV must survive a page title with a comma in it.
 *
 * The scanner is injected throughout. A real corpus run means hundreds of
 * browser launches, and the batching logic is what is being tested, not
 * Chromium.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CORPUS_COLUMNS,
  classifyScan,
  csvField,
  domainOf,
  toCorpusRow,
  toCsv,
  toFailedRow,
  type AuditReport,
  type CorpusRow,
} from '../src/index.js';
import { main } from '../packages/cli/src/cli.js';
import {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  formatFor,
  parseTarget,
  readTargets,
  runCorpus,
} from '../packages/cli/src/corpus.js';

/* -------------------------------------------------------------------------- */
/* Target parsing                                                              */
/* -------------------------------------------------------------------------- */

describe('parseTarget', () => {
  it('accepts the shapes people actually paste', () => {
    expect(parseTarget('example.com')).toBe('https://example.com/');
    expect(parseTarget('https://example.com/path')).toBe('https://example.com/path');
    expect(parseTarget('http://example.com')).toBe('http://example.com/');
    expect(parseTarget('  example.com  ')).toBe('https://example.com/');
  });

  it('takes the first column of a CSV or TSV line', () => {
    expect(parseTarget('example.com,1234,retail')).toBe('https://example.com/');
    expect(parseTarget('example.com\t1234')).toBe('https://example.com/');
    expect(parseTarget('"example.com",1234')).toBe('https://example.com/');
  });

  it('skips comments, blanks, and a header row from a previous run', () => {
    expect(parseTarget('')).toBeNull();
    expect(parseTarget('   ')).toBeNull();
    expect(parseTarget('# a comment')).toBeNull();
    expect(parseTarget('domain,url,status')).toBeNull();
    expect(parseTarget('url')).toBeNull();
  });

  it('refuses non-http schemes so a list cannot smuggle in a file read', () => {
    expect(parseTarget('file:///etc/passwd')).toBeNull();
    expect(parseTarget('javascript:alert(1)')).toBeNull();
    expect(parseTarget('data:text/html,hi')).toBeNull();
  });
});

describe('readTargets', () => {
  it('reads a file, and treats a non-file argument as a literal URL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentgrade-corpus-'));
    const list = join(dir, 'sites.txt');
    await writeFile(list, '# top sites\nalpha.test\nbeta.test\n\n', 'utf8');

    expect(await readTargets([list])).toEqual(['https://alpha.test/', 'https://beta.test/']);
    expect(await readTargets(['gamma.test'])).toEqual(['https://gamma.test/']);
    expect(await readTargets([list, 'gamma.test'])).toEqual([
      'https://alpha.test/',
      'https://beta.test/',
      'https://gamma.test/',
    ]);
  });

  it('de-duplicates, because published lists repeat hosts', async () => {
    // A duplicate row silently skews any distribution computed from the output.
    const targets = await readTargets([
      'alpha.test',
      'https://alpha.test/',
      'ALPHA.test',
      'beta.test',
    ]);
    expect(targets).toEqual(['https://alpha.test/', 'https://beta.test/']);
  });
});

/* -------------------------------------------------------------------------- */
/* Row shape                                                                   */
/* -------------------------------------------------------------------------- */

/** A scan report with just the fields the row extractor reads. */
function fakeReport(overrides: Partial<Record<string, unknown>> = {}): AuditReport {
  const nav = {
    status: 'loaded',
    requestedUrl: 'https://shop.test/',
    finalUrl: 'https://shop.test/',
    httpStatus: 200,
    title: 'Shop',
    durationMs: 900,
    redirectCount: 0,
    botWallDetected: false,
    botWallSignals: [],
    error: null,
    ...(overrides.navigation as object | undefined),
  };

  return {
    status: (overrides.status as AuditReport['status']) ?? 'ok',
    generatedAt: '2026-09-04T12:00:00.000Z',
    durationMs: 4200,
    data: {
      schemaVersion: 1,
      scanId: 'scan-1',
      target: { requestedUrl: 'https://shop.test/', origin: 'https://shop.test' },
      navigation: nav,
      page: { domNodeCount: 2606, iframeCount: 3, landmarkCount: 4 },
      runtime: {},
      declarative: {
        descriptors: [
          { kind: 'well-known-mcp', found: false },
          { kind: 'well-known-agent', found: true },
          { kind: 'llms-txt', found: true },
        ],
        tags: [],
        tools: [],
        manifestLinks: [],
      },
      tools: [],
      forms: [],
      controls: [],
      frictionTraps: [],
      summary: {
        totalTools: 2,
        frictionTrapCount: 6,
        trapsByType: { 'unlabelled-input': 4, 'non-semantic-control': 5 },
        hasLlmsTxt: true,
      },
      diagnostics: [],
    },
  } as unknown as AuditReport;
}

/** A scorecard with just the fields the row extractor reads. */
function fakeScorecard(): Parameters<typeof toCorpusRow>[2] {
  return {
    overallScore: 18,
    grade: 'F',
    pillars: [
      { pillar: 'discovery', rawScore: 13.35 },
      { pillar: 'actionability', rawScore: 0 },
      { pillar: 'friction', rawScore: 62 },
      { pillar: 'safety', rawScore: 0 },
    ],
    benchmark: {
      domTraversal: { totalTokens: 661_800, costUsd: 3.3512 },
      webMcpDirect: { totalTokens: 650, costUsd: 0.004912 },
      frictionTax: { costWastedUsd: 3.34629, latencyWastedMs: 64_400 },
    },
  } as unknown as Parameters<typeof toCorpusRow>[2];
}

describe('toCorpusRow', () => {
  it('maps every requested column off the real data model', () => {
    const row = toCorpusRow('https://shop.test/', fakeReport(), fakeScorecard());

    expect(row.domain).toBe('shop.test');
    expect(row.url).toBe('https://shop.test/');
    expect(row.status).toBe('ok');

    expect(row.overall_score).toBe(18);
    expect(row.letter_grade).toBe('F');

    expect(row.discovery).toBe(13.4);
    expect(row.actionability).toBe(0);
    expect(row.friction_penalties).toBe(62);
    expect(row.safety).toBe(0);

    expect(row.dom_nodes).toBe(2606);
    expect(row.unlabelled_inputs).toBe(4);
    expect(row.non_semantic_clickables).toBe(5);
    expect(row.iframes_count).toBe(3);
    expect(row.friction_traps_count).toBe(6);

    expect(row.has_llms_txt).toBe(true);
    // Reported per descriptor kind, not as one combined "well-known" flag.
    expect(row.has_agent_json).toBe(true);
    expect(row.has_mcp_manifest).toBe(false);
    expect(row.tools_count).toBe(2);

    expect(row.dom_tokens).toBe(661_800);
    expect(row.dom_cost_usd).toBe(3.3512);
    expect(row.webmcp_tokens).toBe(650);
    expect(row.webmcp_cost_usd).toBe(0.0049);
    expect(row.friction_tax_usd).toBe(3.3463);
    expect(row.latency_delta_sec).toBe(64.4);

    expect(row.error).toBeNull();
  });

  it('strips www so rows group by site', () => {
    expect(domainOf('https://www.example.com/x')).toBe('example.com');
    expect(domainOf('not a url')).toBe('not a url');
  });

  it('reports zero — not null — for traps a site simply does not have', () => {
    const report = fakeReport();
    (report.data.summary as unknown as { trapsByType: object }).trapsByType = {};
    const row = toCorpusRow('https://shop.test/', report, fakeScorecard());

    // The distinction matters in a corpus: null means "not measured", 0 means
    // "measured, none found", and averaging them together is a different number.
    expect(row.unlabelled_inputs).toBe(0);
    expect(row.non_semantic_clickables).toBe(0);
  });
});

describe('classifyScan', () => {
  it('separates a bot wall from an unreachable host', () => {
    // Both come back empty, but one is a site that refused this client and the
    // other is a row to drop from the sample.
    const blocked = fakeReport({ status: 'partial', navigation: { botWallDetected: true } });
    expect(classifyScan(blocked)).toBe('bot-blocked');

    const dead = fakeReport({ status: 'failed', navigation: { status: 'network-error' } });
    expect(classifyScan(dead)).toBe('unreachable');
  });

  it('calls a bot wall blocked even when the report only says partial', () => {
    // A wall usually degrades a stage too, so without the ordering this would
    // pool with ordinary timeouts and hide a systematic bias.
    const report = fakeReport({ status: 'partial', navigation: { botWallDetected: true } });
    expect(classifyScan(report)).toBe('bot-blocked');
  });

  it('passes ok and partial through', () => {
    expect(classifyScan(fakeReport())).toBe('ok');
    expect(classifyScan(fakeReport({ status: 'partial' }))).toBe('partial');
  });

  it('blanks the score of a host that was never reached', () => {
    // The scorer happily returns a number for a page that never loaded — and
    // rates it 100 on friction, because an empty document has no traps. Left in
    // the table, unreachable hosts would rank among the best sites in the
    // corpus and drag every mean with them.
    const dead = fakeReport({ status: 'failed', navigation: { status: 'network-error', error: 'ENOTFOUND' } });
    const row = toCorpusRow('https://dead.test/', dead, fakeScorecard());

    expect(row.status).toBe('unreachable');
    expect(row.overall_score).toBeNull();
    expect(row.letter_grade).toBeNull();
    expect(row.friction_penalties).toBeNull();
    expect(row.dom_nodes).toBeNull();
    expect(row.friction_tax_usd).toBeNull();
    expect(row.tools_count).toBeNull();
    // The row still exists, and says why.
    expect(row.error).toContain('ENOTFOUND');
  });

  it('keeps a bot wall’s structure but not its verdict', () => {
    // The wall is a real document, so its shape is a real observation. Its
    // score is not — it would read as a verdict on a site never seen.
    const walled = fakeReport({ status: 'partial', navigation: { botWallDetected: true } });
    const row = toCorpusRow('https://walled.test/', walled, fakeScorecard());

    expect(row.status).toBe('bot-blocked');
    expect(row.overall_score).toBeNull();
    expect(row.friction_tax_usd).toBeNull();
    expect(row.dom_nodes).toBe(2606);
    expect(row.iframes_count).toBe(3);
  });

  it('leaves a partial scan fully populated', () => {
    // A degraded stage is still a measurement of the real site.
    const row = toCorpusRow('https://shop.test/', fakeReport({ status: 'partial' }), fakeScorecard());
    expect(row.status).toBe('partial');
    expect(row.overall_score).toBe(18);
    expect(row.dom_nodes).toBe(2606);
    expect(row.error).toBeNull();
  });

  it('treats a guard-blocked target as unreachable', () => {
    const report = fakeReport({ status: 'failed', navigation: { status: 'blocked' } });
    expect(classifyScan(report)).toBe('unreachable');
  });
});

describe('toFailedRow', () => {
  it('emits a full-width row so the sample is not silently thinned', () => {
    const row = toFailedRow('https://dead.test/', 'getaddrinfo ENOTFOUND dead.test\nstack line');

    expect(row.domain).toBe('dead.test');
    expect(row.status).toBe('unreachable');
    expect(row.error).toBe('getaddrinfo ENOTFOUND dead.test');
    expect(row.overall_score).toBeNull();

    // Every column present, so it lines up under the header.
    for (const column of CORPUS_COLUMNS) expect(column in row).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* CSV                                                                         */
/* -------------------------------------------------------------------------- */

describe('CSV serialisation', () => {
  it('quotes fields that would otherwise shift every later column', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    expect(csvField(null)).toBe('');
    expect(csvField(true)).toBe('true');
    expect(csvField(0)).toBe('0');
  });

  it('defuses a spreadsheet formula in target-controlled text', () => {
    // The URL and the error message both come from the target, and Excel runs
    // a cell that starts with one of these on open.
    expect(csvField('=1+1')).toBe("'=1+1");
    expect(csvField('+HYPERLINK("http://evil.test")')).toBe('"\'+HYPERLINK(""http://evil.test"")"');
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvField('-2+3')).toBe("'-2+3");
  });

  it('round-trips a table whose header matches its rows', () => {
    const csv = toCsv([toCorpusRow('https://shop.test/', fakeReport(), fakeScorecard())]);
    const [header, first] = csv.trimEnd().split('\n');

    expect(header).toBe(CORPUS_COLUMNS.join(','));
    expect(first.split(',').length).toBeGreaterThanOrEqual(CORPUS_COLUMNS.length);
    expect(csv.endsWith('\n')).toBe(true);
  });

  it('picks the format from the output extension', () => {
    expect(formatFor('out.json')).toBe('json');
    expect(formatFor('out.csv')).toBe('csv');
    expect(formatFor('out.txt')).toBe('csv');
    expect(formatFor(null)).toBe('csv');
  });
});

/* -------------------------------------------------------------------------- */
/* Batch behaviour                                                             */
/* -------------------------------------------------------------------------- */

/** A stub scanner that records call order and can be told to misbehave. */
function stubScanner(behaviour: (url: string) => Promise<CorpusRow> | CorpusRow) {
  const started: string[] = [];
  let concurrent = 0;
  let peak = 0;

  return {
    started,
    peak: () => peak,
    scanSite: async (url: string): Promise<CorpusRow> => {
      started.push(url);
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      try {
        return await behaviour(url);
      } finally {
        concurrent -= 1;
      }
    },
  };
}

const okRow = (url: string): CorpusRow => ({
  ...toFailedRow(url, 'placeholder'),
  status: 'ok',
  overall_score: 42,
  error: null,
});

describe('runCorpus', () => {
  it('returns one row per target, in input order', async () => {
    const targets = ['https://a.test/', 'https://b.test/', 'https://c.test/'];
    const stub = stubScanner(async (url) => {
      // Finish out of order to prove the rows are re-sorted, not appended.
      await new Promise((resolve) => setTimeout(resolve, url.includes('a') ? 30 : 1));
      return okRow(url);
    });

    const rows = await runCorpus(targets, { delayMs: 0, scanSite: stub.scanSite });

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.domain)).toEqual(['a.test', 'b.test', 'c.test']);
  });

  it('keeps going when one site throws, and records it as a row', async () => {
    // The property that makes a 500-site run viable: a crash on #2 costs one
    // row, not the batch.
    const targets = ['https://a.test/', 'https://boom.test/', 'https://c.test/'];
    const stub = stubScanner(async (url) => {
      if (url.includes('boom')) throw new Error('ECONNRESET while navigating');
      return okRow(url);
    });

    const rows = await runCorpus(targets, { delayMs: 0, scanSite: stub.scanSite });

    expect(rows).toHaveLength(3);
    const failed = rows.find((row) => row.domain === 'boom.test');
    expect(failed?.status).toBe('unreachable');
    expect(failed?.error).toContain('ECONNRESET');
    // The sites after the failure still ran.
    expect(rows.filter((row) => row.status === 'ok')).toHaveLength(2);
  });

  it('never exceeds the requested concurrency', async () => {
    const targets = Array.from({ length: 12 }, (_, index) => `https://s${index}.test/`);
    const stub = stubScanner(async (url) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return okRow(url);
    });

    await runCorpus(targets, { concurrency: 3, delayMs: 0, scanSite: stub.scanSite });

    expect(stub.peak()).toBeLessThanOrEqual(3);
    expect(stub.started).toHaveLength(12);
  });

  it('clamps concurrency rather than trusting the number it is handed', async () => {
    const targets = Array.from({ length: 20 }, (_, index) => `https://s${index}.test/`);
    const stub = stubScanner(async (url) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return okRow(url);
    });

    await runCorpus(targets, { concurrency: 999, delayMs: 0, scanSite: stub.scanSite });
    expect(stub.peak()).toBeLessThanOrEqual(MAX_CONCURRENCY);
  });

  it('spaces requests to one host but does not make other hosts wait', async () => {
    const sameHost = Array.from({ length: 3 }, (_, index) => `https://one.test/page${index}`);
    const stub = stubScanner(() => okRow('https://one.test/'));

    const startedAt = Date.now();
    await runCorpus(sameHost, { concurrency: 3, delayMs: 40, scanSite: stub.scanSite });
    const sameHostMs = Date.now() - startedAt;

    // Three requests to one host, spaced: at least two gaps.
    expect(sameHostMs).toBeGreaterThanOrEqual(70);

    const otherHosts = ['https://a.test/', 'https://b.test/', 'https://c.test/'];
    const stub2 = stubScanner(() => okRow('https://x.test/'));
    const secondStart = Date.now();
    await runCorpus(otherHosts, { concurrency: 3, delayMs: 40, scanSite: stub2.scanSite });

    // Distinct hosts have no reason to queue behind each other.
    expect(Date.now() - secondStart).toBeLessThan(sameHostMs);
  });

  it('reports progress per site and totals up front', async () => {
    const seen: Array<[string, number, number]> = [];
    let announced: [number, number] | null = null;

    await runCorpus(['https://a.test/', 'https://b.test/'], {
      delayMs: 0,
      scanSite: async (url) => okRow(url),
      onStart: (total, concurrency) => {
        announced = [total, concurrency];
      },
      onResult: (row, done, total) => seen.push([row.domain, done, total]),
    });

    expect(announced).toEqual([2, DEFAULT_CONCURRENCY]);
    expect(seen).toHaveLength(2);
    expect(seen.map(([, done]) => done)).toEqual([1, 2]);
  });

  it('survives an onRow sink that throws', async () => {
    // Incremental writes are a convenience; losing the disk must not lose the
    // scan that has already been paid for.
    const rows = await runCorpus(['https://a.test/', 'https://b.test/'], {
      delayMs: 0,
      scanSite: async (url) => okRow(url),
      onRow: () => {
        throw new Error('disk full');
      },
    });

    expect(rows).toHaveLength(2);
  });

  it('handles an empty target list without launching anything', async () => {
    const stub = stubScanner(() => okRow('https://a.test/'));
    expect(await runCorpus([], { scanSite: stub.scanSite })).toEqual([]);
    expect(stub.started).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* CLI wiring                                                                  */
/* -------------------------------------------------------------------------- */

/** Captures the two streams separately — the whole point of the ticker. */
function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  const written = new Map<string, string>();
  return {
    out,
    err,
    written,
    io: {
      stdout: (chunk: string) => out.push(chunk),
      stderr: (chunk: string) => err.push(chunk),
      writeFile: async (path: string, contents: string) => {
        written.set(path, contents);
      },
    },
  };
}

describe('agentgrade scan-corpus', () => {
  it('rejects an invocation with no targets', async () => {
    const { io, err } = captureIo();
    expect(await main(['scan-corpus'], io)).toBe(2);
    expect(err.join('')).toMatch(/needs a file of targets/i);
  });

  it('rejects a list with nothing usable in it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentgrade-corpus-'));
    const list = join(dir, 'empty.txt');
    await writeFile(list, '# only comments\n\n', 'utf8');

    const { io, err } = captureIo();
    expect(await main(['scan-corpus', list], io)).toBe(2);
    expect(err.join('')).toMatch(/no usable targets/i);
  });

  it('validates --concurrency and --delay', async () => {
    const { io, err } = captureIo();
    expect(await main(['scan-corpus', 'a.test', '--concurrency', '0'], io)).toBe(2);
    expect(err.join('')).toMatch(/--concurrency expects an integer/);

    const second = captureIo();
    expect(await main(['scan-corpus', 'a.test', '--delay', 'soon'], second.io)).toBe(2);
    expect(second.err.join('')).toMatch(/--delay expects a non-negative number/);
  });

  it('parses the corpus flags off a real argv', async () => {
    const { parseArgs } = await import('../packages/cli/src/cli.js');
    const args = parseArgs([
      'scan-corpus',
      'sites.txt',
      'extra.test',
      '--concurrency',
      '4',
      '--delay',
      '2000',
      '--timeout',
      '20000',
      '--out',
      'corpus.csv',
    ]);

    expect(args.error).toBeNull();
    expect(args.command).toBe('scan-corpus');
    expect(args.corpusTargets).toEqual(['sites.txt', 'extra.test']);
    expect(args.concurrency).toBe(4);
    expect(args.delayMs).toBe(2000);
    expect(args.timeoutMs).toBe(20_000);
    expect(args.out).toBe('corpus.csv');
  });

  it('parses --respect-robots, defaulting it off', async () => {
    const { parseArgs } = await import('../packages/cli/src/cli.js');

    expect(parseArgs(['scan-corpus', 'a.test']).respectRobots).toBe(false);
    expect(parseArgs(['scan-corpus', 'a.test', '--respect-robots']).respectRobots).toBe(true);
    // Accepted on a single audit too, not just a corpus run.
    expect(parseArgs(['audit', 'a.test', '--respect-robots']).respectRobots).toBe(true);
  });

  it('lists --respect-robots in the help output', async () => {
    const { io, out } = captureIo();
    await main(['--help'], io);
    expect(out.join('')).toContain('--respect-robots');
  });

  it('lists scan-corpus in the help output', async () => {
    const { io, out } = captureIo();
    await main(['--help'], io);
    const help = out.join('');
    expect(help).toContain('scan-corpus');
    expect(help).toContain('--concurrency');
    expect(help).toContain('--delay');
    expect(help).toContain('--out');
  });
});

/* -------------------------------------------------------------------------- */
/* End to end, against a real loopback site                                    */
/* -------------------------------------------------------------------------- */

describe('scan-corpus end to end', () => {
  it('writes a clean CSV to stdout with progress on stderr', async () => {
    // A real scan of a real (loopback) page, through the real command — the
    // thing that would break if the wiring were wrong.
    const { io, out, err } = captureIo();

    const code = await main(
      ['scan-corpus', 'https://example.invalid/', '--delay', '0', '--timeout', '8000'],
      io,
    );

    expect(code).toBe(0);

    const stdout = out.join('');
    const lines = stdout.trimEnd().split('\n');
    expect(lines[0]).toBe(CORPUS_COLUMNS.join(','));
    expect(lines).toHaveLength(2);
    // An unresolvable host is still a row, with a status that says why.
    expect(lines[1]).toMatch(/^example\.invalid,/);

    // Nothing but the table on stdout; the ticker went to stderr.
    expect(stdout).not.toMatch(/scanning|done/);
    expect(err.join('')).toMatch(/scanning 1 site/);
    expect(err.join('')).toMatch(/done 1 row/);
  }, 90_000);

  it('writes to a file when given --out, leaving stdout empty', async () => {
    const { io, out, written } = captureIo();

    const code = await main(
      ['scan-corpus', 'https://example.invalid/', '--out', 'corpus.csv', '--delay', '0', '--timeout', '8000'],
      io,
    );

    expect(code).toBe(0);
    expect(out.join('')).toBe('');
    expect(written.get('corpus.csv')).toContain(CORPUS_COLUMNS.join(','));
  }, 90_000);

  it('emits JSON when --out ends in .json', async () => {
    const { io, written } = captureIo();

    await main(
      ['scan-corpus', 'https://example.invalid/', '--out', 'corpus.json', '--delay', '0', '--timeout', '8000'],
      io,
    );

    const parsed = JSON.parse(written.get('corpus.json') ?? '[]') as CorpusRow[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].domain).toBe('example.invalid');
  }, 90_000);

  it('stays quiet on stderr with --quiet', async () => {
    const { io, err, out } = captureIo();

    await main(
      ['scan-corpus', 'https://example.invalid/', '--quiet', '--delay', '0', '--timeout', '8000'],
      io,
    );

    expect(err.join('')).toBe('');
    expect(out.join('')).toContain(CORPUS_COLUMNS.join(','));
  }, 90_000);

  it('reads a file of targets and scans every one of them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentgrade-corpus-'));
    const list = join(dir, 'sites.txt');
    await writeFile(list, '# two dead hosts\nalpha.invalid\nbeta.invalid\n', 'utf8');

    const { io, out } = captureIo();
    const code = await main(['scan-corpus', list, '--delay', '0', '--timeout', '8000'], io);

    expect(code).toBe(0);
    const lines = out.join('').trimEnd().split('\n');
    expect(lines).toHaveLength(3); // header + two rows
    expect(lines[1]).toMatch(/^alpha\.invalid,/);
    expect(lines[2]).toMatch(/^beta\.invalid,/);
  }, 120_000);

  it('really writes the file through the default IO', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentgrade-corpus-'));
    const outPath = join(dir, 'nested', 'corpus.csv');

    const code = await main([
      'scan-corpus',
      'https://example.invalid/',
      '--out',
      outPath,
      '--quiet',
      '--delay',
      '0',
      '--timeout',
      '8000',
    ]);

    expect(code).toBe(0);
    const contents = await readFile(outPath, 'utf8');
    expect(contents.split('\n')[0]).toBe(CORPUS_COLUMNS.join(','));
  }, 90_000);
});
