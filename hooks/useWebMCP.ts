'use client';

import { useEffect, useRef } from 'react';

/**
 * A generic `useWebMCP` hook — the React surface the code generator's Tab B
 * emits against, and the one the studio uses on itself.
 *
 * Registers a tool on mount and unregisters it on unmount, so a tool's lifetime
 * matches the component that owns the action it performs. The handler is held
 * in a ref, so a tool registered once keeps calling the *latest* closure
 * without re-registering on every render.
 */

/** The result shape a WebMCP tool returns. */
export interface WebMcpResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** Safety annotations an agent reads before deciding whether to call. */
export interface WebMcpAnnotations {
  /** True when the tool only reads state. */
  readOnlyHint?: boolean;
  /** True when the tool's effect is not easily undone. */
  destructiveHint?: boolean;
  [key: string]: unknown;
}

/** A tool declaration. */
export interface WebMcpToolDefinition<Args = Record<string, unknown>> {
  name: string;
  description: string;
  /** JSON Schema describing `Args`. */
  inputSchema: Record<string, unknown>;
  annotations?: WebMcpAnnotations;
  execute: (args: Args) => WebMcpResult | Promise<WebMcpResult>;
}

/** The subset of the WebMCP runtime this hook depends on. */
export interface ModelContextLike {
  registerTool(tool: WebMcpToolDefinition<never>): { unregister?: () => void } | void;
  getTools?(): unknown[];
  tools?: unknown[];
  /** Set by the polyfill below, absent on a native runtime. */
  __agentgradePolyfill?: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __agentgradeModelContext: ModelContextLike | undefined;

  interface Navigator {
    modelContext?: ModelContextLike;
  }
}

/**
 * Returns the page's WebMCP runtime, installing a minimal polyfill when the
 * browser has none.
 *
 * The polyfill is not a substitute for a real agent runtime — nothing will call
 * these tools in a browser that does not implement WebMCP. It exists so the
 * declarations are still *present and inspectable*: an extension, a test, or
 * AgentGrade's own scanner can read `navigator.modelContext.getTools()` and see
 * exactly what this page offers. `__agentgradePolyfill` marks it, so nothing
 * mistakes the shim for native support.
 */
export function ensureModelContext(): ModelContextLike | null {
  if (typeof navigator === 'undefined') return null;

  if (navigator.modelContext) return navigator.modelContext;

  const registry: WebMcpToolDefinition<never>[] = [];
  const polyfill: ModelContextLike = {
    __agentgradePolyfill: true,
    tools: registry,
    getTools: () => registry.slice(),
    registerTool(tool) {
      const existing = registry.findIndex((entry) => entry.name === tool.name);
      if (existing >= 0) registry.splice(existing, 1, tool);
      else registry.push(tool);
      return {
        unregister() {
          const index = registry.findIndex((entry) => entry.name === tool.name);
          if (index >= 0) registry.splice(index, 1);
        },
      };
    },
  };

  try {
    Object.defineProperty(navigator, 'modelContext', {
      value: polyfill,
      configurable: true,
      writable: true,
    });
  } catch {
    // A locked-down navigator still leaves the global escape hatch, which the
    // scanner also probes.
    globalThis.__agentgradeModelContext = polyfill;
  }

  return polyfill;
}

/**
 * Registers one WebMCP tool for the lifetime of the calling component.
 *
 * @param definition The tool. Its `name` identifies the registration; changing
 *   the name re-registers, changing only `execute` does not.
 */
export function useWebMCP<Args = Record<string, unknown>>(definition: WebMcpToolDefinition<Args>): void {
  const latest = useRef(definition);
  latest.current = definition;

  const { name, description } = definition;
  // Schemas and annotations are object literals that change identity on every
  // render, so they are compared by value rather than by reference.
  const schemaKey = stableStringify(definition.inputSchema);
  const annotationsKey = stableStringify(definition.annotations ?? {});

  useEffect(() => {
    const context = ensureModelContext();
    if (!context) return;

    const registration = context.registerTool({
      name,
      description,
      inputSchema: JSON.parse(schemaKey) as Record<string, unknown>,
      annotations: JSON.parse(annotationsKey) as WebMcpAnnotations,
      execute: (args: never) => latest.current.execute(args as Args),
    } as WebMcpToolDefinition<never>);

    return () => {
      if (registration && typeof registration.unregister === 'function') registration.unregister();
    };
  }, [name, description, schemaKey, annotationsKey]);
}

/** Registers several tools at once, with the same lifetime semantics. */
export function useWebMCPTools(definitions: Array<WebMcpToolDefinition<never>>): void {
  const latest = useRef(definitions);
  latest.current = definitions;

  const key = definitions.map((definition) => definition.name).join('|');

  useEffect(() => {
    const context = ensureModelContext();
    if (!context) return;

    const registrations = latest.current.map((definition, index) =>
      context.registerTool({
        ...definition,
        execute: (args: never) => latest.current[index].execute(args),
      }),
    );

    return () => {
      for (const registration of registrations) {
        if (registration && typeof registration.unregister === 'function') registration.unregister();
      }
    };
  }, [key]);
}

/** Deterministic JSON with sorted keys, so value equality survives re-renders. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return entry;
  });
}
