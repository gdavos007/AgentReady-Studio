/**
 * AgentGrade — SSRF guard.
 *
 * The scanner is a full browser pointed at a caller-supplied URL. Without a
 * guard, anyone who can submit a target can read anything the *host* can reach:
 * cloud instance metadata (`169.254.169.254`), an unauthenticated Redis on
 * `localhost`, an internal admin panel on `10.x`. The rendered page's title,
 * headings, and form structure all come back in the report, so it is a read
 * primitive, not just a connectivity probe.
 *
 * Two properties this module is built around:
 *
 *  1. **Names are checked by their resolved addresses, never by their text.**
 *     `evil.test` can have an A record pointing at `169.254.169.254`, and
 *     `0x7f.1` / `2130706433` / `[::ffff:127.0.0.1]` are all loopback. Only
 *     resolution answers the question.
 *  2. **Every record must be public, not just the first.** A DNS-rebinding name
 *     returns several addresses; accepting the target because one of them is
 *     routable lets the browser connect to the other.
 *
 * Redirects are why the caller also needs a per-request check: a public URL
 * that 302s to the metadata endpoint passes any pre-flight test. See
 * `src/scanner/engine.ts`, which registers this as a route interceptor.
 */

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/** Environment escape hatch, honoured by every caller in this repo. */
export const ALLOW_PRIVATE_ENV = 'AGENTGRADE_ALLOW_PRIVATE_TARGETS';

/**
 * Address ranges the scanner must never reach.
 *
 * Beyond the obvious RFC1918 space: `169.254.0.0/16` carries the AWS, GCP and
 * Azure instance-metadata services; `100.64.0.0/10` is carrier-grade NAT, which
 * is internal from the host's point of view; `0.0.0.0/8` reaches the local host
 * on Linux.
 */
function buildBlockList(): BlockList {
  const list = new BlockList();

  // IPv4
  list.addSubnet('0.0.0.0', 8); // "this host on this network"
  list.addSubnet('10.0.0.0', 8); // RFC1918
  list.addSubnet('100.64.0.0', 10); // CGNAT (RFC6598)
  list.addSubnet('127.0.0.0', 8); // loopback
  list.addSubnet('169.254.0.0', 16); // link-local — AWS/GCP/Azure IMDS
  list.addSubnet('172.16.0.0', 12); // RFC1918
  list.addSubnet('192.0.0.0', 24); // IETF protocol assignments
  list.addSubnet('192.0.2.0', 24); // TEST-NET-1
  list.addSubnet('192.168.0.0', 16); // RFC1918
  list.addSubnet('198.18.0.0', 15); // benchmarking
  list.addSubnet('198.51.100.0', 24); // TEST-NET-2
  list.addSubnet('203.0.113.0', 24); // TEST-NET-3
  list.addSubnet('224.0.0.0', 4); // multicast
  list.addSubnet('240.0.0.0', 4); // reserved, incl. 255.255.255.255

  // IPv6
  list.addAddress('::', 'ipv6'); // unspecified
  list.addAddress('::1', 'ipv6'); // loopback
  list.addSubnet('fc00::', 7, 'ipv6'); // unique local
  list.addSubnet('fe80::', 10, 'ipv6'); // link-local
  list.addSubnet('ff00::', 8, 'ipv6'); // multicast
  list.addSubnet('2001:db8::', 32, 'ipv6'); // documentation

  return list;
}

const BLOCKED = buildBlockList();

/** Hostnames that are loopback by definition, regardless of DNS. */
const LOOPBACK_NAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);

/**
 * Normalises an address for {@link BlockList}.
 *
 * `::ffff:127.0.0.1` is loopback wearing an IPv6 costume; checked as IPv6 it
 * matches none of the v6 ranges above, so the v4 form has to be recovered.
 */
function normaliseAddress(address: string): { value: string; family: 'ipv4' | 'ipv6' } | null {
  const trimmed = address.trim().replace(/^\[|\]$/g, '');
  const withoutZone = trimmed.split('%')[0] ?? trimmed;

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(withoutZone);
  if (mapped && isIP(mapped[1]) === 4) return { value: mapped[1], family: 'ipv4' };

  const family = isIP(withoutZone);
  if (family === 4) return { value: withoutZone, family: 'ipv4' };
  if (family === 6) return { value: withoutZone, family: 'ipv6' };
  return null;
}

