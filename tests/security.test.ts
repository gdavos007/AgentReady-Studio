/**
 * Security regression tests for Batch 1.
 *
 * The rest of the suite runs with `AGENTGRADE_ALLOW_PRIVATE_TARGETS=1` and
 * `AGENTGRADE_NO_SANDBOX=1` (see vitest.config.ts) because it scans loopback
 * fixtures inside an unprivileged container. This file deliberately unsets both
 * so the guards are exercised in their shipped, default configuration — a test
 * that only ever runs with the escape hatch on proves nothing.
 */

import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as postAudit } from '../app/api/audit/route.js';
import { createNetworkGuardRoute, launchArgs, scanUrl } from '../src/scanner/engine.js';
import {
  ALLOW_PRIVATE_ENV,
  checkHost,
  checkRequestUrl,
  clearHostCache,
  isPrivateAddress,
  privateTargetsAllowed,
} from '../src/lib/net-guard.js';
import { startFixtureServer, type FixtureServer } from './helpers/fixture-server.js';

/** Runs `body` with the private-target escape hatch disabled. */
async function withGuardEnforced<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env[ALLOW_PRIVATE_ENV];
  delete process.env[ALLOW_PRIVATE_ENV];
  clearHostCache();
  try {
    return await body();
  } finally {
    if (previous !== undefined) process.env[ALLOW_PRIVATE_ENV] = previous;
    clearHostCache();
  }
}

let server: FixtureServer;
let browser: Browser;

beforeAll(async () => {
  server = await startFixtureServer();
  // The container has no user namespaces, so this suite opts in explicitly —
  // which is the point: the flag is a decision, not a default.
  browser = await chromium.launch({ headless: true, args: launchArgs(true) });
}, 180_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await server?.close();
});

beforeEach(() => clearHostCache());
afterEach(() => clearHostCache());

/* -------------------------------------------------------------------------- */
/* H1 / M5 — SSRF                                                             */
/* -------------------------------------------------------------------------- */

describe('net-guard — address classification', () => {
  it('blocks every internal range, including the cloud metadata endpoint', () => {
    const blocked = [
      '169.254.169.254', // AWS/GCP/Azure IMDS
      '169.254.170.2', // ECS task metadata
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '100.64.0.1', // CGNAT
      '224.0.0.1', // multicast
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1', // IPv4-mapped loopback
      '::ffff:169.254.169.254',
    ];
    for (const address of blocked) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('treats an unparseable address as unsafe rather than safe', () => {
    for (const value of ['', 'not-an-ip', '999.999.999.999', '10.0.0']) {
      expect(isPrivateAddress(value), value).toBe(true);
    }
  });

  it('rejects loopback names without trusting DNS for them', async () => {
    for (const host of ['localhost', 'LOCALHOST', 'anything.localhost']) {
      const verdict = await checkHost(host);
      expect(verdict.allowed, host).toBe(false);
      expect(verdict.reason, host).toContain('loopback');
    }
  });

  it('rejects a host that does not resolve', async () => {
    const verdict = await checkHost('this-host-does-not-exist.invalid');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/could not be resolved|resolved to no addresses/);
  });

  it('lets non-HTTP schemes through — they never leave the browser', async () => {
    for (const url of ['data:text/html,<p>hi', 'blob:https://x/y', 'about:blank']) {
      expect((await checkRequestUrl(url)).allowed, url).toBe(true);
    }
  });

  it('blocks an HTTP request to an internal host', async () => {
    const verdict = await checkRequestUrl('http://169.254.169.254/latest/meta-data/');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('169.254.169.254');
  });

  it('honours the environment escape hatch only when explicitly set to 1', async () => {
    await withGuardEnforced(async () => {
      expect(privateTargetsAllowed()).toBe(false);
      process.env[ALLOW_PRIVATE_ENV] = '0';
      expect(privateTargetsAllowed()).toBe(false);
      process.env[ALLOW_PRIVATE_ENV] = 'true';
      expect(privateTargetsAllowed()).toBe(false);
      process.env[ALLOW_PRIVATE_ENV] = '1';
      expect(privateTargetsAllowed()).toBe(true);
      // An explicit argument always wins over the environment.
      expect(privateTargetsAllowed(false)).toBe(false);
    });
  });
});

describe('H1 — the studio API refuses internal targets', () => {
  const internal = [
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://localhost:6379/',
    'http://127.0.0.1:8080/',
    'http://10.0.0.1/admin',
    'http://192.168.1.1/',
    'http://[::1]:8080/',
    'http://0.0.0.0/',
  ];

  it('returns 403 for every internal target, with an actionable reason', async () => {
    await withGuardEnforced(async () => {
      for (const url of internal) {
        const response = await postAudit(
          new Request('http://studio.test/api/audit', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url }),
          }),
        );
        expect(response.status, url).toBe(403);
        const payload = (await response.json()) as { error: string };
        expect(payload.error, url).toMatch(/private|loopback|link-local/i);
        expect(payload.error, url).toContain('AGENTGRADE_ALLOW_PRIVATE_TARGETS');
      }
    });
  }, 120_000);

  it('still rejects non-http schemes with 400, before the network guard runs', async () => {
    await withGuardEnforced(async () => {
      const response = await postAudit(
        new Request('http://studio.test/api/audit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'file:///etc/passwd' }),
        }),
      );
      expect(response.status).toBe(400);
    });
  });

  it('permits loopback again when the operator opts in', async () => {
    // The studio's own sample target is http://localhost:3000/api/fixture, so
    // the escape hatch has to work — this is the documented local-dev path.
    process.env[ALLOW_PRIVATE_ENV] = '1';
    clearHostCache();
    const response = await postAudit(
      new Request('http://studio.test/api/audit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: server.url('/'), navigationTimeoutMs: 5_000 }),
      }),
    );
    expect(response.status).toBe(200);
    await response.text();
  }, 180_000);
});

