/**
 * WebMCP runtime access.
 *
 * The spec surfaces the registry on both `navigator.modelContext` and
 * `document.modelContext`, and implementations disagree about which. This
 * module resolves whichever exists, and can install a marked polyfill so a page
 * still *declares* its tools in browsers that ship neither.
 */

/** The result envelope a WebMCP tool returns. */
export interface WebMcpResult {
  content: Array<{ type: 'text'; text: string }>;
  /** True when the call failed. Agents use this to decide whether to retry. */
  isError?: boolean;
}

/** Safety annotations an agent reads before deciding whether to call a tool. */
export interface WebMcpAnnotations {
  /** True when the tool only reads state. */
  readOnlyHint?: boolean;
  /** True when the effect is not easily undone. */
  destructiveHint?: boolean;
  /** True when calling twice has the same effect as calling once. */
  idempotentHint?: boolean;
  /** True when the tool reaches beyond this page (network, third party). */
  openWorldHint?: boolean;
  [key: string]: unknown;
}

/** A tool as the runtime stores it. */
export interface RegisteredWebMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: WebMcpAnnotations;
  execute: (args: never) => WebMcpResult | Promise<WebMcpResult>;
}

/** What `registerTool` hands back, when it hands back anything. */
export interface WebMcpRegistration {
  unregister?: () => void;
}

/** The subset of the WebMCP runtime this package depends on. */
export interface ModelContextLike {
  registerTool(tool: RegisteredWebMcpTool): WebMcpRegistration | void;
  getTools?(): unknown[];
  tools?: unknown[];
  /** Present only on the polyfill installed by {@link ensureModelContext}. */
  __agentgradePolyfill?: boolean;
}

declare global {
  interface Navigator {
    modelContext?: ModelContextLike;
  }
  interface Document {
    modelContext?: ModelContextLike;
  }
}

/** Where a resolved runtime was found. */
export type ModelContextHost = 'navigator' | 'document' | 'polyfill' | null;

/**
 * Returns the page's WebMCP runtime without installing anything.
 * `null` on the server, or in a browser with no runtime.
 */
export function getModelContext(): ModelContextLike | null {
  if (typeof navigator !== 'undefined' && navigator.modelContext) return navigator.modelContext;
  if (typeof document !== 'undefined' && document.modelContext) return document.modelContext;
  return null;
}

/** Reports which host provided the current runtime. */
export function getModelContextHost(): ModelContextHost {
  if (typeof navigator !== 'undefined' && navigator.modelContext) {
    return navigator.modelContext.__agentgradePolyfill ? 'polyfill' : 'navigator';
  }
  if (typeof document !== 'undefined' && document.modelContext) {
    return document.modelContext.__agentgradePolyfill ? 'polyfill' : 'document';
  }
  return null;
}

/** Options for {@link ensureModelContext}. */
export interface EnsureModelContextOptions {
  /**
   * Install a polyfilled registry when the browser has none. Default `true`.
   *
   * The polyfill does not make tools callable — nothing in a non-WebMCP browser
   * will invoke them. It exists so the declarations are *present and
   * inspectable*: an extension, a test, or an auditor can read
   * `navigator.modelContext.getTools()` and see exactly what this page offers.
   * `__agentgradePolyfill` marks it so nothing mistakes the shim for native
   * support. Pass `false` to register only where the platform is real.
   */
  polyfill?: boolean;
}

/** Returns the runtime, installing the polyfill when asked and needed. */
export function ensureModelContext(options: EnsureModelContextOptions = {}): ModelContextLike | null {
  const existing = getModelContext();
  if (existing) return existing;
  if (options.polyfill === false) return null;
  if (typeof navigator === 'undefined' && typeof document === 'undefined') return null;

  const registry: RegisteredWebMcpTool[] = [];
  const polyfill: ModelContextLike = {
    __agentgradePolyfill: true,
    tools: registry,
    getTools: () => registry.slice(),
    registerTool(tool) {
      const index = registry.findIndex((entry) => entry.name === tool.name);
      if (index >= 0) registry.splice(index, 1, tool);
      else registry.push(tool);
      return {
        unregister() {
          const position = registry.findIndex((entry) => entry.name === tool.name);
          if (position >= 0) registry.splice(position, 1);
        },
      };
    },
  };

  for (const host of [
    typeof navigator !== 'undefined' ? navigator : null,
    typeof document !== 'undefined' ? document : null,
  ]) {
    if (!host) continue;
    try {
      Object.defineProperty(host, 'modelContext', { value: polyfill, configurable: true, writable: true });
      return polyfill;
    } catch {
      // A frozen host is not fatal; try the next one.
    }
  }

  return null;
}

/**
 * Coerces whatever a developer's `execute` returned into a WebMCP envelope.
 *
 * Handlers should be allowed to `return items` rather than hand-assembling
 * `{ content: [{ type: 'text', … }] }` — the envelope is protocol ceremony, not
 * something an app author should have to remember.
 */
export function toWebMcpResult(value: unknown): WebMcpResult {
  if (value && typeof value === 'object' && Array.isArray((value as WebMcpResult).content)) {
    return value as WebMcpResult;
  }
  if (value === undefined || value === null) {
    return { content: [{ type: 'text', text: 'OK' }] };
  }
  if (typeof value === 'string') {
    return { content: [{ type: 'text', text: value }] };
  }
  try {
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
  } catch {
    return { content: [{ type: 'text', text: String(value) }] };
  }
}

/** Builds the error envelope for a failed call. */
export function toWebMcpError(message: string): WebMcpResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
