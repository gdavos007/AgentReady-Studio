/**
 * robots.txt tests.
 *
 * The parser is the interesting part: real robots.txt files are full of
 * consecutive user-agent lines, mid-line comments, wildcards, and
 * `Disallow: /` paired with a narrower `Allow:`. Getting any of those wrong
 * either scans a site that said no, or skips one that said yes — and the second
 * failure is silent, which makes it the worse of the two.
 */

import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ROBOTS_USER_AGENT,
  checkRobots,
  groupFor,
  isPathAllowed,
  matchLength,
  parseRobots,
} from '../src/lib/robots.js';
import { classifyScan, toCorpusRow } from '../src/index.js';
import { launchArgs, scanUrl } from '../src/scanner/engine.js';
import { scoreAudit } from '../src/evals/scorer.js';

/** A fetcher that serves one fixed body, and records what was requested. */
function serve(text: string, status = 200) {
  const asked: string[] = [];
  return {
    asked,
    fetcher: async (url: string) => {
      asked.push(url);
      return { status, text };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

describe('parseRobots', () => {
  it('groups rules under the agents that precede them', () => {
    const robots = parseRobots(`
User-agent: Googlebot
Disallow: /private

User-agent: *
Disallow: /
`);

    expect(robots.groups).toHaveLength(2);
    expect(robots.groups[0].agents).toEqual(['googlebot']);
    expect(robots.groups[1].agents).toEqual(['*']);
    expect(robots.groups[1].rules).toEqual([{ allow: false, pattern: '/' }]);
  });

  it('shares one group across consecutive user-agent lines', () => {
    // `User-agent: a` then `User-agent: b` then a rule means both, and reading
    // it as two groups would drop the rule from the first.
    const robots = parseRobots(`
User-agent: alpha
User-agent: beta
Disallow: /nope
`);

    expect(robots.groups).toHaveLength(1);
    expect(robots.groups[0].agents).toEqual(['alpha', 'beta']);
    expect(robots.groups[0].rules).toHaveLength(1);
  });

  it('starts a new group when a user-agent follows a rule', () => {
    const robots = parseRobots(`
User-agent: alpha
Disallow: /a
User-agent: beta
Disallow: /b
`);

    expect(robots.groups).toHaveLength(2);
    expect(robots.groups[0].agents).toEqual(['alpha']);
    expect(robots.groups[1].agents).toEqual(['beta']);
  });

  it('handles the untidy formatting real files carry', () => {
    const robots = parseRobots(`
# leading comment
  USER-AGENT:   *
Disallow:  /admin   # trailing comment
Sitemap: https://example.com/sitemap.xml
Crawl-delay: 10

Disallow: /tmp
`);

    const group = robots.groups[0];
    expect(group.agents).toEqual(['*']);
    // Sitemap and Crawl-delay are ignored, not treated as rules.
    expect(group.rules).toEqual([
      { allow: false, pattern: '/admin' },
      { allow: false, pattern: '/tmp' },
    ]);
  });

  it('ignores rules that precede any user-agent line', () => {
    expect(parseRobots('Disallow: /\nUser-agent: *\nAllow: /').groups).toHaveLength(1);
  });

  it('returns nothing useful for an empty or junk file', () => {
    expect(parseRobots('').groups).toEqual([]);
    expect(parseRobots('not a robots file at all').groups).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Group selection                                                             */
/* -------------------------------------------------------------------------- */

describe('groupFor', () => {
  it('prefers a group naming this scanner over the wildcard', () => {
    // The protocol's own rule, and the thing a site owner means when they name
    // us: ignoring an explicit grant would make permission indistinguishable
    // from silence.
    const robots = parseRobots(`
User-agent: *
Disallow: /

User-agent: AgentGrade
Allow: /
`);

    const group = groupFor(robots, ROBOTS_USER_AGENT);
    expect(group?.agents).toEqual(['agentgrade']);
    expect(isPathAllowed(group, '/')).toBe(true);
  });

  it('falls back to the wildcard when we are not named', () => {
    const robots = parseRobots('User-agent: *\nDisallow: /\n');
    expect(groupFor(robots, ROBOTS_USER_AGENT)?.agents).toEqual(['*']);
  });

  it('matches our token case-insensitively', () => {
    const robots = parseRobots('User-agent: agentgrade\nDisallow: /x\n');
    expect(groupFor(robots, 'AgentGrade')?.rules).toHaveLength(1);
  });

  it('merges several groups naming the same agent', () => {
    // Real files repeat a group; dropping the later one silently ignores
    // stated policy.
    const robots = parseRobots(`
User-agent: AgentGrade
Disallow: /a

User-agent: AgentGrade
Disallow: /b
`);
    expect(groupFor(robots, ROBOTS_USER_AGENT)?.rules).toHaveLength(2);
  });

  it('returns null when no group applies to us', () => {
    const robots = parseRobots('User-agent: Googlebot\nDisallow: /\n');
    expect(groupFor(robots, ROBOTS_USER_AGENT)).toBeNull();
    expect(isPathAllowed(null, '/anything')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Path matching                                                               */
/* -------------------------------------------------------------------------- */

describe('path matching', () => {
  it('measures specificity by pattern length', () => {
    expect(matchLength('/', '/anything')).toBe(1);
    expect(matchLength('/admin', '/admin/users')).toBe(6);
    expect(matchLength('/admin', '/public')).toBe(-1);
    // An empty Disallow is the idiom for "allow everything".
    expect(matchLength('', '/anything')).toBe(-1);
  });

  it('honours the * and $ wildcards', () => {
    expect(matchLength('/*.pdf$', '/docs/report.pdf')).toBeGreaterThanOrEqual(0);
    expect(matchLength('/*.pdf$', '/docs/report.pdf.html')).toBe(-1);
    expect(matchLength('/search*results', '/search/x/results')).toBeGreaterThanOrEqual(0);
  });

  it('escapes regex metacharacters in a literal pattern', () => {
    // `.` is a literal dot in robots, not "any character".
    expect(matchLength('/a.b', '/axb')).toBe(-1);
    expect(matchLength('/a.b', '/a.b')).toBe(4);
  });

  it('lets the longest match win, with Allow taking a tie', () => {
    const group = parseRobots(`
User-agent: *
Disallow: /
Allow: /public
`).groups[0];

    expect(isPathAllowed(group, '/private')).toBe(false);
    // The narrower Allow beats the blanket Disallow.
    expect(isPathAllowed(group, '/public/page')).toBe(true);
  });

  it('allows everything under an empty Disallow', () => {
    const group = parseRobots('User-agent: *\nDisallow:\n').groups[0];
    expect(isPathAllowed(group, '/')).toBe(true);
    expect(isPathAllowed(group, '/anything')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* checkRobots                                                                 */
/* -------------------------------------------------------------------------- */

describe('checkRobots', () => {
  it('refuses a blanket disallow and says which group did it', async () => {
    const { fetcher, asked } = serve('User-agent: *\nDisallow: /\n');
    const verdict = await checkRobots('https://shop.test/cart', fetcher);

    expect(verdict.allowed).toBe(false);
    expect(verdict.consulted).toBe(true);
    expect(verdict.reason).toContain('User-agent: *');
    expect(asked).toEqual(['https://shop.test/robots.txt']);
  });

  it('names us in the reason when a named group is the one that refused', async () => {
    const { fetcher } = serve('User-agent: AgentGrade\nDisallow: /\n');
    const verdict = await checkRobots('https://shop.test/', fetcher);
    expect(verdict.reason).toContain(ROBOTS_USER_AGENT);
  });

  it('allows a path the rules do not cover', async () => {
    const { fetcher } = serve('User-agent: *\nDisallow: /admin\n');
    expect((await checkRobots('https://shop.test/', fetcher)).allowed).toBe(true);
    expect((await checkRobots('https://shop.test/admin/x', fetcher)).allowed).toBe(false);
  });

  it('treats a missing file as permission, not prohibition', async () => {
    // A 404 is the ordinary case for a site with no robots.txt.
    const missing = await checkRobots('https://shop.test/', serve('', 404).fetcher);
    expect(missing.allowed).toBe(true);
    expect(missing.consulted).toBe(false);
  });

  it('treats a server error or a dead fetch as permission', async () => {
    // A 5xx is the site's problem, not a policy it expressed, and a flaky DNS
    // answer must not silently empty a corpus.
    expect((await checkRobots('https://shop.test/', serve('Disallow: /', 503).fetcher)).allowed).toBe(true);
    expect((await checkRobots('https://shop.test/', async () => null)).allowed).toBe(true);
  });

  it('ignores robots for a non-http target', async () => {
    const { fetcher, asked } = serve('User-agent: *\nDisallow: /\n');
    const verdict = await checkRobots('file:///tmp/page.html', fetcher);
    expect(verdict.allowed).toBe(true);
    expect(asked).toHaveLength(0);
  });

  it('asks the origin, not the target path', async () => {
    const { fetcher, asked } = serve('User-agent: *\nAllow: /\n');
    await checkRobots('https://shop.test/deep/page?q=1', fetcher);
    expect(asked).toEqual(['https://shop.test/robots.txt']);
  });
});

/* -------------------------------------------------------------------------- */
/* Engine integration                                                          */
/* -------------------------------------------------------------------------- */

describe('scanUrl --respect-robots', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, args: launchArgs(true) });
  }, 180_000);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
  });

  it('does not consult robots unless asked', async () => {
    let consulted = false;
    await scanUrl('https://example.invalid/', {
      browser: browser as never,
      totalTimeoutMs: 8_000,
      navigationTimeoutMs: 2_000,
      skipDescriptors: true,
      robotsFetcher: async () => {
        consulted = true;
        return { status: 200, text: 'User-agent: *\nDisallow: /\n' };
      },
    });

    // Off by default: local fixtures and a developer's own staging box are not
    // crawling, and a scanner that silently refused them would be baffling.
    expect(consulted).toBe(false);
  }, 60_000);

  it('refuses a disallowed target and records the diagnostic', async () => {
    const report = await scanUrl('https://shop.test/', {
      browser: browser as never,
      respectRobots: true,
      totalTimeoutMs: 8_000,
      skipDescriptors: true,
      robotsFetcher: async () => ({ status: 200, text: 'User-agent: *\nDisallow: /\n' }),
    });

    expect(report.status).toBe('failed');
    expect(report.data.diagnostics.map((entry) => entry.code)).toContain('robots-disallowed');
    expect(classifyScan(report)).toBe('robots-disallowed');
  }, 60_000);

  it('proceeds when robots permits', async () => {
    const report = await scanUrl('https://example.invalid/', {
      browser: browser as never,
      respectRobots: true,
      totalTimeoutMs: 8_000,
      navigationTimeoutMs: 2_000,
      skipDescriptors: true,
      robotsFetcher: async () => ({ status: 200, text: 'User-agent: *\nAllow: /\n' }),
    });

    // It got past the gate and actually tried to navigate — the host simply
    // does not resolve.
    expect(report.data.diagnostics.map((entry) => entry.code)).not.toContain('robots-disallowed');
    expect(classifyScan(report)).toBe('unreachable');
  }, 60_000);

  it('blanks every measured column on a robots-disallowed row', async () => {
    const report = await scanUrl('https://shop.test/', {
      browser: browser as never,
      respectRobots: true,
      totalTimeoutMs: 8_000,
      skipDescriptors: true,
      robotsFetcher: async () => ({ status: 200, text: 'User-agent: *\nDisallow: /\n' }),
    });

    const row = toCorpusRow('https://shop.test/', report, scoreAudit(report.data));

    expect(row.status).toBe('robots-disallowed');
    // Nothing was measured, so nothing is claimed — a 0 here would drag any
    // average computed over the corpus.
    expect(row.overall_score).toBeNull();
    expect(row.friction_penalties).toBeNull();
    expect(row.dom_nodes).toBeNull();
    expect(row.friction_tax_usd).toBeNull();
    expect(row.error).toContain('robots.txt');
  }, 60_000);

  it('never launches a page for a disallowed target', async () => {
    // The whole point of respecting robots is to not make the request. A check
    // that happens after navigation has already made it.
    let pagesOpened = 0;
    const counting = {
      ...browser,
      newContext: async (...args: unknown[]) => {
        pagesOpened += 1;
        return (browser as unknown as { newContext: (...a: unknown[]) => Promise<unknown> }).newContext(
          ...args,
        );
      },
    };

    await scanUrl('https://shop.test/', {
      browser: counting as never,
      respectRobots: true,
      totalTimeoutMs: 8_000,
      skipDescriptors: true,
      robotsFetcher: async () => ({ status: 200, text: 'User-agent: *\nDisallow: /\n' }),
    });

    expect(pagesOpened).toBe(0);
  }, 60_000);
});
