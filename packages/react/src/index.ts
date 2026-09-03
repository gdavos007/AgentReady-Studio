/**
 * `@agentgrade/react` — drop-in WebMCP for React apps.
 *
 * @example Register one action as a tool
 * ```tsx
 * useWebMCP({
 *   name: 'search_products',
 *   description: 'Search the catalog and return matching items.',
 *   inputSchema: {
 *     type: 'object',
 *     properties: { query: { type: 'string', description: 'Free-text search.' } },
 *     required: ['query'],
 *   },
 *   execute: ({ query }) => searchProducts(query),
 * });
 * ```
 *
 * @example Make an existing form agent-callable
 * ```tsx
 * <AgentForm toolName="place_order" description="Place the order for the cart." onSubmit={handleSubmit}>
 *   <label htmlFor="email">Email address</label>
 *   <input id="email" name="email" type="email" required />
 *   <button type="submit">Buy</button>
 * </AgentForm>
 * ```
 */

export {
  AgentForm,
  buildSchema,
  inspectForm,
  type AgentFormProps,
  type DiscoveredField,
} from './AgentForm.js';
export { useWebMCP, useWebMCPTools, type UseWebMCPOptions } from './useWebMCP.js';
export {
  ensureModelContext,
  getModelContext,
  getModelContextHost,
  toWebMcpError,
  toWebMcpResult,
  type EnsureModelContextOptions,
  type ModelContextHost,
  type ModelContextLike,
  type RegisteredWebMcpTool,
  type WebMcpAnnotations,
  type WebMcpRegistration,
  type WebMcpResult,
} from './runtime.js';
export { classifyTool, inferDestructive, inferReadOnly, type ToolSemantics } from './semantics.js';
export {
  validateAgainstJsonSchema,
  validateArguments,
  type JsonSchema,
  type JsonSchemaProperty,
  type PredicateValidator,
  type StandardSchemaLike,
  type ValidationResult,
  type Validator,
  type ZodLike,
} from './schema.js';
