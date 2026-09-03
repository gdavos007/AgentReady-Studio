/**
 * End-to-end tests for the AgentGrade inspection engine.
 *
 * The suite launches a real Chromium via Playwright against a loopback fixture
 * server, so every assertion exercises the same code path a production scan
 * takes: navigation, CDP attach, in-page inspection, descriptor probing, and
 * report assembly.
 */

import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, request, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scanUrl } from '../src/scanner/engine.js';
import {
  mergeTags,
  normaliseInputSchema,
  probeAllDescriptors,
  scanStaticHtmlForToolTags,
  toolsFromDescriptors,
  toolsFromTags,
} from '../src/scanner/declarative-discovery.js';
import { validateAgentAuditRawData, validateAuditReport } from '../src/scanner/validation.js';
import type { AuditReport, DescriptorProbe, FrictionTrapType } from '../src/scanner/types.js';
import { LLMS_TXT, startFixtureServer, type FixtureServer } from './helpers/fixture-server.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

let server: FixtureServer;
let browser: Browser;
let report: AuditReport;

const trapsOfType = (audit: AuditReport, type: FrictionTrapType) =>
  audit.data.frictionTraps.filter((trap) => trap.type === type);

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  report = await scanUrl(server.url('/'), { browser: browser as never, totalTimeoutMs: 90_000 });
}, 180_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await server?.close();
});

