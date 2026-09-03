/**
 * Rich terminal output.
 *
 * Ordered by what a developer needs in the first two seconds: the verdict, then
 * the number, then what to fix. The friction tax sits directly under the score
 * because it is the line that makes an abstract grade worth acting on.
 */

import type { AgentScorecard, Grade, IssueSeverity } from '@agentgrade/core';

import type { AuditRunResult } from '../audit.js';
import {
  createStyle,
  renderBar,
  renderTable,
  rule,
  truncate,
  type Style,
  type StyleName,
} from '../terminal.js';

const GRADE_STYLE: Record<Grade, StyleName> = {
  A: 'brightGreen',
  B: 'green',
  C: 'yellow',
  D: 'brightYellow',
  F: 'brightRed',
};

const SEVERITY_STYLE: Record<IssueSeverity, StyleName> = {
  critical: 'brightRed',
  warning: 'yellow',
  info: 'blue',
};

const SEVERITY_MARK: Record<IssueSeverity, string> = {
  critical: '✖',
  warning: '▲',
  info: 'ℹ',
};

export interface PrettyOptions {
  /** How many issues to list. Default 8. */
  maxIssues?: number;
  /** Force colour on or off; defaults to TTY/NO_COLOR detection. */
  color?: boolean;
  /** Total width to lay out against. */
  width?: number;
}

/** Formats a run for a terminal. */
export function formatPretty(result: AuditRunResult, options: PrettyOptions = {}): string {
  const style = createStyle(options.color);
  const { scorecard } = result;
  const maxIssues = options.maxIssues ?? 8;
  const lines: string[] = [];

  lines.push('', style(rule(options.width), 'dim'));
  lines.push(...renderHeadline(result, style));
  lines.push(style(rule(options.width), 'dim'), '');

  lines.push(style('  FRICTION TAX', 'dim', 'bold'));
  lines.push(`  ${scorecard.benchmark.frictionTax.headline}`);
  lines.push(...renderBenchmark(scorecard, style));
  lines.push('');

  lines.push(style('  PILLARS', 'dim', 'bold'));
  lines.push(renderPillars(scorecard, style));
  lines.push('');

  if (scorecard.issues.length > 0) {
    const shown = scorecard.issues.slice(0, maxIssues);
    lines.push(style(`  TOP DEDUCTIONS  ${style(`(${scorecard.issues.length} total)`, 'dim')}`, 'dim', 'bold'));
    lines.push(renderIssues(shown, style));
    if (scorecard.issues.length > shown.length) {
      lines.push(style(`    …and ${scorecard.issues.length - shown.length} more`, 'dim'));
    }
    lines.push('');
  }

  lines.push(...renderVerdict(result, style));
  lines.push('');

  return lines.join('\n');
}

function renderHeadline(result: AuditRunResult, style: Style): string[] {
  const { scorecard } = result;
  const gradeStyle = GRADE_STYLE[scorecard.grade];
  const verdict = result.passed
    ? style(' PASS ', 'brightGreen', 'bold')
    : style(' FAIL ', 'brightRed', 'bold');

  return [
    `  ${style('AgentGrade', 'bold')}  ${style(result.url, 'cyan')}`,
    `  ${style(String(scorecard.overallScore).padStart(3), gradeStyle, 'bold')}${style('/100', 'dim')}` +
      `  ${style(scorecard.grade, gradeStyle, 'bold')}` +
      `  ${verdict}  ${style(`threshold ${result.threshold}`, 'dim')}` +
      `  ${style(`${(result.durationMs / 1000).toFixed(1)}s`, 'dim')}`,
  ];
}

function renderBenchmark(scorecard: AgentScorecard, style: Style): string[] {
  const { domTraversal, webMcpDirect } = scorecard.benchmark;
  const table = renderTable({
    style,
    indent: '  ',
    columns: [
      { header: 'MODE' },
      { header: 'STEPS', align: 'right' },
      { header: 'TOKENS', align: 'right' },
      { header: 'COST', align: 'right' },
      { header: 'LATENCY', align: 'right' },
      { header: 'FAIL RISK', align: 'right' },
    ],
    rows: [
      [
        style('DOM traversal', 'red'),
        String(domTraversal.steps),
        formatCompact(domTraversal.totalTokens),
        formatUsd(domTraversal.costUsd),
        `${(domTraversal.latencyMs / 1000).toFixed(1)}s`,
        `${(domTraversal.failureProbability * 100).toFixed(1)}%`,
      ],
      [
        style('WebMCP direct', 'green'),
        String(webMcpDirect.steps),
        formatCompact(webMcpDirect.totalTokens),
        formatUsd(webMcpDirect.costUsd),
        `${(webMcpDirect.latencyMs / 1000).toFixed(1)}s`,
        `${(webMcpDirect.failureProbability * 100).toFixed(1)}%`,
      ],
    ],
  });
  return ['', table];
}

function renderPillars(scorecard: AgentScorecard, style: Style): string {
  return renderTable({
    style,
    indent: '  ',
    columns: [
      { header: 'PILLAR', maxWidth: 32 },
      { header: '' },
      { header: 'EARNED', align: 'right' },
      { header: 'MAX', align: 'right' },
    ],
    rows: scorecard.pillars.map((pillar) => {
      const ratio = pillar.maxPoints > 0 ? pillar.weightedPoints / pillar.maxPoints : 0;
      return [
        pillar.label,
        style(renderBar(pillar.weightedPoints, pillar.maxPoints), barStyle(ratio)),
        pillar.weightedPoints.toFixed(1),
        String(pillar.maxPoints),
      ];
    }),
  });
}

function renderIssues(issues: AgentScorecard['issues'], style: Style): string {
  return renderTable({
    style,
    indent: '  ',
    columns: [
      { header: '' },
      { header: 'POINTS', align: 'right' },
      { header: 'ISSUE', maxWidth: 46 },
      { header: 'PILLAR' },
      { header: 'FIX', maxWidth: 44 },
    ],
    rows: issues.map((issue) => [
      style(SEVERITY_MARK[issue.severity], SEVERITY_STYLE[issue.severity]),
      issue.deductionPoints > 0
        ? style(`-${issue.deductionPoints.toFixed(2)}`, SEVERITY_STYLE[issue.severity])
        : style('—', 'dim'),
      issue.title,
      style(issue.pillar, 'dim'),
      style(truncate(issue.remediation, 44), 'dim'),
    ]),
  });
}

function renderVerdict(result: AuditRunResult, style: Style): string[] {
  const { scorecard } = result;

  if (result.passed) {
    return [
      `  ${style('✔', 'brightGreen')} ${scorecard.overallScore}/100 meets the threshold of ${result.threshold}.`,
    ];
  }

  const shortfall = (result.threshold - scorecard.overallScore).toFixed(0);
  const recoverable = scorecard.issues
    .slice(0, 3)
    .reduce((total, issue) => total + issue.deductionPoints, 0);

  return [
    `  ${style('✖', 'brightRed')} ${scorecard.overallScore}/100 is ${shortfall} point(s) below the threshold of ${result.threshold}.`,
    `  ${style(`Fixing the top 3 issues would recover ${recoverable.toFixed(1)} point(s).`, 'dim')}`,
  ];
}

function barStyle(ratio: number): StyleName {
  if (ratio >= 0.9) return 'brightGreen';
  if (ratio >= 0.7) return 'green';
  if (ratio >= 0.5) return 'yellow';
  return 'brightRed';
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}
