/**
 * Machine-readable output.
 *
 * The envelope is deliberately flat at the top: `passed`, `score`, `threshold`
 * and `grade` are what a `jq` one-liner in a CI script reaches for, and burying
 * them inside the scorecard would make every consumer write a longer path.
 */

import type { AuditRunResult } from '../audit.js';

/** The JSON document `--format json` writes. */
export interface JsonReportEnvelope {
  /** Envelope version, so consumers can detect a breaking change. */
  version: '1.0.0';
  url: string;
  passed: boolean;
  score: number;
  threshold: number;
  grade: string;
  scanStatus: string;
  durationMs: number;
  generatedAt: string;
  frictionTax: {
    costUsd: number;
    secondsWasted: number;
    tokensWasted: number;
    headline: string;
  };
  pillars: Array<{ pillar: string; score: number; earned: number; max: number }>;
  issues: Array<{
    id: string;
    title: string;
    severity: string;
    pillar: string;
    deductionPoints: number;
    remediation: string;
  }>;
  /** The complete scorecard and raw scan, for consumers that want everything. */
  scorecard: AuditRunResult['scorecard'];
  report: AuditRunResult['report'];
}

/** Formats a run as the JSON envelope. */
export function formatJson(result: AuditRunResult): string {
  const { scorecard } = result;
  const envelope: JsonReportEnvelope = {
    version: '1.0.0',
    url: result.url,
    passed: result.passed,
    score: scorecard.overallScore,
    threshold: result.threshold,
    grade: scorecard.grade,
    scanStatus: result.report.status,
    durationMs: result.durationMs,
    generatedAt: scorecard.generatedAt,
    frictionTax: {
      costUsd: scorecard.benchmark.frictionTax.costWastedUsd,
      secondsWasted: scorecard.benchmark.frictionTax.secondsWasted,
      tokensWasted: scorecard.benchmark.frictionTax.tokensWasted,
      headline: scorecard.benchmark.frictionTax.headline,
    },
    pillars: scorecard.pillars.map((pillar) => ({
      pillar: pillar.pillar,
      score: pillar.rawScore,
      earned: pillar.weightedPoints,
      max: pillar.maxPoints,
    })),
    issues: scorecard.issues.map((issue) => ({
      id: issue.id,
      title: issue.title,
      severity: issue.severity,
      pillar: issue.pillar,
      deductionPoints: issue.deductionPoints,
      remediation: issue.remediation,
    })),
    scorecard,
    report: result.report,
  };

  return `${JSON.stringify(envelope, null, 2)}\n`;
}
