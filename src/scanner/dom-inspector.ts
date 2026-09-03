/**
 * AgentGrade — browser-evaluated inspection routines.
 *
 * IMPORTANT: {@link inspectAgentSurface} is serialised by Playwright and
 * re-parsed inside the page. It therefore must be entirely self-contained: it
 * may not reference any module-scope binding, import, or closure variable.
 * Every helper it uses is declared in its own body. Type-only imports are fine
 * because they are erased at compile time.
 */

import type { DomInspectionResult } from './types.js';

/**
 * Expression evaluated by `page.waitForFunction` to detect a WebMCP runtime.
 * Kept as a string so it carries no compile-time dependencies.
 */
export const MODEL_CONTEXT_READY_EXPRESSION = `(() => {
  try {
    const hosts = [
      typeof navigator !== 'undefined' ? navigator.modelContext : undefined,
      typeof document !== 'undefined' ? document.modelContext : undefined,
    ];
    for (const host of hosts) {
      if (!host || (typeof host !== 'object' && typeof host !== 'function')) continue;
      if (typeof host.registerTool === 'function') return true;
      if (typeof host.provideContext === 'function') return true;
      if (typeof host.getTools === 'function') return true;
      if (Array.isArray(host.tools) && host.tools.length > 0) return true;
      if (Array.isArray(host.availableTools) && host.availableTools.length > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
})()`;

/**
 * Script injected before any page script runs. It neutralises the most common
 * headless fingerprints so that bot walls do not short-circuit the audit. It
 * only masks automation flags — it never spoofs identity beyond the user agent
 * the caller already configured on the browser context.
 */
export const STEALTH_INIT_SCRIPT = `(() => {
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });
  } catch {}
  try {
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', { value: { runtime: {} }, configurable: true });
    }
  } catch {}
  try {
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission, onchange: null })
          : originalQuery.call(window.navigator.permissions, parameters);
    }
  } catch {}
  try {
    if (!navigator.languages || navigator.languages.length === 0) {
      Object.defineProperty(Navigator.prototype, 'languages', {
        get: () => ['en-US', 'en'],
        configurable: true,
      });
    }
  } catch {}
})()`;

/**
 * Transpiler helper shim.
 *
 * Playwright serialises {@link inspectAgentSurface} with `Function.toString()`
 * and re-parses it inside the page. Bundlers that preserve function names
 * (esbuild/tsx/vitest with `keepNames`, SWC) rewrite inner helpers as
 * `__name(fn, "fn")`, and that helper lives in the *module* scope, which never
 * crosses into the browser. Without this shim the inspector dies with
 * `ReferenceError: __name is not defined` under those toolchains while working
 * fine under plain `tsc`. Defining no-op helpers up front makes the inspector
 * transpiler-agnostic.
 */
export const EVALUATION_HELPER_SHIM = `(() => {
  const target = globalThis;
  if (typeof target.__name !== 'function') {
    Object.defineProperty(target, '__name', {
      value: (fn) => fn,
      configurable: true,
      writable: true,
    });
  }
  if (typeof target.__publicField !== 'function') {
    Object.defineProperty(target, '__publicField', {
      value: (object, key, value) => {
        object[key] = value;
        return value;
      },
      configurable: true,
      writable: true,
    });
  }
})()`;

/**
 * Collects the complete agent-readiness picture from inside the page:
 * WebMCP runtime registries, declarative tool markup, interactive surfaces,
 * and agent friction traps.
 *
 * Runs in the browser. Never throws: every sub-pass is individually guarded and
 * failures are appended to {@link DomInspectionResult.errors}.
 */
