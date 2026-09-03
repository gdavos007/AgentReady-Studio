import { ArrowUpRight, Boxes, Clock } from 'lucide-react';
import Link from 'next/link';

import { AuditLauncher } from '@/components/AuditLauncher';
import { getReportStore, type StoredReportSummary } from '@/src/lib/store';
import type { Grade } from '@/src/shared/grade';

export const dynamic = 'force-dynamic';

const GRADE_COLOR: Record<Grade, string> = {
  A: 'var(--color-grade-a)',
  B: 'var(--color-grade-b)',
  C: 'var(--color-grade-c)',
  D: 'var(--color-grade-d)',
  F: 'var(--color-grade-f)',
};

/**
 * Sample targets.
 *
 * The first is the studio's own copy of the Phase 1 fixture — a verified
 * storefront with registered tools, declarative markup and seeded traps —
 * served from this origin, so the sample audit works with no network at all.
 */
const SAMPLES = [
  {
    label: 'Mock storefront fixture',
    detail: 'Verified target: 4 runtime tools, 7 surfaces, 12 seeded friction traps',
    path: '/api/fixture',
  },
  {
    label: 'This studio',
    detail: 'AgentGrade auditing itself — the report pages register their own WebMCP tools',
    path: '/',
  },
] as const;

export default async function HomePage() {
  const store = getReportStore();
  const recent = store.list(8);

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-6 py-16">
      <header>
        <div className="flex items-center gap-2">
          <Boxes className="size-5 text-accent" aria-hidden />
          <span className="font-mono text-sm tracking-tight text-ink-muted">AgentGrade</span>
        </div>
        <h1 className="mt-6 text-3xl leading-tight font-semibold tracking-tight text-ink">
          Is your site usable by an AI agent?
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-muted">
          AgentGrade drives a headless browser through your page, finds the WebMCP tools you expose (and the ones
          you don’t), and prices what an agent spends fighting your DOM instead.
        </p>
      </header>

      <section className="mt-8">
        <AuditLauncher />
      </section>

      <section className="mt-10">
        <h2 className="text-xs font-semibold tracking-wider text-ink-faint uppercase">Sample targets</h2>
        <ul className="mt-3 space-y-2">
          {SAMPLES.map((sample) => (
            <li key={sample.path}>
              <SampleRow label={sample.label} detail={sample.detail} path={sample.path} />
            </li>
          ))}
        </ul>
      </section>

      {recent.length > 0 ? (
        <section className="mt-10">
          <h2 className="flex items-center gap-1.5 text-xs font-semibold tracking-wider text-ink-faint uppercase">
            <Clock className="size-3.5" aria-hidden />
            Recent audits
          </h2>
          <ul className="mt-3 divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
            {recent.map((report) => (
              <li key={report.id}>
                <RecentRow report={report} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="mt-16 border-t border-line pt-6">
        <p className="text-xs leading-relaxed text-ink-faint">
          Reports are stored locally via <span className="font-mono">node:sqlite</span> in{' '}
          <span className="font-mono">.agentgrade/reports.db</span> — nothing leaves this machine.
        </p>
      </footer>
    </main>
  );
}

function SampleRow({ label, detail, path }: { label: string; detail: string; path: string }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-line bg-panel px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink">{label}</p>
        <p className="mt-0.5 truncate text-xs text-ink-faint">{detail}</p>
      </div>
      <a
        href={path}
        target="_blank"
        rel="noreferrer"
        className="flex shrink-0 items-center gap-1 font-mono text-xs text-ink-faint transition-colors hover:text-ink"
      >
        {path}
        <ArrowUpRight className="size-3" aria-hidden />
      </a>
    </div>
  );
}

function RecentRow({ report }: { report: StoredReportSummary }) {
  return (
    <Link
      href={`/report/${report.id}`}
      className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-panel-raised"
    >
      <span
        className="w-6 shrink-0 text-center font-mono text-lg font-bold"
        style={{ color: GRADE_COLOR[report.grade] }}
        aria-label={`Grade ${report.grade}`}
      >
        {report.grade}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-sm text-ink">{report.url}</span>
        <span className="block text-xs text-ink-faint">
          {report.toolCount} tool(s) · {report.frictionTrapCount} trap(s) · {report.issueCount} issue(s)
        </span>
      </span>
      <span className="shrink-0 font-mono text-sm text-ink-muted tabular-nums">{report.score}</span>
    </Link>
  );
}
