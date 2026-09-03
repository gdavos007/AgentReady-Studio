'use client';

/**
 * The studio consumes its own published SDK.
 *
 * Everything here lives in `packages/react`. Re-exporting rather than keeping a
 * second copy means the studio is a real user of `@agentgrade/react`: if the
 * package's registration, validation, or cleanup breaks, the studio's own
 * WebMCP tools break with it and the test suite says so.
 */

export {
  ensureModelContext,
  getModelContext,
  getModelContextHost,
  toWebMcpError,
  toWebMcpResult,
  useWebMCP,
  useWebMCPTools,
  type ModelContextLike,
  type RegisteredWebMcpTool,
  type UseWebMCPOptions,
  type WebMcpAnnotations,
  type WebMcpResult,
} from '@agentgrade/react';

/** Historical alias for {@link UseWebMCPOptions}, kept for the studio's hooks. */
export type { UseWebMCPOptions as WebMcpToolDefinition } from '@agentgrade/react';
