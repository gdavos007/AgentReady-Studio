'use client';

import { useEffect, useRef } from 'react';

import {
  ensureModelContext,
  toWebMcpError,
  toWebMcpResult,
  type ModelContextLike,
  type RegisteredWebMcpTool,
  type WebMcpAnnotations,
  type WebMcpRegistration,
  type WebMcpResult,
} from './runtime.js';
import { inferDestructive, inferReadOnly } from './semantics.js';
import { validateArguments, type JsonSchema, type Validator } from './schema.js';

/** Options for {@link useWebMCP}. */
export interface UseWebMCPOptions<Args = Record<string, unknown>> {
  /** Tool name. Conventionally `verb_noun`, e.g. `search_products`. */
  name: string;
  /** What the tool does, in a sentence. This is what the model selects on. */
  description: string;
  /**
   * JSON Schema describing `Args` — the contract the agent sees, and the
   * default source of runtime validation.
   */
  inputSchema?: JsonSchema;
  /**
   * Explicit validator: a Zod schema, any Standard Schema, or a predicate.
   * Takes precedence over `inputSchema` for validation; `inputSchema` is still
   * what the agent is shown.
   */
  validator?: Validator<Args>;
  /**
   * Overrides the inferred `readOnlyHint`. Set this whenever the tool's name
   * does not make its read/write intent obvious.
   */
  readOnly?: boolean;
  /** Overrides the inferred `destructiveHint`. */
  destructive?: boolean;
  /** Merged over the inferred annotations. */
  annotations?: WebMcpAnnotations;
  /** Set `false` to skip registration without violating the rules of hooks. */
  enabled?: boolean;
  /** Install a polyfilled registry when the browser has none. Default `true`. */
  polyfill?: boolean;
  /** Notified when `execute` throws. The agent still receives an error result. */
  onError?: (error: unknown) => void;
  /**
   * The handler. Return anything — a string, an object, or a full WebMCP
   * envelope; it is normalised before it reaches the agent.
   */
  execute: (args: Args) => unknown;
}

/**
 * Registers one WebMCP tool for the lifetime of the calling component.
 *
 * Three things this does that hand-rolled registration usually gets wrong:
 * arguments are validated before `execute` sees them, the handler is held in a
 * ref so a stable tool keeps calling the latest closure without re-registering
 * on every render, and the registration is torn down on unmount so a tool
 * cannot outlive the component that services it.
 */
export function useWebMCP<Args = Record<string, unknown>>(options: UseWebMCPOptions<Args>): void {
  const latest = useRef(options);
  latest.current = options;

  const {
    name,
    description,
    enabled = true,
    polyfill = true,
  } = options;

  // Schemas and annotations are object literals with a fresh identity on every
  // render, so they are compared by value rather than by reference. The sorted
  // serialisation is only a *comparison key* — the object registered below is
  // the caller's own, because property order in a schema is information: it is
  // the order the fields appear in, which is the order a model should fill
  // them, and sorting it alphabetically would throw that away.
  const schemaKey = stableStringify(options.inputSchema ?? null);
  const annotationsKey = stableStringify(resolveAnnotations(options));

  useEffect(() => {
    if (!enabled) return;

    const context = ensureModelContext({ polyfill });
    if (!context) return;

    const registration = context.registerTool({
      name,
      description,
      inputSchema: latest.current.inputSchema ?? { type: 'object', properties: {} },
      annotations: resolveAnnotations(latest.current),
      async execute(rawArgs: never): Promise<WebMcpResult> {
        const current = latest.current;
        const result = await validateArguments<Args>(rawArgs, {
          schema: current.inputSchema,
          validator: current.validator,
        });

        if (!result.ok) {
          // Hand the model the reason. A bare "invalid arguments" costs it a
          // retry to discover what a sentence could have told it.
          return toWebMcpError(`Invalid arguments for "${current.name}": ${result.errors.join(' ')}`);
        }

        try {
          return toWebMcpResult(await current.execute(result.value));
        } catch (error) {
          current.onError?.(error);
          return toWebMcpError(
            `"${current.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    });

    return () => unregister(context, name, registration);
  }, [name, description, schemaKey, annotationsKey, enabled, polyfill]);
}

/**
 * Registers several tools with the same lifetime semantics.
 * Useful when a component owns a whole surface rather than one action.
 */
export function useWebMCPTools(tools: Array<UseWebMCPOptions<never>>): void {
  const latest = useRef(tools);
  latest.current = tools;

  // Everything the runtime is told has to be in the key, or a change to a
  // description or an annotation would never reach the registry.
  const key = tools
    .map((tool) =>
      [
        tool.name,
        tool.description,
        String(tool.enabled ?? true),
        stableStringify(tool.inputSchema ?? null),
        stableStringify(resolveAnnotations(tool)),
      ].join('\u0000'),
    )
    .join('\u0001');

  useEffect(() => {
    const active = latest.current.filter((tool) => tool.enabled !== false);
    if (active.length === 0) return;

    const context = ensureModelContext({ polyfill: active[0]?.polyfill ?? true });
    if (!context) return;

    // Snapshot what this effect actually registered. Cleanup must undo *this*
    // registration, not whatever the newest render happens to hold — otherwise
    // shrinking or renaming the tool set strands ghost tools in the registry.
    const registered = active.map((tool) => ({
      name: tool.name,
      registration: context.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        annotations: resolveAnnotations(tool),
        async execute(rawArgs: never): Promise<WebMcpResult> {
          // Resolve by name rather than by index: the array may have been
          // reordered since registration, and calling the wrong handler is
          // worse than calling a slightly stale one.
          const current = latest.current.find((entry) => entry.name === tool.name) ?? tool;

          const result = await validateArguments(rawArgs, {
            schema: current.inputSchema,
            validator: current.validator as Validator<unknown> | undefined,
          });
          if (!result.ok) {
            return toWebMcpError(`Invalid arguments for "${current.name}": ${result.errors.join(' ')}`);
          }

          try {
            return toWebMcpResult(await current.execute(result.value as never));
          } catch (error) {
            current.onError?.(error);
            return toWebMcpError(
              `"${current.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
      }),
    }));

    return () => {
      for (const entry of registered) unregister(context, entry.name, entry.registration);
    };
  }, [key]);
}

/** Combines explicit flags, inference, and caller-supplied annotations. */
function resolveAnnotations(options: {
  name: string;
  description: string;
  readOnly?: boolean;
  destructive?: boolean;
  annotations?: WebMcpAnnotations;
}): WebMcpAnnotations {
  const readOnlyHint = options.readOnly ?? inferReadOnly(options.name, options.description);
  const destructiveHint =
    options.destructive ?? (readOnlyHint ? false : inferDestructive(options.name, options.description));

  return { readOnlyHint, destructiveHint, ...options.annotations };
}

/**
 * Removes a registration.
 *
 * Not every runtime returns an `unregister` handle, so this also falls back to
 * splicing the tool out of an array-backed registry. A tool that survives its
 * component is worse than one that never registered: the agent calls into a
 * dead closure.
 */
function unregister(
  context: ModelContextLike,
  name: string,
  registration: WebMcpRegistration | void,
): void {
  if (registration && typeof registration.unregister === 'function') {
    registration.unregister();
    return;
  }

  const registry = context.tools;
  if (Array.isArray(registry)) {
    const index = registry.findIndex((entry) => (entry as RegisteredWebMcpTool)?.name === name);
    if (index >= 0) registry.splice(index, 1);
  }
}

/** Deterministic JSON with sorted keys, so value equality survives re-renders. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return entry;
  });
}