describe('H1 — the scanner refuses internal targets', () => {
  it('blocks a loopback target before launching a browser', async () => {
    await withGuardEnforced(async () => {
      const report = await scanUrl(server.url('/'));
      expect(report.status).toBe('failed');
      expect(report.data.navigation.status).toBe('blocked');
      expect(report.data.diagnostics.some((d) => d.code === 'blocked-private-target')).toBe(true);
      // Nothing was scanned, so nothing leaked into the report.
      expect(report.data.page.title).toBeNull();
      expect(report.data.tools).toEqual([]);
    });
  }, 60_000);

  it('blocks a file:// target, which would read the host filesystem', async () => {
    await withGuardEnforced(async () => {
      const report = await scanUrl('file:///etc/passwd');
      expect(report.status).toBe('failed');
      expect(report.data.navigation.error).toContain('file://');
    });
  }, 60_000);

  it('scans loopback again when the caller opts in explicitly', async () => {
    await withGuardEnforced(async () => {
      const report = await scanUrl(server.url('/'), {
        browser: browser as never,
        allowPrivateTargets: true,
      });
      expect(report.status === 'ok' || report.status === 'partial').toBe(true);
      expect(report.data.tools.length).toBeGreaterThan(0);
    });
  }, 180_000);
});

describe('M5 — redirects and subresources cannot pivot to internal hosts', () => {
  it('aborts a request to an internal host through the shipped route handler', async () => {
    const blocked: string[] = [];
    const context = await browser.newContext();

    try {
      // The exact handler `scanUrl` installs, not a reimplementation of it.
      await context.route('**/*', createNetworkGuardRoute((reason) => blocked.push(reason)));
      const page = await context.newPage();

      // A page that tries to reach the metadata endpoint — the shape a
      // redirect-based pivot or a hostile subresource takes.
      await page.setContent('<html><body>guarded</body></html>');
      const reachable = await page.evaluate(async () => {
        try {
          await fetch('http://169.254.169.254/latest/meta-data/', { mode: 'no-cors' });
          return true;
        } catch {
          return false;
        }
      });

      expect(reachable).toBe(false);
      expect(blocked.some((reason) => reason.includes('169.254.169.254'))).toBe(true);
    } finally {
      await context.close();
    }
  }, 120_000);

  it('lets a public request through the same handler', async () => {
    const blocked: string[] = [];
    const handler = createNetworkGuardRoute((reason) => blocked.push(reason));

    // Drive the handler directly with a stub route: asserting on continue vs
    // abort needs no network of its own.
    const calls: string[] = [];
    const stub = {
      request: () => ({ url: () => 'https://example.com/asset.js' }),
      continue: async () => void calls.push('continue'),
      abort: async () => void calls.push('abort'),
    };
    await handler(stub as never);

    expect(calls).toEqual(['continue']);
    expect(blocked).toEqual([]);
  }, 60_000);

  it('aborts rather than throwing when a route cannot be resolved', async () => {
    const handler = createNetworkGuardRoute();
    const calls: string[] = [];
    const stub = {
      request: () => {
        throw new Error('page closed');
      },
      continue: async () => void calls.push('continue'),
      abort: async () => void calls.push('abort'),
    };

    await expect(handler(stub as never)).resolves.toBeUndefined();
    expect(calls).toEqual(['abort']);
  });
});

/* -------------------------------------------------------------------------- */
/* H2 — browser sandboxing                                                     */
/* -------------------------------------------------------------------------- */

describe('H2 — Chromium hardening', () => {
  it('never disables Site Isolation', () => {
    // This flag was here to make iframe inspection easier and removed the
    // cross-origin defences that exist because pages are hostile.
    for (const args of [launchArgs(), launchArgs(true), launchArgs(false)]) {
      expect(args.join(' ')).not.toContain('IsolateOrigins');
      expect(args.join(' ')).not.toContain('site-per-process');
    }
  });

  it('keeps the sandbox on by default', () => {
    const previous = process.env.AGENTGRADE_NO_SANDBOX;
    delete process.env.AGENTGRADE_NO_SANDBOX;
    try {
      expect(launchArgs()).not.toContain('--no-sandbox');
      expect(launchArgs(false)).not.toContain('--no-sandbox');
    } finally {
      if (previous !== undefined) process.env.AGENTGRADE_NO_SANDBOX = previous;
    }
  });

  it('disables the sandbox only on an explicit opt-in', () => {
    const previous = process.env.AGENTGRADE_NO_SANDBOX;
    try {
      expect(launchArgs(true)).toEqual(expect.arrayContaining(['--no-sandbox', '--disable-setuid-sandbox']));

      delete process.env.AGENTGRADE_NO_SANDBOX;
      expect(launchArgs()).not.toContain('--no-sandbox');

      process.env.AGENTGRADE_NO_SANDBOX = '1';
      expect(launchArgs()).toContain('--no-sandbox');

      // An explicit `false` overrides the environment.
      expect(launchArgs(false)).not.toContain('--no-sandbox');
    } finally {
      if (previous === undefined) delete process.env.AGENTGRADE_NO_SANDBOX;
      else process.env.AGENTGRADE_NO_SANDBOX = previous;
    }
  });
});
