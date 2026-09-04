/**
 * AgentGrade — corpus rows.
 *
 * Flattens one audit into a single record suited to a spreadsheet: no nesting,
 * no arrays, one value per column. The point of a corpus run is a *distribution*
 * — how a metric varies across hundreds of sites — and that question is asked
 * of a table, not of a tree of JSON.
 *
 * Kept in the engine rather than the CLI because the mapping from
 * `AgentAuditRawData` to a column is a statement about the data model: when
 * `unlabelled_inputs` stops meaning "the count of `unlabelled-input` traps",
 * the fix belongs next to the type that changed, and a root-suite test catches
 * it there.
 */

import type { AgentAuditRawData, AuditReport, DescriptorProbe } from '../scanner/types.js';
import type { AgentScorecard, Grade, PillarId } from './types.js';

/**
 * How a scan of one site ended.
 *
 * Narrower than {@link AuditReport.status}, because the two ways a scan comes
 * back empty need different responses from whoever reads the CSV: a bot wall is
 * a site that refused *this* client and might yield to a different approach,
 * while an unreachable host is a row to drop from the sample. Lumping both into
 * `failed` would put a systematic bias in a corpus and hide it.
 *
 * `robots-disallowed` is a third kind again, and the most important one to keep
 * separate: the site was reachable and we chose not to look. Counting it as a
 * failure would understate coverage, and counting it as a scan would claim a
 * measurement that was never taken.
 */
export type CorpusStatus = 'ok' | 'partial' | 'bot-blocked' | 'robots-disallowed' | 'unreachable';

/** One row of a corpus scan. Every field is a scalar, ready for a CSV cell. */
export interface CorpusRow {
  /* Identity ------------------------------------------------------------- */
  domain: string;
  url: string;
  status: CorpusStatus;

  /* Score ---------------------------------------------------------------- */
  overall_score: number | null;
  letter_grade: Grade | null;

  /* Pillar sub-scores, each 0–100 within its own pillar ------------------- */
  discovery: number | null;
  actionability: number | null;
  friction_penalties: number | null;
  safety: number | null;

  /* Structural metrics — measurable on any site, today -------------------- */
  dom_nodes: number | null;
  unlabelled_inputs: number | null;
  non_semantic_clickables: number | null;
  iframes_count: number | null;
  friction_traps_count: number | null;

  /* WebMCP signals -------------------------------------------------------- */
  has_llms_txt: boolean | null;
  has_agent_json: boolean | null;
  has_mcp_manifest: boolean | null;
  tools_count: number | null;

  /* Economic model -------------------------------------------------------- */
  dom_tokens: number | null;
  dom_cost_usd: number | null;
  webmcp_tokens: number | null;
  webmcp_cost_usd: number | null;
  friction_tax_usd: number | null;
  latency_delta_sec: number | null;

  /* Provenance ------------------------------------------------------------ */
  scanned_at: string;
  duration_ms: number | null;
  /** Populated only when the scan could not be completed. */
  error: string | null;
}

/** Column order for the CSV. Also the canonical field order for a JSON dump. */
export const CORPUS_COLUMNS: ReadonlyArray<keyof CorpusRow> = [
  'domain',
  'url',
  'status',
  'overall_score',
  'letter_grade',
  'discovery',
  'actionability',
  'friction_penalties',
  'safety',
  'dom_nodes',
  'unlabelled_inputs',
  'non_semantic_clickables',
  'iframes_count',
  'friction_traps_count',
  'has_llms_txt',
  'has_agent_json',
  'has_mcp_manifest',
  'tools_count',
  'dom_tokens',
  'dom_cost_usd',
  'webmcp_tokens',
  'webmcp_cost_usd',
  'friction_tax_usd',
  'latency_delta_sec',
  'scanned_at',
  'duration_ms',
  'error',
];

/** Registrable-ish domain for grouping, falling back to the raw host. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** True when a descriptor of this kind was actually found. */
function foundDescriptor(descriptors: DescriptorProbe[], kind: DescriptorProbe['kind']): boolean {
  return descriptors.some((probe) => probe.kind === kind && probe.found);
}

