/**
 * Read/write intent inference.
 *
 * `annotations.readOnlyHint` is the field an agent checks before deciding
 * whether a call is safe to make speculatively or retry. Most developers will
 * not set it, so this package infers it from the tool's name — and gets the
 * inference right by preferring the *leading* verb, because tool names are
 * conventionally `verb_noun`.
 *
 * The verb tables are intentionally duplicated from the auditor's
 * `src/evals/analysis.ts` rather than imported: this package must stay
 * dependency-free and installable on its own. `tests/react-sdk.test.tsx` pins
 * the two implementations to the same answers so they cannot drift apart
 * silently.
 */

/** Whether a tool reads state or changes it. */
export type ToolSemantics = 'query' | 'mutation' | 'unknown';

const LEADING_MUTATION_VERBS = new Set([
  'add', 'create', 'update', 'delete', 'remove', 'place', 'submit', 'buy', 'purchase',
  'checkout', 'pay', 'book', 'cancel', 'subscribe', 'register', 'apply', 'set', 'send',
  'post', 'transfer', 'refund', 'save', 'edit', 'upload', 'schedule', 'order',
]);

const LEADING_QUERY_VERBS = new Set([
  'get', 'list', 'search', 'find', 'read', 'fetch', 'lookup', 'query', 'show', 'view',
  'browse', 'check', 'track', 'describe', 'inspect', 'quote', 'calculate', 'filter',
  'select', 'export', 'preview', 'compare', 'estimate', 'count', 'resolve', 'summarize',
]);

const MUTATION_VERBS =
  /\b(add|create|update|delete|remove|place|submit|buy|purchase|checkout|pay|order|book|cancel|subscribe|register|sign[_\s-]?up|apply|set|send|post|transfer|refund|return)\b/i;

/**
 * Description vocabulary, narrower on purpose: "return", "order", "post",
 * "set" and "apply" are so common in ordinary prose ("returns the matching
 * items") that matching them in a description produces more false mutations
 * than true ones.
 */
const MUTATION_VERBS_IN_PROSE =
  /\b(add|create|update|delete|remove|place|submit|buy|purchase|checkout|pay|book|cancel|subscribe|sign[_\s-]?up|send|transfer|refund)\b/i;

const QUERY_VERBS =
  /\b(get|list|search|find|read|fetch|lookup|look[_\s-]?up|query|show|view|browse|check|track|status|describe|inspect|quote|calculate|filter|select|export|preview)\b/i;

/** Verbs that imply a change which is not easily undone. */
const DESTRUCTIVE_VERBS = /\b(delete|remove|cancel|place|pay|purchase|buy|refund|transfer|wipe|destroy)\b/i;

/** Classifies a tool from its name and description. */
export function classifyTool(name: string, description = ''): ToolSemantics {
  const leading = (name.replace(/[_-]+/g, ' ').trim().split(/\s+/)[0] ?? '').toLowerCase();
  if (LEADING_MUTATION_VERBS.has(leading)) return 'mutation';
  if (LEADING_QUERY_VERBS.has(leading)) return 'query';

  const spaced = name.replace(/[_-]+/g, ' ');
  if (MUTATION_VERBS.test(spaced)) return 'mutation';
  if (QUERY_VERBS.test(spaced)) return 'query';

  if (MUTATION_VERBS_IN_PROSE.test(description)) return 'mutation';
  if (QUERY_VERBS.test(description)) return 'query';
  return 'unknown';
}

/**
 * Infers `readOnlyHint`.
 *
 * An unknown classification returns `false`, not `true`: claiming a tool is
 * read-only when it might not be is the dangerous direction of the error — an
 * agent may call a read-only tool speculatively, and if that call places an
 * order, the mistake costs money.
 */
export function inferReadOnly(name: string, description = ''): boolean {
  return classifyTool(name, description) === 'query';
}

/** Infers `destructiveHint` from the same signals. */
export function inferDestructive(name: string, description = ''): boolean {
  if (classifyTool(name, description) === 'query') return false;
  return DESTRUCTIVE_VERBS.test(name.replace(/[_-]+/g, ' ')) || DESTRUCTIVE_VERBS.test(description);
}
