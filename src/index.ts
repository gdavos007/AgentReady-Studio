/**
 * AgentGrade — top-level entry point.
 *
 * Phase 1 (`./scanner`) inspects a target and produces `AgentAuditRawData`.
 * Phase 2 (`./evals`) turns that into an `AgentScorecard`. {@link auditUrl}
 * runs both.
 */

import { scanUrl } from './scanner/engine.js';
import type { AuditReport, ScannerOptions } from './scanner/types.js';
import { runSyntheticEvaluation } from './evals/synthetic-agent.js';
import { scoreAudit } from './evals/scorer.js';
import type { AgentScorecard, ScoringOptions } from './evals/types.js';

export * from './scanner/index.js';
export * from './evals/index.js';

/** Options for {@link auditUrl}. */
export interface AuditOptions {
  scanner?: ScannerOptions;
  scoring?: Omit<ScoringOptions, 'syntheticEvaluation'>;
  /**
   * High-level goal for the synthetic evaluator. Omit to skip the active
   * evaluation entirely.
   */
  syntheticGoal?: string;
}

/** A completed audit: the raw scan plus its scorecard. */
export interface CompletedAudit {
  report: AuditReport;
  scorecard: AgentScorecard;
}

/**
 * Scans a URL and scores it in one call.
 *
 * The synthetic evaluation runs in dry-run mode: the browser session is closed
 * by the time scoring happens, so no tool is invoked against the live site. To
 * run a live invocation, drive {@link scanUrl} and
 * {@link runSyntheticEvaluation} yourself with a page you keep open.
 */
export async function auditUrl(url: string, options: AuditOptions = {}): Promise<CompletedAudit> {
  const report = await scanUrl(url, options.scanner);
  const syntheticEvaluation = options.syntheticGoal
    ? await runSyntheticEvaluation(report.data, { goal: options.syntheticGoal })
    : null;
  const scorecard = scoreAudit(report.data, { ...options.scoring, syntheticEvaluation });
  return { report, scorecard };
}
