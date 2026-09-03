import { Compass, MousePointerClick, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { PillarId, PillarScore } from '@/src/evals/types';

const PILLAR_ICONS: Record<PillarId, LucideIcon> = {
  discovery: Compass,
  actionability: MousePointerClick,
  friction: TriangleAlert,
  safety: ShieldCheck,
};

/** One-line statement of what each pillar is actually asking. */
const PILLAR_QUESTIONS: Record<PillarId, string> = {
  discovery: 'Can an agent find out what this site does before touching the DOM?',
  actionability: 'Can an agent perform the page’s core actions without driving raw DOM?',
  friction: 'How much of the page actively fights an agent?',
  safety: 'Can an agent call these tools correctly and safely, first try?',
};

/** Ratio → bar colour. Uses the grade palette so the whole page reads alike. */
function barColor(ratio: number): string {
  if (ratio >= 0.9) return 'var(--color-grade-a)';
  if (ratio >= 0.8) return 'var(--color-grade-b)';
  if (ratio >= 0.7) return 'var(--color-grade-c)';
  if (ratio >= 0.6) return 'var(--color-grade-d)';
  return 'var(--color-grade-f)';
}

export interface PillarBreakdownProps {
  pillars: PillarScore[];
  /** Called when a pillar card is activated, to filter the issue list. */
  onSelectPillar?: (pillar: PillarId) => void;
  /** Currently filtered pillar, highlighted. */
  activePillar?: PillarId | null;
}

/**
 * The four-card pillar grid.
 *
 * Each card shows the pillar's earned/max contribution to the overall 100, and
 * every scored component beneath it — so a reader can see not just that
 * Actionability lost 9 points, but which of its four line items lost them.
 */
export function PillarBreakdown({ pillars, onSelectPillar, activePillar }: PillarBreakdownProps) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4" data-testid="pillar-grid">
      {pillars.map((pillar) => {
        const Icon = PILLAR_ICONS[pillar.pillar];
        const ratio = pillar.maxPoints > 0 ? pillar.weightedPoints / pillar.maxPoints : 0;
        const isActive = activePillar === pillar.pillar;

        return (
          <button
            key={pillar.pillar}
            type="button"
            onClick={() => onSelectPillar?.(pillar.pillar)}
            aria-pressed={isActive}
            data-testid={`pillar-${pillar.pillar}`}
            className={`group flex flex-col rounded-lg border bg-panel p-4 text-left transition-colors ${
              isActive ? 'border-accent' : 'border-line hover:border-line-bright'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <Icon className="size-4 shrink-0 text-ink-faint" aria-hidden />
                <h3 className="text-sm leading-tight font-medium text-ink">{pillar.label}</h3>
              </div>
              <span className="shrink-0 font-mono text-xs whitespace-nowrap text-ink-muted tabular-nums">
                {pillar.weightedPoints.toFixed(1)}
                <span className="text-ink-faint"> / {pillar.maxPoints}</span>
              </span>
            </div>

            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full transition-[width] duration-700 ease-out"
                style={{ width: `${Math.round(ratio * 100)}%`, background: barColor(ratio) }}
              />
            </div>

            <p className="mt-3 text-xs leading-relaxed text-ink-faint">{PILLAR_QUESTIONS[pillar.pillar]}</p>

            <dl className="mt-3 space-y-1.5 border-t border-line pt-3">
              {pillar.components.map((component) => {
                const componentRatio = component.possible > 0 ? component.earned / component.possible : 0;
                return (
                  <div key={component.id} className="flex items-center justify-between gap-2 text-xs">
                    <dt className="truncate text-ink-muted" title={component.detail}>
                      {component.label}
                    </dt>
                    <dd
                      className="shrink-0 font-mono tabular-nums"
                      style={{ color: componentRatio >= 0.999 ? 'var(--color-grade-a)' : 'var(--color-ink-faint)' }}
                    >
                      {round1(component.earned)}/{component.possible}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </button>
        );
      })}
    </div>
  );
}

function round1(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export default PillarBreakdown;
