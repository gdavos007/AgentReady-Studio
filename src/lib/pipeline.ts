/**
 * AgentGrade Studio — audit pipeline.
 *
 * Runs the Phase 1 scanner and the Phase 2 scorer as one job, emitting staged
 * progress so the studio can show what it is doing rather than a spinner.
 *
 * Stage semantics are honest about the underlying work: `launch` and
 * `discovery` are driven live by scanner diagnostics, while `surfaces`,
 * `traps`, and `benchmark` fire as the scan's results are folded in — the
 * browser pass is a single call, so those stages report real counts rather than
 * pretending to observe work in flight.
 */

import { randomUUID } from 'node:crypto';

import { scanUrl } from '../scanner/engine.js';
import type { AuditReport, ScanDiagnostic, ScannerOptions } from '../scanner/types.js';
import { scoreAudit } from '../evals/scorer.js';
import { runSyntheticEvaluation } from '../evals/synthetic-agent.js';
import type { AgentScorecard } from '../evals/types.js';
import { getReportStore, type ReportStore, type StoredReport } from './store.js';
import { STAGE_LABELS, STAGE_PROGRESS } from './stages.js';
import type {
  AuditCompleteEvent,
  AuditFailedEvent,
  AuditProgressEvent,
  AuditStage,
} from './stages.js';

// The stage vocabulary lives in `stages.ts` so client components can render a
// progress rail without importing the Playwright-backed scanner.
export { AUDIT_STAGES, STAGE_LABELS, STAGE_PROGRESS } from './stages.js';
export type {
  AuditCompleteEvent,
  AuditFailedEvent,
  AuditProgressEvent,
  AuditStage,
} from './stages.js';


/** Options for {@link runAuditPipeline}. */
export interface AuditPipelineOptions {
  /** Scanner tuning, forwarded verbatim. */
  scanner?: ScannerOptions;
  /** Goal for the synthetic evaluator. Omit to skip the active evaluation. */
  syntheticGoal?: string;
  /** Progress sink. */
  onProgress?: (event: AuditProgressEvent) => void;
  /** Store override; defaults to the process-wide singleton. */
  store?: ReportStore;
  /** Id override, for reproducible tests. */
  id?: string;
}

/**
 * Scans a URL, scores it, persists the result, and returns the stored record.
 *
 * Never throws for target-level problems — a page that will not load still
 * produces a persisted, scored report whose status says so. Only an
 * unlaunchable browser propagates.
 */
export async function runAuditPipeline(
  url: string,
  options: AuditPipelineOptions = {},
): Promise<StoredReport> {
  const store = options.store ?? getReportStore();
  const id = options.id ?? randomUUID();
  const emit = (stage: AuditStage, detail: string): void => {
    options.onProgress?.({
      stage,
      label: STAGE_LABELS[stage],
      progress: STAGE_PROGRESS[stage],
      detail,
      at: new Date().toISOString(),
    });
  };

  emit('launch', 'Starting Chromium with automation fingerprints masked.');

  let sawNavigation = false;
  const report: AuditReport = await scanUrl(url, {
    ...options.scanner,
    onDiagnostic: (diagnostic: ScanDiagnostic) => {
      options.scanner?.onDiagnostic?.(diagnostic);
      // Only the first meaningful signal per stage is promoted to progress;
      // the rest stay in the report's diagnostics list.
      if (diagnostic.stage === 'launch' && diagnostic.code === 'cdp-attached') {
        emit('launch', 'CDP session attached.');
      }
      if (!sawNavigation && diagnostic.stage === 'descriptors') {
        sawNavigation = true;
        emit('discovery', 'Probing /.well-known/mcp, /.well-known/agent.json and /llms.txt.');
      }
    },
  });

  emit(
    'discovery',
    `${report.data.tools.length} tool(s) discovered across ${describeSources(report)}.`,
  );
  emit(
    'surfaces',
    `${report.data.forms.length} interactive surface(s), ${report.data.controls.length} control(s) catalogued.`,
  );
  emit('traps', `${report.data.frictionTraps.length} friction trap(s) detected.`);

  const syntheticEvaluation = options.syntheticGoal
    ? await runSyntheticEvaluation(report.data, { goal: options.syntheticGoal })
    : null;

  const scorecard: AgentScorecard = scoreAudit(report.data, { syntheticEvaluation });
  emit(
    'benchmark',
    `${scorecard.benchmark.frictionTax.headline} Scored ${scorecard.overallScore}/100 (${scorecard.grade}).`,
  );

  const stored = store.save({
    id,
    url,
    status: report.status,
    grade: scorecard.grade,
    score: scorecard.overallScore,
    report,
    scorecard,
  });

  emit('complete', `Report ${id} saved.`);
  return stored;
}

/** Lists the discovery channels that actually produced a tool. */
function describeSources(report: AuditReport): string {
  const sources = new Set(report.data.tools.map((tool) => tool.source));
  return sources.size === 0 ? 'no channel' : `${sources.size} channel(s)`;
}

/**
 * Runs the pipeline and streams newline-delimited JSON events.
 *
 * NDJSON rather than SSE: the studio consumes it with `fetch` + a reader, and
 * NDJSON survives proxies that buffer `text/event-stream` without the framing
 * ceremony.
 */
export function streamAuditPipeline(url: string, options: AuditPipelineOptions = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: unknown): void => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The client disconnected mid-run; the audit still completes and is
          // persisted, so the report remains reachable by id.
        }
      };

      try {
        const stored = await runAuditPipeline(url, { ...options, onProgress: write });
        const complete: AuditCompleteEvent = {
          stage: 'complete',
          reportId: stored.id,
          url: stored.url,
          grade: stored.grade,
          score: stored.score,
          at: new Date().toISOString(),
        };
        write(complete);
      } catch (error) {
        const failed: AuditFailedEvent = {
          stage: 'failed',
          message: error instanceof Error ? error.message.split('\n')[0] : String(error),
          at: new Date().toISOString(),
        };
        write(failed);
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
}
