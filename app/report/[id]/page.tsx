import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { generateAllRemediations, type RemediationBundle } from '@/src/lib/codegen';
import { getReportStore } from '@/src/lib/store';
import { ReportView } from './report-view';

export const dynamic = 'force-dynamic';

/**
 * The report route.
 *
 * Remediation code is generated here, on the server, rather than shipping the
 * whole `AgentAuditRawData` payload to the browser just so the client can
 * derive it. The bundles are far smaller than the scan they come from, and the
 * generator is pure, so the result is identical either way.
 */
export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const stored = getReportStore().get(id);
  if (!stored) notFound();

  const remediations: Record<string, RemediationBundle> = Object.fromEntries(
    generateAllRemediations(stored.scorecard.issues, stored.report.data),
  );

  return (
    <main className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-ground/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-6 py-3">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-sm text-ink-faint transition-colors hover:text-ink"
          >
            <ArrowLeft className="size-4" aria-hidden />
            New audit
          </Link>
          <span className="text-line-bright" aria-hidden>
            /
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-sm text-ink-muted" title={stored.url}>
            {stored.url}
          </span>
          <span className="shrink-0 font-mono text-xs text-ink-faint">
            {new Date(stored.createdAt).toLocaleString()}
          </span>
        </div>
      </header>

      <ReportView
        scorecard={stored.scorecard}
        remediations={remediations}
        url={stored.url}
        scanStatus={stored.report.status}
        scanDurationMs={stored.report.durationMs}
      />
    </main>
  );
}
