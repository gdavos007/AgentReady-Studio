/**
 * AgentGrade Studio — local report storage.
 *
 * Backed by SQLite through Node's built-in `node:sqlite`, so a local install
 * needs no native build step, no daemon, and no cloud service. When the runtime
 * does not expose `node:sqlite` (Node < 22.5, or an edge runtime) the store
 * degrades to an in-process map with the same interface, which is enough for
 * tests and for a single dev session.
 */

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import type { AuditReport } from '../scanner/types.js';
import type { AgentScorecard } from '../evals/types.js';
import type { Grade } from '../shared/grade.js';

/** A persisted audit: the raw scan plus its scorecard. */
export interface StoredReport {
  id: string;
  createdAt: string;
  url: string;
  /** Scan status, mirrored from {@link AuditReport.status}. */
  status: AuditReport['status'];
  grade: Grade;
  score: number;
  report: AuditReport;
  scorecard: AgentScorecard;
}

/** Row shape for listings, without the heavyweight JSON payloads. */
export interface StoredReportSummary {
  id: string;
  createdAt: string;
  url: string;
  status: AuditReport['status'];
  grade: Grade;
  score: number;
  toolCount: number;
  issueCount: number;
  frictionTrapCount: number;
}

/** Storage contract, so the backend can be swapped without touching callers. */
export interface ReportStore {
  save(record: Omit<StoredReport, 'createdAt'> & { createdAt?: string }): StoredReport;
  get(id: string): StoredReport | null;
  list(limit?: number): StoredReportSummary[];
  delete(id: string): boolean;
  clear(): void;
  close(): void;
  /** Which backend actually loaded. */
  readonly backend: 'sqlite' | 'memory';
}

/** Default on-disk location, relative to the project root. */
export const DEFAULT_DATABASE_PATH = '.agentgrade/reports.db';

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    url TEXT NOT NULL,
    status TEXT NOT NULL,
    grade TEXT NOT NULL,
    score REAL NOT NULL,
    tool_count INTEGER NOT NULL,
    issue_count INTEGER NOT NULL,
    friction_trap_count INTEGER NOT NULL,
    report_json TEXT NOT NULL,
    scorecard_json TEXT NOT NULL
  );
`;

const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS reports_created_at ON reports (created_at DESC);`;

interface SqliteRow {
  id: string;
  created_at: string;
  url: string;
  status: string;
  grade: string;
  score: number;
  tool_count: number;
  issue_count: number;
  friction_trap_count: number;
  report_json: string;
  scorecard_json: string;
}

/**
 * Opens a report store.
 *
 * @param databasePath `':memory:'` for an ephemeral database, or a file path.
 *   Parent directories are created as needed.
 */