describe('scanUrl — mock storefront', () => {
  it('produces a schema-conformant report', () => {
    const dataResult = validateAgentAuditRawData(report.data);
    expect(dataResult.errors).toEqual([]);
    expect(dataResult.valid).toBe(true);

    const reportResult = validateAuditReport(report);
    expect(reportResult.errors).toEqual([]);

    expect(report.data.schemaVersion).toBe('1.0.0');
    expect(report.status === 'ok' || report.status === 'partial').toBe(true);
    expect(report.durationMs).toBeGreaterThan(0);
    // The report must survive a JSON round-trip unchanged.
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('records a successful navigation with page metadata', () => {
    expect(report.data.navigation.status === 'loaded' || report.data.navigation.status === 'timeout-soft').toBe(true);
    expect(report.data.navigation.httpStatus).toBe(200);
    expect(report.data.navigation.botWallDetected).toBe(false);
    expect(report.data.navigation.finalUrl).toBe(server.url('/'));
    expect(report.data.page.title).toBe('Nimbus Outfitters — Fixture Store');
    expect(report.data.page.lang).toBe('en');
    expect(report.data.page.hasSingleMainLandmark).toBe(true);
    expect(report.data.page.headingLevels).toContain(1);
    expect(report.data.page.iframeCount).toBe(2);
    expect(report.data.page.requiresJavaScript).toBe(false);
  });

  it('reads WebMCP tools out of navigator.modelContext', () => {
    const probe = report.data.runtime.probes.find((entry) => entry.path === 'navigator.modelContext');
    expect(probe).toBeDefined();
    expect(probe!.present).toBe(true);
    expect(probe!.supportsRegistration).toBe(true);
    expect(probe!.apiSurface).toEqual(expect.arrayContaining(['registerTool', 'getTools', 'provideContext']));
    expect(probe!.error).toBeNull();

    const names = probe!.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(['add_to_cart', 'checkout', 'search_products']);

    const search = probe!.tools.find((tool) => tool.name === 'search_products')!;
    expect(search.description).toBe('Search the Nimbus catalog by free-text query.');
    expect(search.executable).toBe(true);
    expect(search.source).toBe('navigator.modelContext');
    expect(search.inputSchema.type).toBe('object');
    expect(search.inputSchema.propertyNames).toEqual(['query', 'limit']);
    expect(search.inputSchema.required).toEqual(['query']);
    expect(search.inputSchema.isStructured).toBe(true);
    expect(search.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('reads WebMCP tools out of document.modelContext', () => {
    const probe = report.data.runtime.probes.find((entry) => entry.path === 'document.modelContext');
    expect(probe).toBeDefined();
    expect(probe!.present).toBe(true);
    expect(probe!.supportsRegistration).toBe(false);
    expect(probe!.tools.map((tool) => tool.name)).toEqual(['legacy_quote']);
    // `parameters` is accepted as an alias for `inputSchema`.
    expect(probe!.tools[0].inputSchema.propertyNames).toEqual(['postalCode']);
    expect(report.data.runtime.detected).toBe(true);
    expect(report.data.runtime.tools).toHaveLength(4);
  });

  it('discovers declarative tool markup in the DOM', () => {
    const byName = new Map(report.data.declarative.tags.map((tag) => [tag.name, tag]));

    const trackOrder = byName.get('track_order');
    expect(trackOrder).toBeDefined();
    expect(trackOrder!.tagName).toBe('tool-definition');
    expect(trackOrder!.description).toBe('Look up the delivery status of an order by its confirmation number.');
    expect(trackOrder!.inlineSchema).toMatchObject({ type: 'object', required: ['orderId'] });
    expect(trackOrder!.staticOnly).toBe(false);

    const listStores = byName.get('list_stores');
    expect(listStores).toBeDefined();
    expect(listStores!.tagName).toBe('mcp-tool');
    expect(listStores!.inlineSchema).toMatchObject({ properties: { postalCode: { type: 'string' } } });

    const newsletter = byName.get('subscribe_newsletter');
    expect(newsletter).toBeDefined();
    expect(newsletter!.tagName).toBe('form');
    expect(newsletter!.description).toBe('Subscribe an email address to the Nimbus newsletter.');
  });

  it('fetches and parses the well-known descriptors and llms.txt', () => {
    const byKind = new Map(report.data.declarative.descriptors.map((probe) => [probe.kind, probe]));
    expect(byKind.size).toBe(3);

    const mcp = byKind.get('well-known-mcp') as DescriptorProbe;
    expect(mcp.found).toBe(true);
    expect(mcp.status).toBe(200);
    expect(mcp.contentType).toContain('application/json');
    expect(mcp.json).toMatchObject({ name: 'nimbus-outfitters' });

    const agent = byKind.get('well-known-agent') as DescriptorProbe;
    expect(agent.found).toBe(true);
    expect(agent.json).toMatchObject({ name: 'Nimbus Shopping Agent' });

    const llms = byKind.get('llms-txt') as DescriptorProbe;
    expect(llms.found).toBe(true);
    expect(llms.body).toBe(LLMS_TXT);

    expect(report.data.summary.hasWellKnownManifest).toBe(true);
    expect(report.data.summary.hasLlmsTxt).toBe(true);
  });

  it('merges every discovery channel into a de-duplicated tool list', () => {
    const ids = report.data.tools.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);

    const sources = new Set(report.data.tools.map((tool) => tool.source));
    expect(sources).toContain('navigator.modelContext');
    expect(sources).toContain('document.modelContext');
    expect(sources).toContain('declarative-element');
    expect(sources).toContain('declarative-form');
    expect(sources).toContain('well-known-mcp');
    expect(sources).toContain('well-known-agent');
    expect(sources).toContain('llms-txt');

    expect(report.data.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'search_products',
        'add_to_cart',
        'checkout',
        'legacy_quote',
        'track_order',
        'list_stores',
        'subscribe_newsletter',
        'get_order_status',
        'browse_catalog',
      ]),
    );

    const manifestTool = report.data.tools.find((tool) => tool.name === 'get_order_status')!;
    expect(manifestTool.manifestUrl).toBe(server.url('/.well-known/mcp'));
    expect(manifestTool.inputSchema.required).toEqual(['orderId']);
    expect(manifestTool.executable).toBe(false);

    expect(report.data.declarative.manifestLinks.map((link) => link.rel)).toEqual(
      expect.arrayContaining(['mcp-manifest', 'agent-card']),
    );
  });

  it('catalogs the critical interactive surfaces', () => {
    const forms = report.data.forms;
    const categories = forms.map((form) => form.category);
    expect(categories).toEqual(expect.arrayContaining(['authentication', 'newsletter', 'checkout', 'search']));
    expect(forms.some((form) => form.category === 'modal-trigger')).toBe(true);

    const login = forms.find((form) => form.selector.includes('#login'))!;
    expect(login.isNativeForm).toBe(true);
    expect(login.method).toBe('POST');
    expect(login.action).toBe(server.url('/session'));
    expect(login.category).toBe('authentication');
    expect(login.fullyLabelled).toBe(true);
    expect(login.fields.map((field) => field.name)).toEqual(['email', 'password']);
    expect(login.fields.every((field) => field.required)).toBe(true);
    expect(login.fields[0].labelSource).toBe('label-element');
    expect(login.submitControls.some((control) => control.accessibleName === 'Sign in')).toBe(true);
    expect(login.trapIds).toEqual([]);

    const checkout = forms.find((form) => form.selector.includes('#checkout'))!;
    expect(checkout.isNativeForm).toBe(false);
    expect(checkout.category).toBe('checkout');
    expect(checkout.method).toBeNull();
    expect(checkout.fullyLabelled).toBe(false);
    expect(checkout.trapIds.length).toBeGreaterThan(0);

    const newsletter = forms.find((form) => form.selector.includes('#newsletter'))!;
    expect(newsletter.mcpAnnotated).toBe(true);

    const search = forms.find((form) => form.category === 'search')!;
    expect(search.isNativeForm).toBe(false);
    expect(search.fields.some((field) => field.type === 'search')).toBe(true);

    const dialogForm = forms.find((form) => form.inModal);
    expect(dialogForm).toBeDefined();

    expect(report.data.controls.length).toBeGreaterThan(5);
    expect(report.data.controls.some((control) => control.accessibleName === 'Need help?')).toBe(true);
  });

  it('flags every seeded agent friction trap', () => {
    const unlabelled = trapsOfType(report, 'unlabelled-control');
    expect(unlabelled.some((trap) => trap.selector.includes('#cart-toggle'))).toBe(true);
    expect(unlabelled.every((trap) => trap.recommendation.length > 0)).toBe(true);

    const unlabelledInputs = trapsOfType(report, 'unlabelled-input');
    expect(unlabelledInputs.some((trap) => trap.selector.includes('#coupon'))).toBe(true);
    const placeholderOnly = unlabelledInputs.find((trap) => trap.evidence.placeholderOnly === true);
    expect(placeholderOnly).toBeDefined();
    expect(placeholderOnly!.severity).toBe('medium');

    const iframes = trapsOfType(report, 'opaque-iframe');
    expect(iframes.some((trap) => trap.selector.includes('#payment-frame'))).toBe(true);
    expect(iframes.some((trap) => trap.selector.includes('#wallet-host'))).toBe(true);
    // The correctly titled support iframe must not be reported.
    expect(iframes.some((trap) => trap.evidence.src === '/embed.html')).toBe(false);

    const nested = trapsOfType(report, 'nested-scroll-container');
    expect(nested).toHaveLength(1);
    expect(nested[0].selector).toContain('#inner-scroll');
    expect(nested[0].evidence.depth).toBe(2);

    const nonSemantic = trapsOfType(report, 'non-semantic-control');
    expect(nonSemantic.length).toBeGreaterThanOrEqual(3);
    expect(nonSemantic.every((trap) => trap.tagName === 'div')).toBe(true);

    const multiStep = trapsOfType(report, 'multi-step-non-semantic');
    expect(multiStep).toHaveLength(1);
    expect(multiStep[0].severity).toBe('critical');
    expect(multiStep[0].evidence.stepControlCount).toBe(3);
    expect(multiStep[0].evidence.stepLabels).toEqual(expect.arrayContaining(['Next', 'Back', 'Confirm']));

    expect(trapsOfType(report, 'closed-shadow-surface').some((trap) => trap.tagName === 'checkout-widget')).toBe(true);
    expect(trapsOfType(report, 'pointer-only-interaction').some((trap) => trap.selector.includes('#drag-1'))).toBe(true);

    // Every trap is attributable and actionable.
    for (const trap of report.data.frictionTraps) {
      expect(trap.id).toMatch(/^trap-\d+$/);
      expect(trap.selector.length).toBeGreaterThan(0);
      expect(trap.message.length).toBeGreaterThan(10);
    }
  });

  it('rolls up a consistent summary and score', () => {
    const { summary, tools, forms, frictionTraps } = report.data;
    expect(summary.totalTools).toBe(tools.length);
    expect(summary.formCount).toBe(forms.length);
    expect(summary.frictionTrapCount).toBe(frictionTraps.length);
    expect(summary.runtimeToolCount).toBe(4);
    expect(summary.hasWebMcpRuntime).toBe(true);
    expect(summary.criticalFormCount).toBeGreaterThanOrEqual(3);
    expect(summary.toolsWithDescription).toBeGreaterThan(0);
    expect(summary.toolsWithSchema).toBeGreaterThan(0);
    expect(summary.interactiveControlCount).toBe(report.data.controls.length);

    const severitySum = Object.values(summary.trapsBySeverity).reduce((total, count) => total + count, 0);
    expect(severitySum).toBe(frictionTraps.length);
    const typeSum = Object.values(summary.trapsByType).reduce((total, count) => total + (count ?? 0), 0);
    expect(typeSum).toBe(frictionTraps.length);

    expect(summary.agentReadinessScore).toBeGreaterThanOrEqual(0);
    expect(summary.agentReadinessScore).toBeLessThanOrEqual(100);
    expect(['A', 'B', 'C', 'D', 'F']).toContain(summary.grade);
    expect(summary.scanDurationMs).toBeGreaterThan(0);
  });

  it('attaches a CDP session and cross-checks the registry through it', () => {
    const codes = report.data.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('cdp-attached');
    const crossCheck = report.data.diagnostics.find((diagnostic) => diagnostic.code === 'cdp-model-context');
    expect(crossCheck?.message).toContain('present');
  });
});

describe('scanUrl — pages without an agent surface', () => {
  it('reports an empty but valid audit for a bare page', async () => {
    // Descriptor probing is origin-scoped and this fixture origin does serve
    // manifests, so disable it to assert on the page surface alone.
    const bare = await scanUrl(server.url('/bare'), { browser: browser as never, skipDescriptors: true });
    expect(validateAgentAuditRawData(bare.data).errors).toEqual([]);
    expect(bare.data.runtime.detected).toBe(false);
    expect(bare.data.runtime.probes.every((probe) => probe.present === false)).toBe(true);
    expect(bare.data.tools).toEqual([]);
    expect(bare.data.forms).toEqual([]);
    expect(bare.data.frictionTraps).toEqual([]);
    expect(bare.data.summary.hasWebMcpRuntime).toBe(false);
    expect(bare.data.summary.grade).toBe('F');
  });

  it('finds no agent surface on an SPA shell', async () => {
    const soft = await scanUrl(server.url('/soft-404'), { browser: browser as never, skipDescriptors: true });
    expect(soft.data.navigation.httpStatus).toBe(200);
    expect(soft.data.runtime.detected).toBe(false);
    expect(soft.data.tools).toEqual([]);
  });

  it('rejects descriptors that answer 200 with an HTML shell (soft 404)', async () => {
    const softServer = await startFixtureServer({ softDescriptors: true });
    const requestContext = await request.newContext();
    try {
      const probes = await probeAllDescriptors(requestContext as never, softServer.origin, 5_000);
      expect(probes).toHaveLength(3);
      for (const probe of probes) {
        expect(probe.status).toBe(200);
        expect(probe.found).toBe(false);
        expect(probe.error).toContain('HTML document');
      }
    } finally {
      await requestContext.dispose();
      await softServer.close();
    }
  });
});

describe('scanUrl — degraded targets', () => {
  it('detects a bot wall without crashing', async () => {
    const blocked = await scanUrl(server.url('/blocked'), { browser: browser as never });
    expect(validateAgentAuditRawData(blocked.data).errors).toEqual([]);
    expect(blocked.data.navigation.httpStatus).toBe(403);
    expect(blocked.data.navigation.botWallDetected).toBe(true);
    expect(blocked.data.navigation.status).toBe('blocked');
    expect(blocked.data.navigation.botWallSignals).toEqual(expect.arrayContaining(['http-403']));
    expect(blocked.status).toBe('partial');
  });

  it('surfaces an HTTP error status for a 404', async () => {
    const missing = await scanUrl(server.url('/missing'), { browser: browser as never });
    expect(missing.data.navigation.httpStatus).toBe(404);
    expect(missing.data.navigation.status).toBe('http-error');
    expect(validateAgentAuditRawData(missing.data).errors).toEqual([]);
  });

  it('fails cleanly on a navigation timeout', async () => {
    const hung = await scanUrl(server.url('/hang'), {
      browser: browser as never,
      navigationTimeoutMs: 2_000,
      totalTimeoutMs: 15_000,
    });
    expect(hung.status).toBe('failed');
    expect(hung.data.navigation.status).toBe('timeout-hard');
    expect(hung.data.navigation.error).toMatch(/timeout/i);
    expect(hung.data.summary.agentReadinessScore).toBe(0);
    expect(hung.data.summary.grade).toBe('F');
    expect(validateAgentAuditRawData(hung.data).errors).toEqual([]);
  });

  it('fails cleanly on an unreachable host', async () => {
    const dead = await scanUrl('http://127.0.0.1:1/', { browser: browser as never, navigationTimeoutMs: 5_000 });
    expect(dead.status).toBe('failed');
    expect(['network-error', 'timeout-hard']).toContain(dead.data.navigation.status);
    expect(validateAgentAuditRawData(dead.data).errors).toEqual([]);
  });

  it('rejects an unusable URL without launching a page', async () => {
    const invalid = await scanUrl('not a url at all', { browser: browser as never });
    expect(invalid.status).toBe('failed');
    expect(invalid.data.diagnostics.some((diagnostic) => diagnostic.code === 'invalid-url')).toBe(true);
  });
});

describe('scanUrl — local file target', () => {
  it('scans a mock HTML file straight off disk', async () => {
    const fileUrl = pathToFileURL(join(FIXTURE_DIR, 'mock-site.html')).toString();
    const local = await scanUrl(fileUrl, { browser: browser as never, descriptorTimeoutMs: 2_000 });

    expect(validateAgentAuditRawData(local.data).errors).toEqual([]);
    expect(local.data.runtime.detected).toBe(true);
    expect(local.data.runtime.tools.map((tool) => tool.name).sort()).toEqual([
      'add_to_cart',
      'checkout',
      'legacy_quote',
      'search_products',
    ]);
    expect(local.data.forms.length).toBeGreaterThanOrEqual(4);
    expect(local.data.frictionTraps.length).toBeGreaterThan(5);
    // No origin to probe, so the descriptors must degrade gracefully.
    expect(local.data.declarative.descriptors.every((probe) => probe.found === false)).toBe(true);
    expect(local.data.summary.hasWellKnownManifest).toBe(false);
  });
});

describe('static discovery helpers', () => {
  it('extracts declarative tool tags from raw HTML', () => {
    const tags = scanStaticHtmlForToolTags(`
      <tool-definition name="ship_quote" description="Quote shipping."
        input-schema='{"type":"object","properties":{"zip":{"type":"string"}}}'></tool-definition>
      <mcp-tool name="cancel_order"></mcp-tool>
      <form data-mcp-tool="apply_coupon" data-mcp-description="Apply a coupon code."></form>
      <div>not a tool</div>
    `);

    expect(tags.map((tag) => tag.name).sort()).toEqual(['apply_coupon', 'cancel_order', 'ship_quote']);
    expect(tags.every((tag) => tag.staticOnly)).toBe(true);
    const quote = tags.find((tag) => tag.name === 'ship_quote')!;
    expect(quote.inlineSchema).toMatchObject({ type: 'object' });
    expect(quote.description).toBe('Quote shipping.');
  });

  it('prefers live DOM tags over static duplicates when merging', () => {
    const domTag = {
      tagName: 'tool-definition',
      selector: 'tool-definition:nth-of-type(1)',
      name: 'ship_quote',
      description: 'From the DOM.',
      attributes: {},
      inlineSchema: null,
      staticOnly: false,
    };
    const staticTag = { ...domTag, selector: 'tool-definition', description: 'From the HTML.', staticOnly: true };
    const extra = { ...staticTag, name: 'only_static' };

    const merged = mergeTags([domTag], [staticTag, extra]);
    expect(merged).toHaveLength(2);
    expect(merged.find((tag) => tag.name === 'ship_quote')!.description).toBe('From the DOM.');
    expect(merged.find((tag) => tag.name === 'only_static')!.staticOnly).toBe(true);
  });

  it('normalises loose schemas', () => {
    expect(normaliseInputSchema(null)).toMatchObject({ isStructured: false, propertyNames: [], required: [] });
    expect(normaliseInputSchema({ type: 'object', properties: { a: {}, b: {} }, required: ['a'] })).toMatchObject({
      type: 'object',
      propertyNames: ['a', 'b'],
      required: ['a'],
      isStructured: true,
    });
  });

  it('converts descriptor payloads and tags into registered tools', () => {
    const probe: DescriptorProbe = {
      url: 'https://example.test/.well-known/mcp',
      kind: 'well-known-mcp',
      found: true,
      status: 200,
      contentType: 'application/json',
      body: '{}',
      json: { tools: [{ name: 'a', description: 'A tool.', inputSchema: { type: 'object' } }] },
      byteLength: 2,
      error: null,
    };
    const [tool] = toolsFromDescriptors([probe]);
    expect(tool).toMatchObject({ name: 'a', source: 'well-known-mcp', manifestUrl: probe.url, executable: false });

    const llms: DescriptorProbe = {
      ...probe,
      kind: 'llms-txt',
      json: null,
      body: '- [Search](/api/search): Find products.\n- [Orders](/api/orders): Track an order.\n',
    };
    const llmsTools = toolsFromDescriptors([llms]);
    expect(llmsTools.map((entry) => entry.name)).toEqual(['Search', 'Orders']);
    expect(llmsTools[0].description).toBe('Find products.');

    const fromTags = toolsFromTags(scanStaticHtmlForToolTags('<mcp-tool name="x" description="X."></mcp-tool>'));
    expect(fromTags[0]).toMatchObject({ id: 'declarative-element:x', source: 'declarative-element' });
  });
});

describe('validation', () => {
  it('rejects a payload with the wrong schema version', () => {
    const broken = JSON.parse(JSON.stringify(report.data));
    broken.schemaVersion = '0.0.1';
    const result = validateAgentAuditRawData(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('schemaVersion');
  });

  it('rejects mismatched summary counters and dangling trap references', () => {
    const broken = JSON.parse(JSON.stringify(report.data));
    broken.summary.totalTools = broken.tools.length + 1;
    broken.frictionTraps[0].formId = 'form-does-not-exist';
    const result = validateAgentAuditRawData(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('summary.totalTools');
    expect(result.errors.join(' ')).toContain('references unknown form');
  });

  it('rejects non-objects', () => {
    expect(validateAgentAuditRawData(null).valid).toBe(false);
    expect(validateAgentAuditRawData('nope').errors[0]).toContain('root');
  });
});
