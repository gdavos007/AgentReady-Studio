/**
 * AgentGrade Studio — audit stage vocabulary.
 *
 * Deliberately separate from `pipeline.ts`: the progress rail is a client
 * component, and importing these constants from the pipeline would drag the
 * Playwright-backed scanner into the browser bundle. Nothing here has a
 * runtime dependency of any kind.
 */

/** Ordered stages of an audit run. */
export const AUDIT_STAGES = [
  'launch',
  'discovery',
  'surfaces',
  'traps',
  'benchmark',
  'complete',
] as const;

export type AuditStage = (typeof AUDIT_STAGES)[number] | 'failed';

/** Human-readable stage labels, shown in the studio's progress rail. */
export const STAGE_LABELS: Readonly<Record<AuditStage, string>> = {
  launch: 'Launching headless session',
  discovery: 'Discovery — manifests, llms.txt, runtime tools',
  surfaces: 'Surfaces — forms, search, checkout',
  traps: 'Traps — agent friction analysis',
  benchmark: 'Benchmark — friction tax and scoring',
  complete: 'Complete',
  failed: 'Failed',
};

/** Fractional progress assigned to each stage boundary. */
export const STAGE_PROGRESS: Readonly<Record<AuditStage, number>> = {
  launch: 0.08,
  discovery: 0.4,
  surfaces: 0.6,
  traps: 0.75,
  benchmark: 0.92,
  complete: 1,
  failed: 1,
};

/** One progress tick streamed to the client. */
export interface AuditProgressEvent {
  stage: AuditStage;
  label: string;
  /** Monotonic completion fraction in `[0, 1]`. */
  progress: number;
  /** Short, specific detail — counts wherever possible. */
  detail: string;
  at: string;
}

/** The terminal event of a successful run. */
export interface AuditCompleteEvent {
  stage: 'complete';
  reportId: string;
  url: string;
  grade: string;
  score: number;
  at: string;
}

/** The terminal event of a failed run. */
export interface AuditFailedEvent {
  stage: 'failed';
  message: string;
  at: string;
}
