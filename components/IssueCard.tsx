'use client';

import { AlertTriangle, ChevronRight, Info, OctagonAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { AuditIssue, IssueSeverity } from '@/src/evals/types';
import { piercesShadowDom } from '@/src/lib/codegen';

const SEVERITY_ICON: Record<IssueSeverity, LucideIcon> = {
  critical: OctagonAlert,
  warning: AlertTriangle,
  info: Info,
};

const SEVERITY_COLOR: Record<IssueSeverity, string> = {
  critical: 'var(--color-critical)',
  warning: 'var(--color-warning)',
  info: 'var(--color-info)',
};

export interface IssueCardProps {
  issue: AuditIssue;
  selected?: boolean;
  onSelect?: (issueId: string) => void;
}

/**
 * One row in the issue list.
 *
 * Leads with the deduction, because that is the number that decides what a
 * developer fixes first — the title alone cannot rank two criticals.
 */
export function IssueCard({ issue, selected = false, onSelect }: IssueCardProps) {
  const Icon = SEVERITY_ICON[issue.severity];
  const color = SEVERITY_COLOR[issue.severity];

  return (
    <button
      type="button"
      onClick={() => onSelect?.(issue.id)}
      aria-pressed={selected}
      data-testid={`issue-${issue.id}`}
      data-severity={issue.severity}
      data-pillar={issue.pillar}
      className={`flex w-full items-start gap-3 border-l-2 px-3 py-2.5 text-left transition-colors ${
        selected ? 'border-l-accent bg-panel-raised' : 'border-l-transparent hover:bg-panel-raised/60'
      }`}
    >
      <Icon className="mt-0.5 size-4 shrink-0" style={{ color }} aria-hidden />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <h4 className="truncate text-sm font-medium text-ink">{issue.title}</h4>
          {issue.deductionPoints > 0 ? (
            <span
              className="ml-auto shrink-0 font-mono text-xs font-semibold tabular-nums"
              style={{ color }}
              title={`Costs ${issue.deductionPoints} of the 100 available points`}
            >
              −{issue.deductionPoints.toFixed(2)}
            </span>
          ) : (
            <span className="ml-auto shrink-0 font-mono text-xs text-ink-faint">no deduction</span>
          )}
        </div>

        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-muted">{issue.impactDescription}</p>

        {issue.relatedSelectors.length > 0 ? (
          <p className="mt-1.5 truncate font-mono text-[11px] text-ink-faint">
            <SelectorPreview selector={issue.relatedSelectors[0]} />
            {issue.relatedSelectors.length > 1 ? (
              <span className="text-ink-faint"> +{issue.relatedSelectors.length - 1} more</span>
            ) : null}
          </p>
        ) : null}
      </div>

      <ChevronRight className="mt-0.5 size-4 shrink-0 text-ink-faint" aria-hidden />
    </button>
  );
}

/**
 * Renders a selector, marking a shadow-DOM crossing.
 *
 * `>>>` is the single most important detail in a selector: it means
 * `document.querySelector` will not find the element, so a developer copying it
 * into the console gets `null` and concludes the audit is wrong.
 */
export function SelectorPreview({ selector }: { selector: string }) {
  if (!piercesShadowDom(selector)) return <span>{selector}</span>;

  const segments = selector.split('>>>');
  return (
    <span data-testid="shadow-selector">
      {segments.map((segment, index) => (
        <span key={index}>
          {index > 0 ? (
            <span
              className="mx-1 rounded-sm bg-[color-mix(in_srgb,var(--color-accent)_25%,transparent)] px-1 text-accent-bright"
              title="Crosses a shadow root — document.querySelector cannot reach past this"
            >
              &gt;&gt;&gt;
            </span>
          ) : null}
          {segment.trim()}
        </span>
      ))}
    </span>
  );
}

export default IssueCard;
