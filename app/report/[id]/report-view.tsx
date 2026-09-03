'use client';

import { Filter } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { BenchmarkComparison } from '@/components/BenchmarkComparison';
import { CodeDrawer } from '@/components/CodeDrawer';
import { IssueCard } from '@/components/IssueCard';
import { PillarBreakdown } from '@/components/PillarBreakdown';
import { ScoreGauge } from '@/components/ScoreGauge';
import { useStudioWebMCP, type IssueFilter } from '@/hooks/useStudioWebMCP';
import type { AgentScorecard, IssueSeverity, PillarId } from '@/src/evals/types';
import type { RemediationBundle, RemediationTabId } from '@/src/lib/codegen';

export interface ReportViewProps {
  scorecard: AgentScorecard;
  /** Pre-generated remediation bundles, keyed by issue id. */
  remediations: Record<string, RemediationBundle>;
  url: string;
  scanStatus: 'ok' | 'partial' | 'failed';
  scanDurationMs: number;
}

const SEVERITY_TABS: ReadonlyArray<IssueSeverity | 'all'> = ['all', 'critical', 'warning', 'info'];

/**
 * The interactive half of the report.
 *
 * Holds the filter and selection state, renders the scorecard, and registers
 * the studio's own WebMCP tools so a browser agent can drive the same state a
 * human clicks through.
 */
export function ReportView({ scorecard, remediations, url, scanStatus, scanDurationMs }: ReportViewProps) {
  const [filter, setFilter] = useState<IssueFilter>({ severity: 'all', pillar: 'all' });
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(
    scorecard.issues[0]?.id ?? null,
  );
  const [activeTab, setActiveTab] = useState<RemediationTabId>('browser-native');

  const visibleIssues = useMemo(
    () =>
      scorecard.issues.filter(
        (issue) =>
          (filter.severity === 'all' || issue.severity === filter.severity) &&
          (filter.pillar === 'all' || issue.pillar === filter.pillar),
      ),
    [scorecard.issues, filter],
  );

  const selectedIssue = useMemo(
    () => scorecard.issues.find((issue) => issue.id === selectedIssueId) ?? null,
    [scorecard.issues, selectedIssueId],
  );

  const remediationFor = useCallback(
    (issueId: string): RemediationBundle | null => remediations[issueId] ?? null,
    [remediations],
  );

  useStudioWebMCP({
    scorecard,
    visibleIssues,
    filter,
    selectedIssueId,
    onFilterChange: setFilter,
    onSelectIssue: setSelectedIssueId,
    onTabChange: setActiveTab,
    remediationFor,
  });

  const severityCounts = useMemo(() => {
    const counts: Record<string, number> = { all: scorecard.issues.length };
    for (const issue of scorecard.issues) counts[issue.severity] = (counts[issue.severity] ?? 0) + 1;
    return counts;
  }, [scorecard.issues]);

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-8">
      {scanStatus !== 'ok' ? (
        <p
          role="status"
          className="mb-6 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          The scan completed with status <span className="font-mono">{scanStatus}</span> — some stages degraded.
          See the scan diagnostics in the issue list below.
        </p>
      ) : null}

      <section className="flex flex-col items-start gap-8 lg:flex-row lg:items-center">
        <ScoreGauge
          score={scorecard.overallScore}
          grade={scorecard.grade}
          label={`${scorecard.summary.toolCount} tool(s) · ${scorecard.summary.frictionTrapCount} trap(s)`}
        />

        <div className="min-w-0 flex-1">
          <h1 className="text-2xl leading-tight font-semibold tracking-tight text-ink">
            Agent readiness for <span className="font-mono text-ink-muted">{hostOf(url)}</span>
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
            {scorecard.summary.coveredCriticalSurfaceCount} of {scorecard.summary.criticalSurfaceCount} critical
            surface(s) are backed by a registered tool
            {scorecard.summary.domOnlyCriticalSurfaceCount > 0 ? (
              <>
                {' '}
                — {scorecard.summary.domOnlyCriticalSurfaceCount} can only be driven through raw DOM
              </>
            ) : null}
            . Scanned in {(scanDurationMs / 1000).toFixed(1)}s.
          </p>

          <div className="mt-4">
            <BenchmarkComparison benchmark={scorecard.benchmark} />
          </div>
        </div>
      </section>

      <section className="mt-8">
        <PillarBreakdown
          pillars={scorecard.pillars}
          activePillar={filter.pillar === 'all' ? null : filter.pillar}
          onSelectPillar={(pillar: PillarId) =>
            setFilter((previous) => ({
              ...previous,
              pillar: previous.pillar === pillar ? 'all' : pillar,
            }))
          }
        />
      </section>

      <section className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="overflow-hidden rounded-lg border border-line bg-panel">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Filter className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
            <div className="flex gap-1" role="tablist" aria-label="Filter issues by severity">
              {SEVERITY_TABS.map((severity) => (
                <button
                  key={severity}
                  type="button"
                  role="tab"
                  aria-selected={filter.severity === severity}
                  data-testid={`filter-${severity}`}
                  onClick={() => setFilter((previous) => ({ ...previous, severity }))}
                  className={`rounded px-2 py-1 text-xs font-medium capitalize transition-colors ${
                    filter.severity === severity
                      ? 'bg-panel-raised text-ink'
                      : 'text-ink-faint hover:text-ink-muted'
                  }`}
                >
                  {severity}
                  <span className="ml-1.5 font-mono text-ink-faint tabular-nums">
                    {severityCounts[severity] ?? 0}
                  </span>
                </button>
              ))}
            </div>
            {filter.pillar !== 'all' ? (
              <button
                type="button"
                onClick={() => setFilter((previous) => ({ ...previous, pillar: 'all' }))}
                className="ml-auto rounded bg-accent/15 px-2 py-1 font-mono text-xs text-accent-bright transition-colors hover:bg-accent/25"
              >
                {filter.pillar} ✕
              </button>
            ) : null}
          </div>

          <div className="max-h-[70vh] divide-y divide-line overflow-y-auto" data-testid="issue-list">
            {visibleIssues.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-ink-faint">
                No issues match this filter.
              </p>
            ) : (
              visibleIssues.map((issue) => (
                <IssueCard
                  key={issue.id}
                  issue={issue}
                  selected={issue.id === selectedIssueId}
                  onSelect={setSelectedIssueId}
                />
              ))
            )}
          </div>
        </div>

        <div className="max-h-[70vh] overflow-hidden rounded-lg border border-line bg-panel">
          <CodeDrawer
            issue={selectedIssue}
            bundle={selectedIssue ? remediationFor(selectedIssue.id) : null}
            overallScore={scorecard.overallScoreExact}
            syntheticEvaluation={scorecard.syntheticEvaluation}
            onClose={() => setSelectedIssueId(null)}
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />
        </div>
      </section>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
