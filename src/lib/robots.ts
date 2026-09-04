/**
 * AgentGrade — robots.txt.
 *
 * Consulted before a browser is launched, not after. The point of respecting
 * robots is to *not make the request*, and by the time Playwright has navigated
 * the request has already been made — so this runs on a plain HTTP fetch, up
 * front, and the browser never starts for a target that said no.
 *
 * Two decisions worth stating, because both differ from the obvious reading:
 *
 *  1. **A named `AgentGrade` group overrides `*`.** That is the Robots
 *     Exclusion Protocol's own rule — a crawler obeys the single most specific
 *     group that matches it — and it is what a site owner means when they write
 *     a group naming this scanner. Ignoring an explicit `Allow` in a group
 *     addressed to us would make a grant of permission indistinguishable from
 *     silence.
 *  2. **A fetch that fails means allowed.** A 404 is the ordinary case for a
 *     site with no robots.txt, and a connection error is a fact about the
 *     network, not a prohibition. Only a served, parsed, matching `Disallow` is
 *     treated as a refusal — anything else would let a flaky DNS answer silently
 *     empty a corpus.
 */

/** The product token this scanner answers to in a robots.txt group. */
export const ROBOTS_USER_AGENT = 'AgentGrade';

/** How large a robots.txt may be before it is ignored. */
const MAX_ROBOTS_BYTES = 512_000;

/** One `Allow` or `Disallow` line. */
interface RobotsRule {
  allow: boolean;
  /** The path pattern, as written. */
  pattern: string;
}

/** The rules that apply to one user-agent group. */
export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

/** A parsed robots.txt. */
export interface RobotsTxt {
  groups: RobotsGroup[];
}

/**
 * Parses robots.txt into groups.
 *
 * Consecutive `User-agent` lines share one group — `User-agent: a` followed by
 * `User-agent: b` then a rule means the rule applies to both. A rule line
 * closes the run of agents, so the next `User-agent` starts a new group.
 */
export function parseRobots(text: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let acceptingAgents = false;

  for (const rawLine of text.split(/\r\n?|\n/)) {
    // Everything after `#` is a comment, including mid-line.
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!current || !acceptingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
        acceptingAgents = true;
      }
      if (value) current.agents.push(value.toLowerCase());
      continue;
    }

    if (field !== 'allow' && field !== 'disallow') continue;
    // A rule before any User-agent line has no group to belong to.
    if (!current) continue;

    acceptingAgents = false;
    current.rules.push({ allow: field === 'allow', pattern: value });
  }

  return { groups: groups.filter((group) => group.agents.length > 0) };
}

/**
 * Selects the group that governs `userAgent`.
 *
 * A group naming the agent wins over `*`; without one, `*` applies; without
 * either, nothing applies and everything is permitted. Where several groups
 * name the same agent — which real files do — their rules are merged, since
 * dropping the later ones would silently ignore stated policy.
 */
export function groupFor(robots: RobotsTxt, userAgent: string): RobotsGroup | null {
  const token = userAgent.toLowerCase();

  const named = robots.groups.filter((group) =>
    group.agents.some((agent) => agent === token),
  );
  if (named.length > 0) {
    return { agents: [token], rules: named.flatMap((group) => group.rules) };
  }

  const wildcard = robots.groups.filter((group) => group.agents.includes('*'));
  if (wildcard.length > 0) {
    return { agents: ['*'], rules: wildcard.flatMap((group) => group.rules) };
  }

  return null;
}

/**
 * Length of the match between a robots path pattern and `path`, or `-1`.
 *
 * Supports the two wildcards every major crawler honours: `*` for any run of
 * characters and `$` to anchor the end. Built as a regex rather than by hand
 * because the patterns are short and the hand-rolled version of this is where
 * the off-by-one lives.
 */
export function matchLength(pattern: string, path: string): number {
  // An empty `Disallow:` matches nothing — it is the idiom for "allow all".
  if (pattern === '') return -1;

  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;

  const source = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');

  const expression = new RegExp(`^${source}${anchored ? '$' : ''}`);
  if (!expression.test(path)) return -1;

  // Specificity is the pattern's own length: `/a/b` beats `/a`, which is what
  // decides an Allow/Disallow conflict below.
  return body.length;
}

/**
 * Whether `path` may be fetched under `group`.
 *
 * The longest matching pattern wins, and `Allow` wins a tie — both are the
 * protocol's rules, and the tie-break is what makes the common
 * `Disallow: /` plus `Allow: /public` pairing work.
 */
export function isPathAllowed(group: RobotsGroup | null, path: string): boolean {
  if (!group) return true;

  let bestLength = -1;
  let bestAllow = true;

  for (const rule of group.rules) {
    const length = matchLength(rule.pattern, path);
    if (length < 0) continue;
    if (length > bestLength || (length === bestLength && rule.allow)) {
      bestLength = length;
      bestAllow = rule.allow;
    }
  }

  return bestLength < 0 ? true : bestAllow;
}

/** The verdict for one URL. */
export interface RobotsVerdict {
  allowed: boolean;
  /** Human-readable reason when `allowed` is false. */
  reason: string | null;
  /** True when a robots.txt was actually served and parsed. */
  consulted: boolean;
}

/** Fetches and evaluates robots.txt for one URL. */
export type RobotsFetcher = (robotsUrl: string) => Promise<{ status: number; text: string } | null>;

/**
 * Default fetcher: a plain HTTP GET, deliberately not through the browser.
 *
 * Bounded in both time and size. A robots.txt is a few kilobytes; a target that
 * answers this path with an endless stream would otherwise stall a corpus run
 * on a file fetched purely out of courtesy.
 */
export const defaultRobotsFetcher: RobotsFetcher = async (robotsUrl) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(robotsUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { accept: 'text/plain,*/*;q=0.8', 'user-agent': ROBOTS_USER_AGENT },
    });

    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_ROBOTS_BYTES) {
      return { status: response.status, text: '' };
    }

    const text = await response.text();
    return { status: response.status, text: text.slice(0, MAX_ROBOTS_BYTES) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Asks whether `targetUrl` may be fetched.
 *
 * Errs toward allowing, and says so in {@link RobotsVerdict.consulted} when it
 * had nothing to go on — a caller that wants to distinguish "permitted" from
 * "never asked" can, and a corpus row records which happened.
 */
export async function checkRobots(
  targetUrl: string,
  fetcher: RobotsFetcher = defaultRobotsFetcher,
): Promise<RobotsVerdict> {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return { allowed: true, reason: null, consulted: false };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: true, reason: null, consulted: false };
  }

  const response = await fetcher(new URL('/robots.txt', parsed.origin).toString());

  // No file, or no answer. A 404 is the ordinary case; a 5xx is the site's
  // problem, not a prohibition it has expressed.
  if (!response || response.status < 200 || response.status >= 300 || !response.text.trim()) {
    return { allowed: true, reason: null, consulted: false };
  }

  const robots = parseRobots(response.text);
  const group = groupFor(robots, ROBOTS_USER_AGENT);
  const path = `${parsed.pathname}${parsed.search}`;

  if (isPathAllowed(group, path)) {
    return { allowed: true, reason: null, consulted: true };
  }

  const which = group?.agents.includes('*') ? 'User-agent: *' : `User-agent: ${ROBOTS_USER_AGENT}`;
  return {
    allowed: false,
    reason: `${parsed.origin}/robots.txt disallows ${path} for ${which}.`,
    consulted: true,
  };
}
