import Link from 'next/link';

export default function ReportNotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
      <h1 className="text-lg font-semibold text-ink">Report not found</h1>
      <p className="mt-2 text-sm text-ink-muted">
        This report id is not in the local database. Reports live in{' '}
        <span className="font-mono">.agentgrade/reports.db</span> and are not shared between machines.
      </p>
      <Link
        href="/"
        className="mt-6 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-bright"
      >
        Run a new audit
      </Link>
    </main>
  );
}
