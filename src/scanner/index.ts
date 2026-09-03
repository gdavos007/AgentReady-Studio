/**
 * AgentGrade inspection engine — public entry point.
 *
 * @example
 * ```ts
 * import { scanUrl, assertAgentAuditRawData } from './scanner/index.js';
 *
 * const report = await scanUrl('https://example.com');
 * assertAgentAuditRawData(report.data);
 * console.log(report.data.summary.agentReadinessScore);
 * ```
 */

export { DEFAULT_OPTIONS, scanUrl, scanUrls } from './engine.js';
export {
  EVALUATION_HELPER_SHIM,
  MODEL_CONTEXT_READY_EXPRESSION,
  STEALTH_INIT_SCRIPT,
  inspectAgentSurface,
} from './dom-inspector.js';
export {
  DESCRIPTOR_PATHS,
  mergeTags,
  normaliseInputSchema,
  probeAllDescriptors,
  probeDescriptor,
  scanStaticHtmlForToolTags,
  toolsFromDescriptors,
  toolsFromTags,
} from './declarative-discovery.js';
export {
  assertAgentAuditRawData,
  validateAgentAuditRawData,
  validateAuditReport,
  type ValidationResult,
} from './validation.js';
export * from './types.js';
export { GRADES, GRADE_BANDS, describeGrade, gradeFor, type Grade } from '../shared/grade.js';