/** True when a literal IP address falls in a blocked range. */
export function isPrivateAddress(address: string): boolean {
  const normalised = normaliseAddress(address);
  if (!normalised) return true; // Unparseable is not proven safe.
  return BLOCKED.check(normalised.value, normalised.family);
}

/** Why a host was rejected, for the message the caller shows. */
export interface HostVerdict {
  /** True when the host is safe to connect to. */
  allowed: boolean;
  /** The addresses the host resolved to, for the diagnostic. */
  addresses: string[];
  /** Human-readable reason when `allowed` is false. */
  reason: string | null;
}

/**
 * DNS results are cached briefly.
 *
 * A page pulls dozens of subresources from the same few hosts, and the route
 * interceptor runs on every one of them. The TTL is deliberately short: a long
 * cache is itself a rebinding window, where a name checked as public is later
 * re-resolved by the browser to something internal.
 */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { verdict: HostVerdict; expiresAt: number }>();

/** Clears the resolution cache. Exported for tests. */
export function clearHostCache(): void {
  cache.clear();
}

/**
 * Resolves `host` and reports whether every one of its addresses is public.
 *
 * A host that does not resolve is rejected: the scanner has nothing to connect
 * to, and treating an NXDOMAIN as "safe" would let a name that resolves
 * intermittently through on the attempt that happens to fail.
 */
export async function checkHost(host: string): Promise<HostVerdict> {
  const key = host.toLowerCase();

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.verdict;

  const verdict = await resolveVerdict(key);
  cache.set(key, { verdict, expiresAt: Date.now() + CACHE_TTL_MS });
  return verdict;
}

async function resolveVerdict(host: string): Promise<HostVerdict> {
  const bare = host.replace(/^\[|\]$/g, '');

  if (LOOPBACK_NAMES.has(bare) || bare.endsWith('.localhost')) {
    return { allowed: false, addresses: [], reason: `"${host}" is a loopback name.` };
  }

  // A literal address needs no resolution — and must not get one, since
  // `lookup()` on an IP just echoes it back.
  if (isIP(bare) !== 0 || /^::ffff:/i.test(bare)) {
    const blocked = isPrivateAddress(bare);
    return {
      allowed: !blocked,
      addresses: [bare],
      reason: blocked ? `${bare} is a private, loopback, or link-local address.` : null,
    };
  }

  let records: Array<{ address: string }> = [];
  try {
    records = await lookup(bare, { all: true });
  } catch (error) {
    return {
      allowed: false,
      addresses: [],
      reason: `"${host}" could not be resolved (${error instanceof Error ? error.message : String(error)}).`,
    };
  }

  const addresses = records.map((record) => record.address);
  if (addresses.length === 0) {
    return { allowed: false, addresses, reason: `"${host}" resolved to no addresses.` };
  }

  // Every record, not just the first: a rebinding name returns a routable
  // address alongside an internal one and the browser may pick either.
  const offending = addresses.filter((address) => isPrivateAddress(address));
  if (offending.length > 0) {
    return {
      allowed: false,
      addresses,
      reason: `"${host}" resolves to ${offending.join(', ')}, which is private, loopback, or link-local.`,
    };
  }

  return { allowed: true, addresses, reason: null };
}

/** Convenience wrapper: true when the host must not be reached. */
export async function resolvesToPrivateAddress(host: string): Promise<boolean> {
  return !(await checkHost(host)).allowed;
}

/**
 * Verdict for one outbound request URL.
 *
 * Non-HTTP schemes (`data:`, `blob:`, `about:`) never leave the browser, so
 * they are allowed through without a resolution.
 */
export async function checkRequestUrl(url: string): Promise<HostVerdict> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, addresses: [], reason: `"${url}" is not a parseable URL.` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: true, addresses: [], reason: null };
  }

  return checkHost(parsed.hostname);
}

/**
 * Whether private targets are permitted for this process.
 *
 * The studio's own sample target is `http://localhost:3000/api/fixture`, and
 * this repo's tests scan loopback fixture servers, so the escape hatch has to
 * exist. It is an explicit opt-in rather than a default because the safe
 * direction of this error is refusing to scan something harmless.
 */
export function privateTargetsAllowed(explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') return explicit;
  return process.env[ALLOW_PRIVATE_ENV] === '1';
}
