/**
 * `@agentgrade/cli` — programmatic access to the audit gate.
 *
 * The binary is a thin shell over these exports, so a bespoke CI script can
 * reuse the same runner and formatters without shelling out.
 *
 * @example
 * ```ts
 * import { runAudit, formatMarkdown } from '@agentgrade/cli';
 *
 * const result = await runAudit('https://staging.example.com', { threshold: 80 });
 * if (!result.passed) await postComment(formatMarkdown(result));
 * ```
 */

export { runAudit, normaliseUrl, type AuditRunResult, type RunAuditOptions } from './audit.js';
export { formatJson, type JsonReportEnvelope } from './formatters/json.js';
export { COMMENT_MARKER, formatMarkdown, type MarkdownOptions } from './formatters/markdown.js';
export { formatPretty, type PrettyOptions } from './formatters/pretty.js';
export {
  DEFAULT_THRESHOLD,
  EXIT_CODES,
  FORMATS,
  main,
  parseArgs,
  type CliIo,
  type OutputFormat,
  type ParsedArgs,
} from './cli.js';
export {
  createStyle,
  renderBar,
  renderTable,
  stripAnsi,
  supportsColor,
  type Style,
  type TableColumn,
} from './terminal.js';