export function openReportStore(databasePath: string = DEFAULT_DATABASE_PATH): ReportStore {
  const sqlite = loadSqlite();
  if (!sqlite) return createMemoryStore();

  let database: SqliteDatabase;
  try {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    }
    database = new sqlite.DatabaseSync(databasePath === ':memory:' ? ':memory:' : resolve(databasePath));
    database.exec(CREATE_TABLE);
    database.exec(CREATE_INDEX);
  } catch {
    // A read-only or otherwise unusable filesystem must not take the studio
    // down; an in-process store still serves the session.
    return createMemoryStore();
  }

  const toStored = (row: SqliteRow): StoredReport => ({
    id: row.id,
    createdAt: row.created_at,
    url: row.url,
    status: row.status as AuditReport['status'],
    grade: row.grade as Grade,
    score: row.score,
    report: JSON.parse(row.report_json) as AuditReport,
    scorecard: JSON.parse(row.scorecard_json) as AgentScorecard,
  });

  return {
    backend: 'sqlite',

    save(record) {
      const createdAt = record.createdAt ?? new Date().toISOString();
      database
        .prepare(
          `INSERT OR REPLACE INTO reports
             (id, created_at, url, status, grade, score, tool_count, issue_count, friction_trap_count, report_json, scorecard_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          createdAt,
          record.url,
          record.status,
          record.grade,
          record.score,
          record.scorecard.summary.toolCount,
          record.scorecard.issues.length,
          record.scorecard.summary.frictionTrapCount,
          JSON.stringify(record.report),
          JSON.stringify(record.scorecard),
        );
      return { ...record, createdAt };
    },

    get(id) {
      const row = database.prepare('SELECT * FROM reports WHERE id = ?').get(id) as SqliteRow | undefined;
      return row ? toStored(row) : null;
    },

    list(limit = 20) {
      const rows = database
        .prepare(
          `SELECT id, created_at, url, status, grade, score, tool_count, issue_count, friction_trap_count
             FROM reports ORDER BY created_at DESC LIMIT ?`,
        )
        .all(Math.max(1, Math.min(200, limit))) as Array<Omit<SqliteRow, 'report_json' | 'scorecard_json'>>;
      return rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        url: row.url,
        status: row.status as AuditReport['status'],
        grade: row.grade as Grade,
        score: row.score,
        toolCount: row.tool_count,
        issueCount: row.issue_count,
        frictionTrapCount: row.friction_trap_count,
      }));
    },

    delete(id) {
      const result = database.prepare('DELETE FROM reports WHERE id = ?').run(id);
      return Number(result.changes ?? 0) > 0;
    },

    clear() {
      database.exec('DELETE FROM reports');
    },

    close() {
      try {
        database.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Fallback backend                                                            */
/* -------------------------------------------------------------------------- */

function createMemoryStore(): ReportStore {
  const rows = new Map<string, StoredReport>();
  return {
    backend: 'memory',
    save(record) {
      const stored: StoredReport = { ...record, createdAt: record.createdAt ?? new Date().toISOString() };
      rows.set(stored.id, stored);
      return stored;
    },
    get: (id) => rows.get(id) ?? null,
    list(limit = 20) {
      return Array.from(rows.values())
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, Math.max(1, limit))
        .map((entry) => ({
          id: entry.id,
          createdAt: entry.createdAt,
          url: entry.url,
          status: entry.status,
          grade: entry.grade,
          score: entry.score,
          toolCount: entry.scorecard.summary.toolCount,
          issueCount: entry.scorecard.issues.length,
          frictionTrapCount: entry.scorecard.summary.frictionTrapCount,
        }));
    },
    delete: (id) => rows.delete(id),
    clear: () => rows.clear(),
    close: () => rows.clear(),
  };
}

/* -------------------------------------------------------------------------- */
/* node:sqlite loading                                                         */
/* -------------------------------------------------------------------------- */

interface SqliteStatement {
  run(...parameters: unknown[]): { changes?: number | bigint };
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

/**
 * `node:sqlite` is built in from Node 22.5. It emits an experimental warning on
 * first use, which we suppress: the API surface used here (exec/prepare/run) is
 * the stable core, and a warning in a dev tool's console is noise.
 */
function loadSqlite(): SqliteModule | null {
  try {
    const required = createRequire(import.meta.url)('node:sqlite') as SqliteModule;
    return typeof required?.DatabaseSync === 'function' ? required : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Process-wide singleton                                                      */
/* -------------------------------------------------------------------------- */

const STORE_KEY = Symbol.for('agentgrade.reportStore');

interface StoreCarrier {
  [STORE_KEY]?: ReportStore;
}

/**
 * The store shared by every API route.
 *
 * Cached on `globalThis` so Next.js's dev-mode module reloading reuses one
 * database handle instead of opening a new one on every hot update.
 */
export function getReportStore(): ReportStore {
  const carrier = globalThis as StoreCarrier;
  if (!carrier[STORE_KEY]) {
    carrier[STORE_KEY] = openReportStore(process.env.AGENTGRADE_DB ?? DEFAULT_DATABASE_PATH);
  }
  return carrier[STORE_KEY];
}
