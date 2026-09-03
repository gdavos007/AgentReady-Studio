import { Coins, Gauge, MousePointer2, Timer, TriangleAlert, Zap } from 'lucide-react';

import type { BenchmarkComparison as Benchmark, BenchmarkMode } from '@/src/evals/types';

export interface BenchmarkComparisonProps {
  benchmark: Benchmark;
}

/**
 * The Agent Friction Tax banner plus the two-column DOM-vs-WebMCP comparison.
 *
 * This is the un-ignorable part of the report: it converts an abstract
 * readiness score into the money, seconds, and failure risk a site spends on
 * every agent-driven transaction. The stated assumptions are rendered too —
 * an estimate presented without them is a number nobody can argue with.
 */
export function BenchmarkComparison({ benchmark }: BenchmarkComparisonProps) {
  const { domTraversal, webMcpDirect, frictionTax } = benchmark;

  return (
    <section data-testid="benchmark" className="rounded-lg border border-line bg-panel">
      <div className="flex items-start gap-3 border-b border-line bg-[color-mix(in_srgb,var(--color-critical)_7%,transparent)] p-4">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-critical" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-wide text-critical uppercase">Agent Friction Tax</h2>
          <p className="mt-1 text-base leading-snug font-medium text-ink" data-testid="friction-tax-headline">
            {frictionTax.headline}
          </p>
          <p className="mt-1 text-xs text-ink-faint">
            Modelled for a single <span className="font-mono text-ink-muted">{benchmark.goal}</span> transaction
            {frictionTax.tokenMultiple !== null ? (
              <>
                {' '}
                · DOM traversal burns{' '}
                <span className="font-mono text-ink-muted">{frictionTax.tokenMultiple}×</span> the tokens
              </>
            ) : null}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 divide-y divide-line md:grid-cols-2 md:divide-x md:divide-y-0">
        <ModeColumn
          mode={domTraversal}
          title="DOM Traversal"
          subtitle="What an agent does today"
          icon={<MousePointer2 className="size-4" aria-hidden />}
          tone="bad"
        />
        <ModeColumn
          mode={webMcpDirect}
          title="WebMCP Direct"
          subtitle="What it would cost with tools"
          icon={<Zap className="size-4" aria-hidden />}
          tone="good"
        />
      </div>

      <details className="border-t border-line px-4 py-3">
        <summary className="cursor-pointer text-xs text-ink-faint transition-colors hover:text-ink-muted">
          Assumptions behind these numbers ({benchmark.assumptions.length})
        </summary>
        <ul className="mt-2 space-y-1">
          {benchmark.assumptions.map((assumption) => (
            <li key={assumption} className="text-xs leading-relaxed text-ink-faint">
              — {assumption}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

interface ModeColumnProps {
  mode: BenchmarkMode;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  tone: 'good' | 'bad';
}

function ModeColumn({ mode, title, subtitle, icon, tone }: ModeColumnProps) {
  const accent = tone === 'good' ? 'var(--color-grade-a)' : 'var(--color-grade-f)';

  return (
    <div className="p-4" data-testid={`benchmark-${mode.mode}`}>
      <div className="flex items-center gap-2">
        <span style={{ color: accent }}>{icon}</span>
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        <span className="ml-auto font-mono text-xs text-ink-faint tabular-nums">{mode.steps} steps</span>
      </div>
      <p className="mt-0.5 text-xs text-ink-faint">{subtitle}</p>

      <dl className="mt-4 grid grid-cols-2 gap-3">
        <Metric
          icon={<Coins className="size-3.5" aria-hidden />}
          label="Cost"
          value={formatUsd(mode.costUsd)}
          accent={accent}
        />
        <Metric
          icon={<Timer className="size-3.5" aria-hidden />}
          label="Latency"
          value={`${(mode.latencyMs / 1000).toFixed(1)}s`}
          accent={accent}
        />
        <Metric
          icon={<Gauge className="size-3.5" aria-hidden />}
          label="Tokens"
          value={formatCompact(mode.totalTokens)}
          accent={accent}
        />
        <Metric
          icon={<TriangleAlert className="size-3.5" aria-hidden />}
          label="Failure risk"
          value={`${(mode.failureProbability * 100).toFixed(1)}%`}
          accent={accent}
        />
      </dl>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="rounded-md border border-line bg-panel-raised px-3 py-2">
      <dt className="flex items-center gap-1.5 text-[11px] tracking-wide text-ink-faint uppercase">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 font-mono text-lg leading-none font-semibold tabular-nums" style={{ color: accent }}>
        {value}
      </dd>
    </div>
  );
}

/** Sub-cent costs need four decimals to say anything at all. */
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

export default BenchmarkComparison;
