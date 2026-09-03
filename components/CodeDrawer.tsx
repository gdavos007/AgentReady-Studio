'use client';

import { Check, Copy, FileCode2, Target, TrendingDown, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { AuditIssue, SyntheticEvaluation } from '@/src/evals/types';
import type { RemediationBundle, RemediationTabId } from '@/src/lib/codegen';
import { highlightLines } from '@/src/lib/highlight';
import { SelectorPreview } from './IssueCard';

export interface CodeDrawerProps {
  issue: AuditIssue | null;
  bundle: RemediationBundle | null;
  /** The scorecard's exact total, so the deduction can be shown in context. */
  overallScore: number;
  syntheticEvaluation: SyntheticEvaluation | null;
  onClose: () => void;
  /** Controlled active tab, so an agent tool can drive it. */
  activeTab?: RemediationTabId;
  onTabChange?: (tab: RemediationTabId) => void;
}

/**
 * The remediation drawer.
 *
 * Two halves: *why this is a finding* (root-cause selectors, the exact points
 * it costs, what the synthetic agent actually did) and *how to fix it* — three
 * copyable code tabs generated from this site's own scan.
 */
export function CodeDrawer({
  issue,
  bundle,
  overallScore,
  syntheticEvaluation,
  onClose,
  activeTab,
  onTabChange,
}: CodeDrawerProps) {
  const [internalTab, setInternalTab] = useState<RemediationTabId>('browser-native');
  const tab = activeTab ?? internalTab;
  const selectTab = (next: RemediationTabId): void => {
    setInternalTab(next);
    onTabChange?.(next);
  };

  // Escape closes the drawer — a keyboard-reachable exit is the minimum for a
  // panel that covers the list it was opened from.
  useEffect(() => {
    if (!issue) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [issue, onClose]);

  if (!issue || !bundle) {
    return (
      <div
        className="flex h-full items-center justify-center p-8 text-center"
        data-testid="code-drawer-empty"
      >
        <div className="max-w-xs">
          <FileCode2 className="mx-auto size-6 text-ink-faint" aria-hidden />
          <p className="mt-3 text-sm text-ink-muted">Select an issue to see why it costs points</p>
          <p className="mt-1 text-xs text-ink-faint">
            and the drop-in WebMCP code that resolves it.
          </p>
        </div>
      </div>
    );
  }

  const activeTabData = bundle.tabs.find((entry) => entry.id === tab) ?? bundle.tabs[0];
  const scoreWithoutIssue = Math.min(100, overallScore + issue.deductionPoints);

  return (
    <div className="flex h-full flex-col" data-testid="code-drawer">
      <header className="flex items-start gap-3 border-b border-line p-4">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] text-ink-faint">{issue.id}</p>
          <h3 className="mt-0.5 text-base leading-snug font-semibold text-ink">{issue.title}</h3>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{issue.impactDescription}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close remediation drawer"
          className="rounded-md p-1 text-ink-faint transition-colors hover:bg-panel-raised hover:text-ink"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <section className="space-y-3 border-b border-line p-4">
          <DetailRow icon={<TrendingDown className="size-3.5" aria-hidden />} label="Deduction impact">
            <span className="font-mono tabular-nums">
              <span style={{ color: 'var(--color-critical)' }}>−{issue.deductionPoints.toFixed(2)}</span>
              <span className="text-ink-faint"> pts · </span>
              <span className="text-ink-muted">
                {overallScore.toFixed(0)} → {scoreWithoutIssue.toFixed(0)} if fixed
              </span>
            </span>
            <p className="mt-1 text-xs text-ink-faint">
              Charged against <span className="text-ink-muted">{issue.pillar}</span>
              {issue.componentId ? (
                <>
                  {' · '}
                  <span className="font-mono text-ink-muted">{issue.componentId}</span>
                </>
              ) : null}
            </p>
          </DetailRow>

          <DetailRow icon={<Target className="size-3.5" aria-hidden />} label="Root cause">
            {issue.relatedSelectors.length === 0 ? (
              <span className="text-xs text-ink-faint">
                Site-wide finding — no single element is responsible.
              </span>
            ) : (
              <ul className="space-y-1">
                {issue.relatedSelectors.slice(0, 6).map((selector) => (
                  <li key={selector} className="font-mono text-[11px] leading-relaxed break-all text-ink-muted">
                    <SelectorPreview selector={selector} />
                  </li>
                ))}
                {issue.relatedSelectors.length > 6 ? (
                  <li className="text-[11px] text-ink-faint">
                    +{issue.relatedSelectors.length - 6} more element(s)
                  </li>
                ) : null}
              </ul>
            )}
          </DetailRow>

          <AgentTrace evaluation={syntheticEvaluation} />
        </section>

        <section className="p-4">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-xs font-semibold tracking-wider text-ink-faint uppercase">Remediation</h4>
            <span className="font-mono text-[11px] text-ink-faint">{bundle.kind}</span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{bundle.summary}</p>

          <div className="mt-3 flex gap-1 rounded-md border border-line bg-panel p-1" role="tablist">
            {bundle.tabs.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={entry.id === tab}
                onClick={() => selectTab(entry.id)}
                data-testid={`tab-${entry.id}`}
                className={`flex-1 rounded px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  entry.id === tab
                    ? 'bg-panel-raised text-ink'
                    : 'text-ink-faint hover:text-ink-muted'
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {activeTabData ? (
            <>
              <p className="mt-3 text-xs leading-relaxed text-ink-faint">{activeTabData.explanation}</p>
              <CodeBlock
                code={activeTabData.code}
                language={activeTabData.language}
                filename={activeTabData.filename}
              />
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function DetailRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-[11px] font-medium tracking-wider text-ink-faint uppercase">
        {icon}
        {label}
      </p>
      <div className="mt-1.5 text-sm text-ink">{children}</div>
    </div>
  );
}

/**
 * What the synthetic agent actually did against this target.
 *
 * A trace beats an assertion: "the agent picked `search_products` and it
 * returned" is checkable, and "no tool matched, here is the 14-step DOM plan it
 * fell back to" is the argument for the whole report.
 */
function AgentTrace({ evaluation }: { evaluation: SyntheticEvaluation | null }) {
  if (!evaluation) return null;

  const attempt = evaluation.attempts[0];

  return (
    <DetailRow icon={<FileCode2 className="size-3.5" aria-hidden />} label="Synthetic agent trace">
      <div className="rounded-md border border-line bg-panel-raised p-3" data-testid="agent-trace">
        <p className="text-xs text-ink-muted">
          Goal <span className="font-mono text-ink">“{evaluation.goal}”</span> ·{' '}
          <span className={evaluation.mode === 'webmcp-direct' ? 'text-grade-a' : 'text-grade-f'}>
            {evaluation.mode}
          </span>
          {evaluation.live ? <span className="text-ink-faint"> · live invocation</span> : null}
        </p>

        {attempt ? (
          <div className="mt-2 space-y-1 font-mono text-[11px]">
            <p className="text-ink-muted">
              → {attempt.toolName}(
              {Object.entries(attempt.arguments)
                .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
                .join(', ')}
              )
            </p>
            <p className={attempt.error ? 'text-critical' : 'text-ink-faint'}>
              ← {attempt.execution}
              {attempt.error ? `: ${attempt.error}` : ''}
              {attempt.result ? `: ${JSON.stringify(attempt.result).slice(0, 120)}` : ''}
            </p>
          </div>
        ) : null}

        {evaluation.plan.length > 0 ? (
          <ol className="mt-2 space-y-1">
            {evaluation.plan.slice(0, 6).map((step) => (
              <li key={step.order} className="flex items-baseline gap-2 font-mono text-[11px]">
                <span className="w-4 shrink-0 text-right text-ink-faint tabular-nums">{step.order}</span>
                <span className="text-accent-bright">{step.action}</span>
                <span className="min-w-0 flex-1 truncate text-ink-muted">{step.intent}</span>
                {step.riskScore > 0.1 ? (
                  <span className="shrink-0 text-critical tabular-nums">
                    {(step.riskScore * 100).toFixed(0)}% risk
                  </span>
                ) : null}
              </li>
            ))}
            {evaluation.plan.length > 6 ? (
              <li className="pl-6 text-[11px] text-ink-faint">
                +{evaluation.plan.length - 6} more step(s)
              </li>
            ) : null}
          </ol>
        ) : null}

        <p className="mt-2 text-xs leading-relaxed text-ink-faint">{evaluation.reasoning}</p>
      </div>
    </DetailRow>
  );
}

/* -------------------------------------------------------------------------- */
/* Code block                                                                  */
/* -------------------------------------------------------------------------- */

export interface CodeBlockProps {
  code: string;
  language: Parameters<typeof highlightLines>[1];
  filename: string;
}

/** A syntax-highlighted, line-numbered, copyable snippet. */
export function CodeBlock({ code, language, filename }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const lines = useMemo(() => highlightLines(code, language), [code, language]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access is denied in some embedded contexts; the code is
      // still selectable, so fail quietly rather than throwing at the user.
      setCopied(false);
    }
  };

  return (
    <figure className="mt-2 overflow-hidden rounded-md border border-line bg-panel" data-testid="code-block">
      <figcaption className="flex items-center justify-between border-b border-line bg-panel-raised px-3 py-1.5">
        <span className="font-mono text-[11px] text-ink-faint">{filename}</span>
        <button
          type="button"
          onClick={copy}
          data-testid="copy-code"
          aria-label={`Copy ${filename}`}
          className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] text-ink-faint transition-colors hover:bg-panel hover:text-ink"
        >
          {copied ? (
            <>
              <Check className="size-3" aria-hidden /> Copied
            </>
          ) : (
            <>
              <Copy className="size-3" aria-hidden /> Copy
            </>
          )}
        </button>
      </figcaption>

      <pre className="overflow-x-auto p-3 font-mono text-[11.5px] leading-relaxed">
        <code>
          {lines.map((tokens, lineIndex) => (
            <span key={lineIndex} className="flex">
              <span className="mr-3 w-7 shrink-0 text-right text-ink-faint select-none tabular-nums">
                {lineIndex + 1}
              </span>
              <span className="min-w-0 whitespace-pre">
                {tokens.map((token, tokenIndex) => (
                  <span key={tokenIndex} className={`tok-${token.type}`}>
                    {token.value}
                  </span>
                ))}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
}

export default CodeDrawer;