export function inspectAgentSurface(): DomInspectionResult {
  /* ---------------------------------------------------------------------- */
  /* Limits — keep a hostile page from producing an unbounded report.        */
  /* ---------------------------------------------------------------------- */
  const MAX_ELEMENTS = 25000;
  const MAX_FORMS = 200;
  const MAX_CONTROLS = 600;
  const MAX_TRAPS = 400;
  const MAX_FIELDS_PER_FORM = 120;
  const MAX_JSON_DEPTH = 8;
  const MAX_JSON_NODES = 4000;
  const MAX_TEXT = 400;

  const errors: string[] = [];

  const note = (context: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    if (errors.length < 50) errors.push(context + ': ' + message);
  };

  /* ---------------------------------------------------------------------- */
  /* Generic helpers                                                        */
  /* ---------------------------------------------------------------------- */

  const collapse = (value: string | null | undefined): string =>
    (value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

  /** Depth- and size-bounded structured clone that always yields JSON. */
  const toJson = (value: unknown): any => {
    let nodes = 0;
    const seen = new WeakSet<object>();
    const walk = (input: unknown, depth: number): any => {
      if (input === null) return null;
      const kind = typeof input;
      if (kind === 'string') return (input as string).slice(0, 4000);
      if (kind === 'number') return Number.isFinite(input as number) ? input : null;
      if (kind === 'boolean') return input;
      if (kind === 'bigint') return String(input);
      if (kind === 'function' || kind === 'symbol' || kind === 'undefined') return null;
      if (depth >= MAX_JSON_DEPTH) return null;
      if (++nodes > MAX_JSON_NODES) return null;
      const obj = input as object;
      if (seen.has(obj)) return null;
      seen.add(obj);
      if (Array.isArray(input)) {
        return input.slice(0, 200).map((item) => walk(item, depth + 1));
      }
      if (input instanceof Map) {
        const out: Record<string, any> = {};
        let count = 0;
        input.forEach((entryValue, entryKey) => {
          if (count++ < 200) out[String(entryKey)] = walk(entryValue, depth + 1);
        });
        return out;
      }
      if (input instanceof Set) {
        return Array.from(input).slice(0, 200).map((item) => walk(item, depth + 1));
      }
      if (typeof Node !== 'undefined' && input instanceof Node) return null;
      const out: Record<string, any> = {};
      let keys: string[] = [];
      try {
        keys = Object.keys(obj as Record<string, unknown>);
      } catch {
        return null;
      }
      for (const key of keys.slice(0, 200)) {
        let raw: unknown;
        try {
          raw = (obj as Record<string, unknown>)[key];
        } catch {
          continue;
        }
        if (typeof raw === 'function' || typeof raw === 'undefined') continue;
        out[key] = walk(raw, depth + 1);
      }
      return out;
    };
    try {
      return walk(value, 0);
    } catch {
      return null;
    }
  };

  const parseJson = (text: string | null): any => {
    if (!text) return null;
    const trimmed = text.trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  };

  /** Builds a selector for an element, piercing open shadow roots with `>>>`. */
  const selectorFor = (element: Element): string => {
    const segmentFor = (node: Element): string => {
      const tag = node.tagName.toLowerCase();
      const id = node.getAttribute('id');
      if (id && /^[A-Za-z][\w-]*$/.test(id)) {
        try {
          const root = node.getRootNode() as Document | ShadowRoot;
          if (typeof (root as Document).querySelectorAll === 'function') {
            if ((root as Document).querySelectorAll('#' + id).length === 1) return tag + '#' + id;
          }
        } catch {
          /* fall through to positional selector */
        }
      }
      const parent = node.parentElement;
      if (!parent) return tag;
      let index = 1;
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.tagName === node.tagName) index++;
      }
      return tag + ':nth-of-type(' + index + ')';
    };

    const parts: string[] = [];
    let current: Element | null = element;
    let guard = 0;
    while (current && guard++ < 60) {
      parts.unshift(segmentFor(current));
      const parent: Element | null = current.parentElement;
      if (parent) {
        current = parent;
        continue;
      }
      const root = current.getRootNode();
      if (typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot && root.host) {
        parts.unshift('>>>');
        current = root.host as Element;
        continue;
      }
      current = null;
    }
    return parts
      .join(' > ')
      .replace(/ > >>> > /g, ' >>> ')
      .replace(/^>>> > /, '');
  };

  const isVisible = (element: Element): boolean => {
    try {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        // Zero-sized wrappers may still lay out children (e.g. contents display).
        return style.display === 'contents' && element.childElementCount > 0;
      }
      return true;
    } catch {
      return true;
    }
  };

  const attributesOf = (element: Element): Record<string, string> => {
    const out: Record<string, string> = {};
    try {
      for (const attribute of Array.from(element.attributes).slice(0, 60)) {
        out[attribute.name] = attribute.value.slice(0, 1000);
      }
    } catch (error) {
      note('attributes', error);
    }
    return out;
  };

  const explicitRole = (element: Element): string | null => {
    const role = element.getAttribute('role');
    return role ? collapse(role).split(' ')[0] || null : null;
  };

  const implicitRole = (element: Element): string | null => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return element.hasAttribute('href') ? 'link' : null;
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'form') return 'form';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'header') return 'banner';
    if (tag === 'footer') return 'contentinfo';
    if (tag === 'aside') return 'complementary';
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      if (type === 'range') return 'slider';
      if (type === 'hidden') return null;
      return 'textbox';
    }
    return null;
  };

  const roleOf = (element: Element): string | null => explicitRole(element) || implicitRole(element);

  type NameResult = {
    name: string | null;
    source: 'label-element' | 'aria-label' | 'aria-labelledby' | 'placeholder' | 'title' | 'value' | null;
  };

  /** Best-effort accessible name computation (a pragmatic ACCNAME subset). */
  const accessibleName = (element: Element): NameResult => {
    try {
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const root = element.getRootNode() as Document | ShadowRoot;
        const text = labelledBy
          .split(/\s+/)
          .map((id) => {
            const target = (root as Document).getElementById
              ? (root as Document).getElementById(id)
              : document.getElementById(id);
            return target ? collapse(target.textContent) : '';
          })
          .filter(Boolean)
          .join(' ');
        if (collapse(text)) return { name: collapse(text), source: 'aria-labelledby' };
      }

      const ariaLabel = collapse(element.getAttribute('aria-label'));
      if (ariaLabel) return { name: ariaLabel, source: 'aria-label' };

      const id = element.getAttribute('id');
      if (id) {
        const root = element.getRootNode() as Document | ShadowRoot;
        let label: Element | null = null;
        try {
          label = (root as Document).querySelector('label[for="' + CSS.escape(id) + '"]');
        } catch {
          label = null;
        }
        if (label) {
          const text = collapse(label.textContent);
          if (text) return { name: text, source: 'label-element' };
        }
      }

      const wrappingLabel = element.closest ? element.closest('label') : null;
      if (wrappingLabel) {
        const text = collapse(wrappingLabel.textContent);
        if (text) return { name: text, source: 'label-element' };
      }

      const tag = element.tagName.toLowerCase();
      if (tag === 'input') {
        const type = (element.getAttribute('type') || 'text').toLowerCase();
        if (type === 'submit' || type === 'button' || type === 'reset') {
          const value = collapse(element.getAttribute('value'));
          if (value) return { name: value, source: 'value' };
        }
        if (type === 'image') {
          const alt = collapse(element.getAttribute('alt'));
          if (alt) return { name: alt, source: 'value' };
        }
      }

      // Visible text content (buttons, links, non-semantic controls).
      if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') {
        const text = collapse(element.textContent);
        if (text) return { name: text, source: 'label-element' };
        const image = element.querySelector('img[alt], svg[aria-label], svg > title');
        if (image) {
          const alt =
            collapse(image.getAttribute && image.getAttribute('alt')) ||
            collapse(image.getAttribute && image.getAttribute('aria-label')) ||
            collapse(image.textContent);
          if (alt) return { name: alt, source: 'label-element' };
        }
      }

      const placeholder = collapse(element.getAttribute('placeholder'));
      if (placeholder) return { name: placeholder, source: 'placeholder' };

      const title = collapse(element.getAttribute('title'));
      if (title) return { name: title, source: 'title' };

      return { name: null, source: null };
    } catch (error) {
      note('accessible-name', error);
      return { name: null, source: null };
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Element harvest (light DOM + open shadow roots)                        */
  /* ---------------------------------------------------------------------- */

  const allElements: Element[] = [];
  let shadowRootCount = 0;

  const harvest = (root: Document | ShadowRoot): void => {
    let walker: TreeWalker;
    try {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    } catch (error) {
      note('tree-walker', error);
      return;
    }
    let node = walker.nextNode() as Element | null;
    while (node) {
      if (allElements.length >= MAX_ELEMENTS) return;
      allElements.push(node);
      const shadow = (node as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (shadow) {
        shadowRootCount++;
        harvest(shadow);
      }
      node = walker.nextNode() as Element | null;
    }
  };

  try {
    harvest(document);
  } catch (error) {
    note('harvest', error);
  }

  const matches = (element: Element, selector: string): boolean => {
    try {
      return element.matches(selector);
    } catch {
      return false;
    }
  };

  const filterAll = (selector: string): Element[] => allElements.filter((element) => matches(element, selector));

  /* ---------------------------------------------------------------------- */
  /* 1. WebMCP runtime probes                                               */
  /* ---------------------------------------------------------------------- */

  const normaliseSchema = (raw: unknown) => {
    const json = toJson(raw);
    const isObject = !!json && typeof json === 'object' && !Array.isArray(json);
    const properties = isObject && json.properties && typeof json.properties === 'object' ? json.properties : null;
    const propertyNames = properties ? Object.keys(properties).slice(0, 100) : [];
    const required = isObject && Array.isArray(json.required) ? json.required.map(String).slice(0, 100) : [];
    return {
      raw: json === undefined ? null : json,
      type: isObject && typeof json.type === 'string' ? json.type : null,
      propertyNames,
      required,
      isStructured: propertyNames.length > 0 || (isObject && typeof json.type === 'string'),
    };
  };

  const makeToolId = (source: string, name: string, index: number): string => {
    const slug = collapse(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '');
    return source + ':' + (slug || 'anonymous-' + index);
  };

  const normaliseTool = (candidate: any, source: string, index: number) => {
    const pick = (...keys: string[]): unknown => {
      for (const key of keys) {
        try {
          const value = candidate ? candidate[key] : undefined;
          if (value !== undefined && value !== null) return value;
        } catch {
          /* ignore hostile getters */
        }
      }
      return undefined;
    };

    const name = collapse(String(pick('name', 'toolName', 'id', 'title') ?? ''));
    const descriptionRaw = pick('description', 'desc', 'summary', 'purpose');
    const schemaRaw = pick('inputSchema', 'input_schema', 'parameters', 'params', 'schema', 'arguments');
    const outputRaw = pick('outputSchema', 'output_schema', 'returns', 'result');
    const executable = ['execute', 'handler', 'callback', 'invoke', 'run', 'call'].some((key) => {
      try {
        return typeof (candidate ? candidate[key] : undefined) === 'function';
      } catch {
        return false;
      }
    });
    const annotationsRaw = pick('annotations', 'hints', 'metadata');
    const annotations = toJson(annotationsRaw);

    return {
      id: makeToolId(source, name, index),
      name,
      description: typeof descriptionRaw === 'string' ? collapse(descriptionRaw) || null : null,
      inputSchema: normaliseSchema(schemaRaw),
      outputSchema: outputRaw === undefined ? null : toJson(outputRaw),
      source: source as any,
      executable,
      annotations: annotations && typeof annotations === 'object' && !Array.isArray(annotations) ? annotations : {},
      selector: null,
      manifestUrl: null,
    };
  };

  const readToolCollection = (host: any): any[] => {
    const candidates: unknown[] = [];
    const push = (value: unknown): void => {
      if (!value) return;
      if (Array.isArray(value)) {
        candidates.push(...value.slice(0, 500));
        return;
      }
      if (typeof Map !== 'undefined' && value instanceof Map) {
        value.forEach((entry) => candidates.push(entry));
        return;
      }
      if (typeof Set !== 'undefined' && value instanceof Set) {
        value.forEach((entry) => candidates.push(entry));
        return;
      }
      if (typeof value === 'object') {
        for (const key of Object.keys(value as Record<string, unknown>).slice(0, 500)) {
          const entry = (value as Record<string, unknown>)[key];
          if (entry && typeof entry === 'object') {
            candidates.push('name' in (entry as object) ? entry : { name: key, ...(entry as object) });
          }
        }
      }
    };

    for (const key of ['tools', 'availableTools', 'registeredTools', '_tools', 'toolRegistry']) {
      try {
        push(host[key]);
      } catch {
        /* ignore */
      }
    }
    for (const key of ['getTools', 'listTools', 'getRegisteredTools', 'tools']) {
      try {
        if (typeof host[key] === 'function') push(host[key]());
      } catch {
        /* ignore */
      }
    }
    return candidates.filter((entry) => entry && typeof entry === 'object');
  };

  const apiSurfaceOf = (host: any): string[] => {
    const names = new Set<string>();
    try {
      for (const key of Object.keys(host)) names.add(key);
    } catch {
      /* ignore */
    }
    try {
      let proto = Object.getPrototypeOf(host);
      let depth = 0;
      while (proto && proto !== Object.prototype && depth++ < 5) {
        for (const key of Object.getOwnPropertyNames(proto)) {
          if (key !== 'constructor') names.add(key);
        }
        proto = Object.getPrototypeOf(proto);
      }
    } catch {
      /* ignore */
    }
    return Array.from(names).slice(0, 80).sort();
  };

  const probePath = (path: 'navigator.modelContext' | 'document.modelContext') => {
    const probe = {
      path,
      present: false,
      valueType: null as string | null,
      apiSurface: [] as string[],
      supportsRegistration: false,
      tools: [] as any[],
      error: null as string | null,
    };
    try {
      const host =
        path === 'navigator.modelContext'
          ? (navigator as any).modelContext
          : (document as any).modelContext;
      if (host === undefined || host === null) return probe;
      probe.present = true;
      probe.valueType = typeof host;
      if (typeof host !== 'object' && typeof host !== 'function') return probe;
      probe.apiSurface = apiSurfaceOf(host);
      probe.supportsRegistration = ['registerTool', 'registerTools', 'provideContext', 'addTool', 'setTools'].some(
        (key) => {
          try {
            return typeof host[key] === 'function';
          } catch {
            return false;
          }
        },
      );
      probe.tools = readToolCollection(host).map((tool, index) => normaliseTool(tool, path, index));
      // De-duplicate tools that appear in both `tools` and `getTools()`.
      const seenIds = new Set<string>();
      probe.tools = probe.tools.filter((tool) => {
        const key = tool.id + '|' + tool.name;
        if (seenIds.has(key)) return false;
        seenIds.add(key);
        return true;
      });
    } catch (error) {
      probe.error = error instanceof Error ? error.message : String(error);
    }
    return probe;
  };

  const probes = [probePath('navigator.modelContext'), probePath('document.modelContext')];

  /* ---------------------------------------------------------------------- */
  /* 2. Declarative markup                                                  */
  /* ---------------------------------------------------------------------- */

  const DECLARATIVE_SELECTOR = [
    'tool-definition',
    'mcp-tool',
    'agent-tool',
    'webmcp-tool',
    '[data-mcp-tool]',
    '[data-tool-name]',
    '[data-agent-tool]',
    '[itemtype*="MCPTool" i]',
  ].join(',');

  const tags: any[] = [];
  try {
    for (const element of filterAll(DECLARATIVE_SELECTOR).slice(0, 200)) {
      const attributes = attributesOf(element);
      const name = collapse(
        attributes['name'] ||
          attributes['data-mcp-tool'] ||
          attributes['data-tool-name'] ||
          attributes['data-agent-tool'] ||
          attributes['tool'] ||
          attributes['id'] ||
          '',
      );
      const description =
        collapse(
          attributes['description'] ||
            attributes['data-mcp-description'] ||
            attributes['data-tool-description'] ||
            attributes['aria-description'] ||
            '',
        ) || null;
      let inlineSchema: any = null;
      const schemaAttribute =
        attributes['input-schema'] || attributes['data-mcp-schema'] || attributes['schema'] || attributes['parameters'];
      if (schemaAttribute) inlineSchema = parseJson(schemaAttribute);
      if (!inlineSchema) {
        const script = element.querySelector('script[type="application/json"], script[type="application/ld+json"]');
        if (script) inlineSchema = parseJson(script.textContent);
      }
      if (!inlineSchema && element.tagName.toLowerCase().includes('tool')) {
        inlineSchema = parseJson(element.textContent);
      }
      tags.push({
        tagName: element.tagName.toLowerCase(),
        selector: selectorFor(element),
        name,
        description,
        attributes,
        inlineSchema: inlineSchema === undefined ? null : inlineSchema,
        staticOnly: false,
      });
    }
  } catch (error) {
    note('declarative-tags', error);
  }

  const manifestLinks: any[] = [];
  try {
    const linkSelector =
      'link[rel*="mcp" i],link[rel*="agent" i],link[rel*="llms" i],link[rel="manifest"],meta[name*="mcp" i][content],meta[name*="agent" i][content]';
    for (const element of filterAll(linkSelector).slice(0, 40)) {
      const rel = collapse(element.getAttribute('rel') || element.getAttribute('name') || '');
      const href = collapse(element.getAttribute('href') || element.getAttribute('content') || '');
      if (!href) continue;
      let resolved = href;
      try {
        resolved = new URL(href, document.baseURI).toString();
      } catch {
        /* keep raw value */
      }
      manifestLinks.push({ rel, href, type: element.getAttribute('type'), resolved });
    }
  } catch (error) {
    note('manifest-links', error);
  }

  /* ---------------------------------------------------------------------- */
  /* 3. Interactive surface mapping                                         */
  /* ---------------------------------------------------------------------- */

  const CONTROL_SELECTOR =
    'button,[role="button"],a[href],input[type="submit"],input[type="button"],input[type="reset"],input[type="image"],summary,[onclick],[role="link"],[role="menuitem"],[role="tab"]';
  const FIELD_SELECTOR = 'input,select,textarea,[contenteditable="true"],[role="textbox"],[role="combobox"]';

  const controlOf = (element: Element) => {
    const named = accessibleName(element);
    const tabIndexAttribute = element.getAttribute('tabindex');
    const tag = element.tagName.toLowerCase();
    const nativelyFocusable =
      tag === 'button' ||
      tag === 'select' ||
      tag === 'textarea' ||
      tag === 'summary' ||
      (tag === 'a' && element.hasAttribute('href')) ||
      (tag === 'input' && (element.getAttribute('type') || 'text').toLowerCase() !== 'hidden');
    return {
      tagName: tag,
      selector: selectorFor(element),
      accessibleName: named.name,
      role: roleOf(element),
      text: collapse(element.textContent),
      focusable: nativelyFocusable || (tabIndexAttribute !== null && Number(tabIndexAttribute) >= 0),
      visible: isVisible(element),
    };
  };

  const controls: any[] = [];
  try {
    for (const element of filterAll(CONTROL_SELECTOR).slice(0, MAX_CONTROLS)) {
      controls.push(controlOf(element));
    }
  } catch (error) {
    note('controls', error);
  }

  const categoriseSurface = (element: Element, name: string | null): string => {
    const haystack = [
      name || '',
      element.getAttribute('id') || '',
      element.getAttribute('class') || '',
      element.getAttribute('name') || '',
      element.getAttribute('action') || '',
      element.getAttribute('data-testid') || '',
      collapse(element.textContent).slice(0, 200),
    ]
      .join(' ')
      .toLowerCase();

    const hasField = (selector: string): boolean => {
      try {
        return !!element.querySelector(selector);
      } catch {
        return false;
      }
    };

    if (/checkout|payment|billing|place\s?order|purchase|cart|shipping/.test(haystack)) return 'checkout';
    if (hasField('input[autocomplete*="cc-"]')) return 'checkout';
    if (/sign\s?up|register|create\s?account/.test(haystack)) return 'signup';
    if (/log\s?in|login|sign\s?in|password|authenticate/.test(haystack) || hasField('input[type="password"]'))
      return 'authentication';
    if (
      /search|query/.test(haystack) ||
      element.getAttribute('role') === 'search' ||
      hasField('input[type="search"]')
    )
      return 'search';
    if (/newsletter|subscribe|mailing/.test(haystack)) return 'newsletter';
    if (/contact|message|feedback|support/.test(haystack)) return 'contact';
    if (/filter|sort|refine|facet/.test(haystack)) return 'filter';
    return 'generic';
  };

  const surfaceName = (element: Element): string | null => {
    const aria = accessibleName(element);
    if (element.tagName.toLowerCase() !== 'form' && aria.source === 'label-element' && aria.name) {
      // For containers, textContent is too noisy — prefer structural labels.
      const legend = element.querySelector('legend,h1,h2,h3,h4,[data-title]');
      if (legend) return collapse(legend.textContent) || null;
    }
    if (aria.name && aria.source !== 'label-element') return aria.name;
    const legend = element.querySelector('legend,h1,h2,h3,h4');
    if (legend) {
      const text = collapse(legend.textContent);
      if (text) return text;
    }
    const nameAttribute = collapse(element.getAttribute('name') || element.getAttribute('id') || '');
    return nameAttribute || null;
  };

  const modalAncestor = (element: Element): boolean => {
    try {
      return !!element.closest('dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"],.modal,[data-modal]');
    } catch {
      return false;
    }
  };

  const surfaceCandidates: Element[] = [];
  const seenSurfaces = new Set<Element>();
  const addSurface = (element: Element | null): void => {
    if (!element || seenSurfaces.has(element) || surfaceCandidates.length >= MAX_FORMS) return;
    seenSurfaces.add(element);
    surfaceCandidates.push(element);
  };

  try {
    // (a) Native forms — always critical to catalogue.
    for (const element of filterAll('form')) addSurface(element);

    // (b) Checkout / cart containers that behave like forms without being one.
    const containerSelector =
      '[class*="checkout" i],[id*="checkout" i],[data-checkout],[class*="cart" i],[id*="cart" i],[data-testid*="checkout" i],[class*="payment" i],[id*="payment" i]';
    for (const element of filterAll(containerSelector)) {
      if (element.closest('form')) continue;
      const hasInteractive = !!element.querySelector(FIELD_SELECTOR + ',' + CONTROL_SELECTOR);
      if (hasInteractive) addSurface(element);
    }

    // (c) Search inputs living outside a <form>.
    const searchSelector =
      'input[type="search"],[role="search"],input[name*="search" i],input[id*="search" i],input[placeholder*="search" i],input[aria-label*="search" i]';
    for (const element of filterAll(searchSelector)) {
      if (element.closest('form')) continue;
      const container =
        (element.closest('[role="search"],search,section,div,header,nav') as Element | null) || element;
      addSurface(container);
    }

    // (d) Modal triggers and dialog surfaces.
    const modalSelector =
      'dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"],[aria-haspopup="dialog"],[data-modal-target],[data-toggle="modal"],[data-bs-toggle="modal"]';
    for (const element of filterAll(modalSelector)) addSurface(element);
  } catch (error) {
    note('surface-candidates', error);
  }

  // Drop non-form containers that merely wrap an already-catalogued form.
  const nativeForms = surfaceCandidates.filter((element) => element.tagName.toLowerCase() === 'form');
  const surfaces = surfaceCandidates.filter((element) => {
    if (element.tagName.toLowerCase() === 'form') return true;
    return !nativeForms.some((form) => form !== element && element.contains(form));
  });

  const trapsByElement = new Map<Element, string[]>();
  const forms: any[] = [];
  const formElementById = new Map<string, Element>();

  try {
    surfaces.forEach((element, index) => {
      const tag = element.tagName.toLowerCase();
      const isNativeForm = tag === 'form';
      const name = surfaceName(element);
      const isModalTrigger =
        !isNativeForm &&
        (element.hasAttribute('aria-haspopup') ||
          element.hasAttribute('data-modal-target') ||
          element.getAttribute('data-toggle') === 'modal' ||
          element.getAttribute('data-bs-toggle') === 'modal');

      const fieldElements: Element[] = [];
      try {
        for (const field of Array.from(element.querySelectorAll(FIELD_SELECTOR)).slice(0, MAX_FIELDS_PER_FORM)) {
          const type = (field.getAttribute('type') || '').toLowerCase();
          if (type === 'hidden') continue;
          fieldElements.push(field);
        }
      } catch (error) {
        note('fields', error);
      }

      const fields = fieldElements.map((field) => {
        const named = accessibleName(field);
        const fieldTag = field.tagName.toLowerCase();
        return {
          tagName: fieldTag,
          type: fieldTag === 'input' ? (field.getAttribute('type') || 'text').toLowerCase() : fieldTag,
          name: field.getAttribute('name') || '',
          id: field.getAttribute('id') || '',
          accessibleName: named.name,
          labelSource: named.source,
          required: field.hasAttribute('required') || field.getAttribute('aria-required') === 'true',
          autocomplete: field.getAttribute('autocomplete'),
          selector: selectorFor(field),
        };
      });

      const submitControls: any[] = [];
      try {
        const submitSelector =
          'button,[type="submit"],[role="button"],input[type="submit"],input[type="button"],[data-submit]';
        for (const control of Array.from(element.querySelectorAll(submitSelector)).slice(0, 30)) {
          submitControls.push(controlOf(control));
        }
        if (submitControls.length === 0 && matches(element, CONTROL_SELECTOR)) {
          submitControls.push(controlOf(element));
        }
      } catch (error) {
        note('submit-controls', error);
      }

      const category = isModalTrigger ? 'modal-trigger' : categoriseSurface(element, name);
      let action: string | null = null;
      const actionAttribute = element.getAttribute('action');
      if (actionAttribute !== null) {
        try {
          action = new URL(actionAttribute, document.baseURI).toString();
        } catch {
          action = actionAttribute;
        }
      }

      const id = 'form-' + (index + 1);
      formElementById.set(id, element);
      forms.push({
        id,
        tagName: tag,
        isNativeForm,
        selector: selectorFor(element),
        name,
        category,
        action,
        method: isNativeForm ? (element.getAttribute('method') || 'GET').toUpperCase() : null,
        fields,
        submitControls,
        fullyLabelled: fields.length > 0 && fields.every((field) => !!field.accessibleName),
        inModal: modalAncestor(element),
        visible: isVisible(element),
        trapIds: [],
        mcpAnnotated:
          element.hasAttribute('data-mcp-tool') ||
          element.hasAttribute('data-agent-tool') ||
          element.hasAttribute('data-tool-name'),
      });
    });
  } catch (error) {
    note('forms', error);
  }

  const owningFormId = (element: Element): string | null => {
    for (const [id, formElement] of formElementById) {
      if (formElement === element || formElement.contains(element)) return id;
    }
    return null;
  };

  /* ---------------------------------------------------------------------- */
  /* 4. Friction traps                                                      */
  /* ---------------------------------------------------------------------- */

  const frictionTraps: any[] = [];
  let trapSequence = 0;

  const addTrap = (
    element: Element,
    type: string,
    severity: string,
    message: string,
    evidence: Record<string, any>,
    recommendation: string,
  ): void => {
    if (frictionTraps.length >= MAX_TRAPS) return;
    const id = 'trap-' + ++trapSequence;
    const formId = owningFormId(element);
    frictionTraps.push({
      id,
      type,
      severity,
      selector: selectorFor(element),
      tagName: element.tagName.toLowerCase(),
      message,
      evidence,
      recommendation,
      formId,
    });
    const existing = trapsByElement.get(element) || [];
    existing.push(id);
    trapsByElement.set(element, existing);
    if (formId) {
      const form = forms.find((entry) => entry.id === formId);
      if (form) form.trapIds.push(id);
    }
  };

  const criticalCategories = new Set(['checkout', 'authentication', 'signup', 'search']);
  const isInCriticalSurface = (element: Element): boolean => {
    const formId = owningFormId(element);
    if (!formId) return false;
    const form = forms.find((entry) => entry.id === formId);
    return !!form && criticalCategories.has(form.category);
  };

  // (a) Unlabelled interactive controls.
  try {
    for (const element of filterAll('button,[role="button"],a[href],input[type="submit"],input[type="image"],summary')) {
      if (!isVisible(element)) continue;
      const named = accessibleName(element);
      if (named.name) continue;
      const critical = isInCriticalSurface(element);
      addTrap(
        element,
        'unlabelled-control',
        critical ? 'critical' : 'high',
        'Interactive control exposes no accessible name, so an agent cannot address it by intent.',
        {
          role: roleOf(element),
          hasIconChild: !!element.querySelector('svg,img,i,[class*="icon" i]'),
          innerHtmlLength: element.innerHTML.length,
        },
        'Add visible text, `aria-label`, or `aria-labelledby` describing the action the control performs.',
      );
    }
  } catch (error) {
    note('trap-unlabelled-control', error);
  }

  // (b) Unlabelled inputs.
  try {
    for (const element of filterAll('input,select,textarea')) {
      const type = (element.getAttribute('type') || '').toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset' || type === 'image') continue;
      if (!isVisible(element)) continue;
      const named = accessibleName(element);
      if (named.name && named.source !== 'placeholder') continue;
      const placeholderOnly = !!named.name && named.source === 'placeholder';
      addTrap(
        element,
        'unlabelled-input',
        placeholderOnly ? 'medium' : isInCriticalSurface(element) ? 'critical' : 'high',
        placeholderOnly
          ? 'Input is identified only by a placeholder, which disappears on focus and is not a programmatic label.'
          : 'Input has no programmatic label, so an agent cannot know what value to supply.',
        { type: type || element.tagName.toLowerCase(), name: element.getAttribute('name') || '', placeholderOnly },
        'Associate a `<label for>` element, or set `aria-label`/`aria-labelledby` on the field.',
      );
    }
  } catch (error) {
    note('trap-unlabelled-input', error);
  }

  // (c) Opaque / dynamic iframes without semantic targets.
  try {
    for (const element of filterAll('iframe')) {
      const title = collapse(element.getAttribute('title'));
      const ariaLabel = collapse(element.getAttribute('aria-label'));
      const src = element.getAttribute('src') || '';
      const lazy = !src || src === 'about:blank' || element.hasAttribute('data-src');
      if (title || ariaLabel) {
        if (!lazy) continue;
      }
      const critical = isInCriticalSurface(element);
      addTrap(
        element,
        'opaque-iframe',
        critical ? 'critical' : 'medium',
        lazy
          ? 'Iframe is injected dynamically with no semantic title, so its contents are invisible to an agent until (and unless) it loads.'
          : 'Iframe has no `title`, so an agent cannot tell what surface it contains.',
        { src: src.slice(0, 500), dynamic: lazy, hasTitle: !!title, sandbox: element.getAttribute('sandbox') },
        'Give every iframe a descriptive `title`, and expose the embedded action (e.g. payment) as a labelled host-page control or a WebMCP tool.',
      );
    }

    // Containers that exist only to host an injected iframe.
    for (const element of filterAll('[data-iframe],[data-embed],[id*="iframe" i],[class*="iframe" i]')) {
      if (element.tagName.toLowerCase() === 'iframe') continue;
      if (element.querySelector('iframe')) continue;
      if (!isVisible(element)) continue;
      if (roleOf(element) || accessibleName(element).name) continue;
      addTrap(
        element,
        'opaque-iframe',
        'medium',
        'Empty embed container with no role or accessible name will be filled with a third-party frame an agent cannot anticipate.',
        { childElementCount: element.childElementCount },
        'Give the container a role and accessible name up front, or render the embedded action server-side.',
      );
    }
  } catch (error) {
    note('trap-iframe', error);
  }

  // (d) Nested scroll containers.
  try {
    const scrollContainers: Element[] = [];
    for (const element of allElements) {
      const tag = element.tagName.toLowerCase();
      if (tag === 'html' || tag === 'body') continue;
      let style: CSSStyleDeclaration;
      try {
        style = getComputedStyle(element);
      } catch {
        continue;
      }
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;
      const scrollable =
        (overflowY === 'auto' || overflowY === 'scroll' || overflowX === 'auto' || overflowX === 'scroll') &&
        (element.scrollHeight > element.clientHeight + 24 || element.scrollWidth > element.clientWidth + 24);
      if (scrollable && isVisible(element)) scrollContainers.push(element);
    }
    for (const element of scrollContainers) {
      const ancestors = scrollContainers.filter((other) => other !== element && other.contains(element));
      if (ancestors.length === 0) continue;
      addTrap(
        element,
        'nested-scroll-container',
        ancestors.length > 1 ? 'high' : 'medium',
        'Scroll container nested inside another scroll container hides content from a single-pass DOM read and breaks scroll-to-element navigation.',
        {
          depth: ancestors.length + 1,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          hiddenPixels: Math.max(0, element.scrollHeight - element.clientHeight),
        },
        'Flatten the scroll hierarchy, or expose the full list via pagination links / a WebMCP tool that returns the items directly.',
      );
    }
  } catch (error) {
    note('trap-nested-scroll', error);
  }

  // (e) Non-semantic controls and multi-step non-semantic flows.
  const STEP_WORDS = /\b(next|continue|back|previous|prev|step|proceed|finish|submit|confirm|review|checkout|pay)\b/i;
  const nonSemanticControls: Element[] = [];
  try {
    for (const element of filterAll('div,span,li,td,p,a:not([href]),i,svg')) {
      if (element.childElementCount > 6) continue;
      const role = explicitRole(element);
      if (role) continue;
      const tabIndex = element.getAttribute('tabindex');
      const focusable = tabIndex !== null && Number(tabIndex) >= 0;
      const hasInlineHandler =
        element.hasAttribute('onclick') || element.hasAttribute('onmousedown') || element.hasAttribute('onpointerdown');
      let pointerCursor = false;
      try {
        pointerCursor = getComputedStyle(element).cursor === 'pointer';
      } catch {
        pointerCursor = false;
      }
      const looksClickable =
        hasInlineHandler ||
        element.hasAttribute('data-action') ||
        element.hasAttribute('data-click') ||
        /\b(btn|button|clickable|cta|tab|step)\b/i.test(element.getAttribute('class') || '') ||
        (pointerCursor && !!collapse(element.textContent));
      if (!looksClickable) continue;
      if (!isVisible(element)) continue;
      if (element.closest('button,a[href],[role="button"],[role="link"],[role="tab"],[role="menuitem"]')) continue;
      nonSemanticControls.push(element);
      addTrap(
        element,
        'non-semantic-control',
        focusable ? 'medium' : 'high',
        'Clickable element is not a button or link and exposes no ARIA role, so an agent cannot recognise it as actionable.',
        {
          text: collapse(element.textContent),
          hasInlineHandler,
          pointerCursor,
          focusable,
        },
        'Use a native `<button>`/`<a href>`, or add `role="button"` plus `tabindex="0"` and keyboard handlers.',
      );
    }
  } catch (error) {
    note('trap-non-semantic', error);
  }

  try {
    const stepGroups = new Map<Element, Element[]>();
    for (const element of nonSemanticControls) {
      if (!STEP_WORDS.test(collapse(element.textContent))) continue;
      // Start at the parent: a `.step-btn` matches the stepper selector itself,
      // which would make every control its own single-member group.
      const parent = element.parentElement;
      const container =
        (parent
          ? (parent.closest('[class*="step" i],[class*="wizard" i],[class*="checkout" i],[data-step],form,section,div') as
              | Element
              | null)
          : null) ||
        parent ||
        element;
      const group = stepGroups.get(container) || [];
      group.push(element);
      stepGroups.set(container, group);
    }
    for (const [container, group] of stepGroups) {
      if (group.length < 2) continue;
      addTrap(
        container,
        'multi-step-non-semantic',
        'critical',
        'Multi-step flow is driven by non-semantic step controls, so an agent cannot reliably advance, go back, or tell which step it is on.',
        {
          stepControlCount: group.length,
          stepLabels: group.map((element) => collapse(element.textContent)).slice(0, 10),
          hasAriaCurrent: !!container.querySelector('[aria-current]'),
        },
        'Render step controls as `<button>` elements, mark the active step with `aria-current="step"`, and expose the flow as a WebMCP tool.',
      );
    }
  } catch (error) {
    note('trap-multi-step', error);
  }

  // (f) Custom elements that render nothing readable (likely closed shadow DOM).
  try {
    for (const element of allElements) {
      const tag = element.tagName.toLowerCase();
      if (!tag.includes('-')) continue;
      if ((element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot) continue;
      if (element.childElementCount > 0 || collapse(element.textContent)) continue;
      if (!isVisible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) continue;
      addTrap(
        element,
        'closed-shadow-surface',
        'high',
        'Custom element renders visible pixels but exposes no light DOM, text, or open shadow root — its content is unreadable to an agent.',
        { width: Math.round(rect.width), height: Math.round(rect.height), attributes: attributesOf(element) },
        'Attach the shadow root in `open` mode and mirror key state onto ARIA attributes, or expose the behaviour as a WebMCP tool.',
      );
    }
  } catch (error) {
    note('trap-shadow', error);
  }

  // (g) Pointer-only interactions.
  try {
    for (const element of filterAll('[draggable="true"],[onmouseover],[onmouseenter],[onhover]')) {
      if (!isVisible(element)) continue;
      const tabIndex = element.getAttribute('tabindex');
      const focusable = tabIndex !== null && Number(tabIndex) >= 0;
      if (focusable && (element.hasAttribute('onkeydown') || element.hasAttribute('onkeyup'))) continue;
      addTrap(
        element,
        'pointer-only-interaction',
        'medium',
        'Interaction is only reachable with a pointer (drag or hover) and has no keyboard equivalent an agent can drive.',
        {
          draggable: element.getAttribute('draggable') === 'true',
          hover:
            element.hasAttribute('onmouseover') ||
            element.hasAttribute('onmouseenter') ||
            element.hasAttribute('onhover'),
          focusable,
        },
        'Provide an equivalent keyboard/click affordance (e.g. a move-up/move-down button) alongside the pointer gesture.',
      );
    }
  } catch (error) {
    note('trap-pointer-only', error);
  }

  /* ---------------------------------------------------------------------- */
  /* 5. Page metadata                                                       */
  /* ---------------------------------------------------------------------- */

  const page = (() => {
    const meta = {
      title: null as string | null,
      lang: null as string | null,
      description: null as string | null,
      landmarkCount: 0,
      hasSingleMainLandmark: false,
      headingLevels: [] as number[],
      domNodeCount: allElements.length,
      shadowRootCount,
      iframeCount: 0,
      requiresJavaScript: false,
    };
    try {
      meta.title = collapse(document.title) || null;
      meta.lang = collapse(document.documentElement.getAttribute('lang')) || null;
      const descriptionMeta = document.querySelector('meta[name="description" i]');
      meta.description = descriptionMeta ? collapse(descriptionMeta.getAttribute('content')) || null : null;
      const landmarks = filterAll(
        'main,nav,header,footer,aside,section[aria-label],[role="main"],[role="navigation"],[role="banner"],[role="contentinfo"],[role="search"],[role="complementary"]',
      );
      meta.landmarkCount = landmarks.length;
      meta.hasSingleMainLandmark = filterAll('main,[role="main"]').length === 1;
      const levels = new Set<number>();
      for (const heading of filterAll('h1,h2,h3,h4,h5,h6')) {
        levels.add(Number(heading.tagName.slice(1)));
      }
      meta.headingLevels = Array.from(levels).sort((a, b) => a - b);
      meta.iframeCount = filterAll('iframe').length;
      const bodyText = collapse(document.body ? document.body.innerText || document.body.textContent : '');
      const emptyMount = filterAll('#root,#app,[data-reactroot],[ng-app]').some(
        (element) => element.childElementCount === 0,
      );
      meta.requiresJavaScript = emptyMount || (bodyText.length < 40 && filterAll('noscript').length > 0);
    } catch (error) {
      note('page-metadata', error);
    }
    return meta;
  })();

  return {
    page,
    probes,
    tags,
    manifestLinks,
    forms,
    controls,
    frictionTraps,
    errors,
  } as DomInspectionResult;
}
