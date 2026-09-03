/**
 * AgentGrade — evaluation layer public entry point.
 *
 * @example
 * ```ts
 * import { scoreAudit, runSyntheticEvaluation } from './evals/index.js';
 *
 * const evaluation = await runSyntheticEvaluation(report.data, { goal: 'Execute product search' });
 * const scorecard = scoreAudit(report.data, { syntheticEvaluation: evaluation });
 *
 * console.log(scorecard.grade, scorecard.overallScore);
 * console.log(scorecard.benchmark.frictionTax.headline);
 * for (const issue of scorecard.issues.slice(0, 3)) {
 *   console.log(`-${issue.deductionPoints} ${issue.title}`);
 * }
 * ```
 */

export { GRADE_BANDS, describeGrade, gradeFor, scoreAudit } from './scorer.js';
export {
  BENCHMARK_CONSTANTS,
  computeFrictionTax,
  costOf,
  estimateBenchmark,
  estimateDomSnapshotTokens,
  estimateFrictionSteps,
  schemaClarity,
} from './benchmark.js';
export { synthesizeIssues, type IssueSynthesisInput } from './issues.js';
export {
  DEFAULT_SYNTHETIC_MODEL,
  SimulatedDriver,
  buildDomPlan,
  createAnthropicDriver,
  createVercelAiDriver,
  hasAnthropicCredentials,
  runSyntheticEvaluation,
  satisfiesSchema,
  summarisePage,
  synthesizeArguments,
  toolKind,
  type PageLike,
  type SyntheticAgentDriver,
  type SyntheticEvaluationOptions,
  type ToolSelection,
  type ToolSelectionRequest,
} from './synthetic-agent.js';
export {
  CHARS_PER_TOKEN,
  CRITICAL_CATEGORIES,
  TRAP_FAILURE_HAZARD,
  TRAP_RETRY_STEPS,
  TRAP_SEVERITY_WEIGHT,
  assessSchema,
  classifyTool,
  classifyToolByLanguage,
  clamp,
  deriveSurfaceCoverage,
  estimateTokens,
  hasClearDescription,
  inferPrimaryGoal,
  isReadOnlyTool,
  resolveGoal,
  round,
  safeRatio,
  weightedTrapPenalty,
  type SchemaQuality,
  type SurfaceCoverage,
  type ToolKind,
} from './analysis.js';
export * from './types.js';
