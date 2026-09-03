/**
 * AgentGrade — the single source of truth for letter grades.
 *
 * Both the Phase 1 scanner summary and the Phase 2 scorecard grade on this
 * scale, so a grade shown by the CLI, the API, and the studio always means the
 * same thing. Changing a band here changes it everywhere.
 */

/** Letter grade bands. A: 90–100, B: 80–89, C: 70–79, D: 60–69, F: <60. */
export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

/** Every grade, best first. */
export const GRADES: readonly Grade[] = ['A', 'B', 'C', 'D', 'F'];

/** Lower bound of each grade band, highest first. */
export const GRADE_BANDS: ReadonlyArray<{ grade: Grade; min: number }> = [
  { grade: 'A', min: 90 },
  { grade: 'B', min: 80 },
  { grade: 'C', min: 70 },
  { grade: 'D', min: 60 },
  { grade: 'F', min: 0 },
];

/**
 * Maps a 0–100 score to its letter grade.
 *
 * Scores outside the range saturate at the nearer bound; `NaN` — which carries
 * no ordering — grades as `F`.
 */
export function gradeFor(score: number): Grade {
  if (Number.isNaN(score)) return 'F';
  const bounded = Math.min(100, Math.max(0, score));
  for (const band of GRADE_BANDS) {
    if (bounded >= band.min) return band.grade;
  }
  return 'F';
}

/** Human-readable band description, e.g. `"B (80–89)"`. */
export function describeGrade(grade: Grade): string {
  const index = GRADE_BANDS.findIndex((band) => band.grade === grade);
  const band = GRADE_BANDS[index];
  if (!band) return grade;
  const upper = index === 0 ? 100 : GRADE_BANDS[index - 1].min - 1;
  return `${grade} (${band.min}–${upper})`;
}