/** The raw 0–100 score for one pillar, or `null` if the pillar is missing. */
function pillarScore(scorecard: AgentScorecard, id: PillarId): number | null {
  const pillar = scorecard.pillars.find((entry) => entry.pillar === id);
  return pillar ? round(pillar.rawScore, 1) : null;
}

/** Rounds for readability; a CSV of 14-decimal floats helps nobody. */
function round(value: number, places: number): number | null {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Classifies a completed scan.
 *
 * Order matters. A bot wall usually *also* leaves stages degraded, so it would
 * otherwise be reported as `partial` and silently pooled with sites that merely
 * timed out on one fetch — which is exactly the confusion this column exists to
 * prevent.
 */
export function classifyScan(report: AuditReport): CorpusStatus {
  const { navigation } = report.data;

  // Checked first: the scan stopped before a browser ran, so every other signal
  // below is absent by construction and would otherwise read as "unreachable".
  if (report.data.diagnostics.some((entry) => entry.code === 'robots-disallowed')) {
    return 'robots-disallowed';
  }

  if (navigation.botWallDetected) return 'bot-blocked';

  if (
    report.status === 'failed' ||
    navigation.status === 'network-error' ||
    navigation.status === 'timeout-hard' ||
    navigation.status === 'blocked'
  ) {
    return 'unreachable';
  }

  return report.status === 'ok' ? 'ok' : 'partial';
}

/**
 * Columns that describe the *site*, and are therefore meaningless when the site
 * was never seen.
 *
 * The scorer always returns a number — a page that never loaded scores 0 on
 * discovery and, perversely, **100 on friction**, because a document with no
 * elements has no traps in it. Left in the table, an unreachable host would
 * rank among the best sites in the corpus on that pillar, and any mean computed
 * over the column would be quietly wrong in a direction nobody would think to
 * check.
 *
 * So they are blanked rather than zeroed. An empty cell is honestly "not
 * measured"; a 0 or a 100 is a claim about a site that was never reached.
 */
const UNMEASURED_COLUMNS: ReadonlyArray<keyof CorpusRow> = [
  'overall_score',
  'letter_grade',
  'discovery',
  'actionability',
  'friction_penalties',
  'safety',
  'dom_tokens',
  'dom_cost_usd',
  'webmcp_tokens',
  'webmcp_cost_usd',
  'friction_tax_usd',
  'latency_delta_sec',
];

/** Structural counts, valid only for a document that actually rendered. */
const STRUCTURAL_COLUMNS: ReadonlyArray<keyof CorpusRow> = [
  'dom_nodes',
  'unlabelled_inputs',
  'non_semantic_clickables',
  'iframes_count',
  'friction_traps_count',
  'has_llms_txt',
  'has_agent_json',
  'has_mcp_manifest',
  'tools_count',
];

/**
 * Blanks the columns a given status cannot support.
 *
 * `unreachable` and `robots-disallowed` lose everything: nothing was measured,
 * in one case because nothing answered and in the other because we did not ask.
 * `bot-blocked` keeps its structural counts — the wall is a real document and
 * its shape is a real observation — but loses the score and the economics,
 * which would otherwise read as a verdict on a site the scanner never saw.
 */
function blankUnmeasured(row: CorpusRow): CorpusRow {
  if (row.status === 'ok' || row.status === 'partial') return row;

  const blanked: CorpusRow = { ...row };
  for (const column of UNMEASURED_COLUMNS) {
    (blanked as unknown as Record<string, unknown>)[column] = null;
  }
  if (row.status === 'unreachable' || row.status === 'robots-disallowed') {
    for (const column of STRUCTURAL_COLUMNS) {
      (blanked as unknown as Record<string, unknown>)[column] = null;
    }
  }
  return blanked;
}

/** Builds the row for a scan that completed far enough to be scored. */
export function toCorpusRow(
  requestedUrl: string,
  report: AuditReport,
  scorecard: AgentScorecard,
): CorpusRow {
  const data: AgentAuditRawData = report.data;
  const { summary, page, declarative } = data;
  const { domTraversal, webMcpDirect, frictionTax } = scorecard.benchmark;
  const finalUrl = data.navigation.finalUrl ?? requestedUrl;

  return blankUnmeasured({
    domain: domainOf(finalUrl),
    url: finalUrl,
    status: classifyScan(report),

    overall_score: scorecard.overallScore,
    letter_grade: scorecard.grade,

    discovery: pillarScore(scorecard, 'discovery'),
    actionability: pillarScore(scorecard, 'actionability'),
    friction_penalties: pillarScore(scorecard, 'friction'),
    safety: pillarScore(scorecard, 'safety'),

    dom_nodes: page.domNodeCount,
    // Read from the trap census rather than recounted here: the classifier that
    // decides what counts as unlabelled lives in the scanner, and a second
    // implementation would drift from it.
    unlabelled_inputs: summary.trapsByType['unlabelled-input'] ?? 0,
    non_semantic_clickables: summary.trapsByType['non-semantic-control'] ?? 0,
    iframes_count: page.iframeCount,
    friction_traps_count: summary.frictionTrapCount,

    has_llms_txt: summary.hasLlmsTxt,
    // Reported separately rather than as the summary's combined
    // `hasWellKnownManifest`: an agent card and a tool manifest are different
    // commitments, and which one a site published is the interesting signal.
    has_agent_json: foundDescriptor(declarative.descriptors, 'well-known-agent'),
    has_mcp_manifest: foundDescriptor(declarative.descriptors, 'well-known-mcp'),
    tools_count: summary.totalTools,

    dom_tokens: domTraversal.totalTokens,
    dom_cost_usd: round(domTraversal.costUsd, 4),
    webmcp_tokens: webMcpDirect.totalTokens,
    webmcp_cost_usd: round(webMcpDirect.costUsd, 4),
    friction_tax_usd: round(frictionTax.costWastedUsd, 4),
    latency_delta_sec: round(frictionTax.latencyWastedMs / 1000, 1),

    scanned_at: report.generatedAt,
    duration_ms: report.durationMs,
    error: errorFor(report),
  });
}

/** A one-line reason for a scan that did not come back clean. */
function errorFor(report: AuditReport): string | null {
  const status = classifyScan(report);
  if (status === 'ok' || status === 'partial') return null;
  const reason = report.data.navigation.error ?? `navigation ${report.data.navigation.status}`;
  return reason.split('\n')[0].slice(0, 300);
}

/**
 * Builds the row for a site that could not be scanned at all.
 *
 * Emitted rather than skipped. A corpus with silently missing rows invites the
 * reader to treat the survivors as the whole sample, and "12% of the Alexa top
 * 500 refused us" is itself a finding worth having in the table.
 */
export function toFailedRow(
  requestedUrl: string,
  error: string,
  status: CorpusStatus = 'unreachable',
): CorpusRow {
  const empty = Object.fromEntries(
    CORPUS_COLUMNS.map((column) => [column, null]),
  ) as unknown as CorpusRow;

  return {
    ...empty,
    domain: domainOf(requestedUrl),
    url: requestedUrl,
    status,
    scanned_at: new Date().toISOString(),
    duration_ms: null,
    error: error.split('\n')[0].slice(0, 300),
  };
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Escapes one CSV field per RFC 4180.
 *
 * Quoting is not optional here: a page title or an error message can carry a
 * comma, a quote, or a newline, and any of the three silently shifts every
 * later column in the row. A corpus whose columns are off by one is worse than
 * no corpus, because it still opens in a spreadsheet and still looks fine.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';

  const text = String(value);
  // Excel and Sheets treat a leading =, +, -, or @ as a formula. The scanned
  // URL and any error text come from the target, so a cell that starts with one
  // is neutralised with a leading apostrophe rather than executed on open.
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;

  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** The CSV header line. */
export function csvHeader(): string {
  return CORPUS_COLUMNS.join(',');
}

/** One row, in {@link CORPUS_COLUMNS} order. */
export function csvRow(row: CorpusRow): string {
  return CORPUS_COLUMNS.map((column) => csvField(row[column])).join(',');
}

/** A complete CSV document for a set of rows. */
export function toCsv(rows: CorpusRow[]): string {
  return [csvHeader(), ...rows.map(csvRow)].join('\n') + '\n';
}
