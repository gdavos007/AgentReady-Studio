import type { Grade } from '@/src/shared/grade';

/** Stroke colour per grade band, matching the tokens in globals.css. */
const GRADE_COLOR: Record<Grade, string> = {
  A: 'var(--color-grade-a)',
  B: 'var(--color-grade-b)',
  C: 'var(--color-grade-c)',
  D: 'var(--color-grade-d)',
  F: 'var(--color-grade-f)',
};

export interface ScoreGaugeProps {
  /** 0–100. Values outside the range are clamped. */
  score: number;
  grade: Grade;
  /** Outer diameter in pixels. Default 176. */
  size?: number;
  /** Ring thickness in pixels. Default 12. */
  strokeWidth?: number;
  /** Caption under the number. */
  label?: string;
}

/**
 * The Lighthouse-style headline gauge.
 *
 * A pure SVG arc — no chart library, no canvas, and no client component, so it
 * renders on the server and is present in the HTML an agent (or a crawler)
 * reads. The score is exposed as text inside the SVG rather than only as an
 * arc, so it survives being read without styles.
 */
export function ScoreGauge({ score, grade, size = 176, strokeWidth = 12, label }: ScoreGaugeProps) {
  const bounded = Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 0;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  // Leave a 25% gap at the bottom so the arc reads as a gauge, not a pie.
  const arcSpan = circumference * 0.75;
  const filled = arcSpan * (bounded / 100);
  const color = GRADE_COLOR[grade];

  return (
    <div className="relative inline-flex flex-col items-center" data-testid="score-gauge">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`AgentGrade score ${Math.round(bounded)} out of 100, grade ${grade}`}
        // Start the sweep at 7:30 so the 90° gap sits centred at the bottom,
        // the way a dial reads.
        className="rotate-[135deg]"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-line)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${arcSpan} ${circumference}`}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
          style={{ transition: 'stroke-dasharray 700ms cubic-bezier(0.16, 1, 0.3, 1)' }}
        />
      </svg>

      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span
          className="font-mono text-5xl leading-none font-semibold tabular-nums"
          style={{ color }}
          data-testid="score-value"
        >
          {Math.round(bounded)}
        </span>
        <span className="mt-1 text-xs tracking-widest text-ink-faint uppercase">out of 100</span>
      </div>

      <div className="mt-3 flex items-baseline gap-2">
        <span
          className="font-mono text-2xl leading-none font-bold"
          style={{ color }}
          data-testid="score-grade"
        >
          {grade}
        </span>
        {label ? <span className="text-sm text-ink-muted">{label}</span> : null}
      </div>
    </div>
  );
}

export default ScoreGauge;
