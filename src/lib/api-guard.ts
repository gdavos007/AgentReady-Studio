/**
 * AgentGrade Studio — request admission control.
 *
 * `POST /api/audit` is not a normal JSON endpoint. One call launches a real
 * Chromium, navigates a hostile-by-assumption page, and holds both for up to
 * five minutes. That makes the ordinary reasons to add rate limiting — noisy
 * neighbours, cost — beside the point: a handful of concurrent requests is
 * enough to exhaust the host's memory, and nothing about the endpoint is
 * expensive to call. The asymmetry is the vulnerability.
 *
 * Three independent controls, because they fail in different directions:
 *
 *  - A **concurrency semaphore** bounds how many browsers exist at once. This
 *    is the one that actually protects the host, and it is on by default.
 *  - An optional **bearer token** closes the endpoint entirely. Off by default
 *    so `npm run dev` works with no setup; the moment `AGENTGRADE_TOKEN` is
 *    set, every audit request must present it.
 *  - **Loopback binding** (see the `dev` and `start` scripts) keeps the studio
 *    off the network in the first place, which is the control that matters
 *    most and the one most easily forgotten.
 */

/** Environment variable holding the bearer token, when auth is enabled. */
export const TOKEN_ENV = 'AGENTGRADE_TOKEN';

/** Environment variable overriding {@link DEFAULT_MAX_CONCURRENT}. */
export const MAX_CONCURRENT_ENV = 'AGENTGRADE_MAX_CONCURRENT';

/**
 * Concurrent audits permitted by default.
 *
 * Two, not one: a single slot makes the studio feel broken when a stale run
 * is still winding down, and each additional slot is roughly another Chromium
 * resident in memory. Raise it with `AGENTGRADE_MAX_CONCURRENT` on a host that
 * has the headroom.
 */
export const DEFAULT_MAX_CONCURRENT = 2;

/** Resolves the configured concurrency limit, clamped to something sane. */
export function maxConcurrent(): number {
  const raw = process.env[MAX_CONCURRENT_ENV];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return DEFAULT_MAX_CONCURRENT;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_MAX_CONCURRENT;
  return Math.min(value, 16);
}

/* -------------------------------------------------------------------------- */
/* Concurrency                                                                 */
/* -------------------------------------------------------------------------- */

let inFlight = 0;

/** A held slot. Release exactly once, in a `finally`. */
export interface AuditSlot {
  release(): void;
}

/**
 * Takes an audit slot, or returns `null` when the studio is already saturated.
 *
 * Non-blocking on purpose. Queueing would turn a burst into a pile of requests
 * all holding a connection open for minutes and timing out at the client
 * anyway; a 429 with `Retry-After` tells the caller the truth immediately.
 */
export function acquireAuditSlot(): AuditSlot | null {
  if (inFlight >= maxConcurrent()) return null;
  inFlight += 1;

  let released = false;
  return {
    release(): void {
      // Guarded because the streaming route releases from a `finally` that can
      // run after the client has already disconnected; a double release would
      // hand out a slot that was never taken.
      if (released) return;
      released = true;
      inFlight = Math.max(0, inFlight - 1);
    },
  };
}

/** Audits currently holding a slot. Exported for tests and diagnostics. */
export function inFlightAudits(): number {
  return inFlight;
}

/** Drops all outstanding slots. Test-only; never call this from a handler. */
export function resetAuditSlots(): void {
  inFlight = 0;
}

/* -------------------------------------------------------------------------- */
/* Authentication                                                              */
/* -------------------------------------------------------------------------- */

/** True when `AGENTGRADE_TOKEN` is set, so requests must be authenticated. */
export function authRequired(): boolean {
  return typeof process.env[TOKEN_ENV] === 'string' && process.env[TOKEN_ENV] !== '';
}

/**
 * Checks the `Authorization` header against the configured token.
 *
 * Compared in constant time. The comparison is short and an attacker needs
 * many samples to exploit a timing leak on it, but "the token was probably
 * long enough" is not a property worth relying on when the fix is six lines.
 */
export function isAuthorised(request: Request): boolean {
  const expected = process.env[TOKEN_ENV];
  if (typeof expected !== 'string' || expected === '') return true;

  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;

  return timingSafeEqual(match[1], expected);
}

/** Length-independent constant-time string comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  // Compared as UTF-8 bytes so a multi-byte token cannot differ in byte length
  // while matching character for character.
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  let diff = left.length ^ right.length;
  for (let index = 0; index < left.length; index += 1) {
    // Wrapping the index keeps the loop's length dependent only on the
    // attacker-supplied side, never on the secret.
    diff |= left[index] ^ right[index % (right.length || 1)];
  }
  return diff === 0;
}
