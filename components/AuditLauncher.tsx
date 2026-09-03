'use client';

import { ArrowRight, CircleAlert, Loader2, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';

import { AUDIT_STAGES, STAGE_LABELS, type AuditStage } from '@/src/lib/stages';

/** One progress line rendered in the stage rail. */
interface StageState {
  stage: AuditStage;
  detail: string;
  done: boolean;
}

export interface AuditLauncherProps {
  /** Prefills the input, e.g. from the sample-target buttons. */
  initialUrl?: string;
  /** Goal handed to the synthetic evaluator. */
  syntheticGoal?: string;
}

/**
 * The URL entry bar and live progress rail.
 *
 * Reads the audit endpoint's NDJSON stream so the user watches the pipeline
 * move through Discovery → Surfaces → Traps → Benchmark rather than staring at
 * a spinner for thirty seconds.
 */
export function AuditLauncher({ initialUrl = '', syntheticGoal = 'Execute the primary transaction' }: AuditLauncherProps) {
  const router = useRouter();
  const [url, setUrl] = useState(initialUrl);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stages, setStages] = useState<StageState[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (target: string): Promise<void> => {
      const trimmed = target.trim();
      if (!trimmed || running) return;

      setRunning(true);
      setError(null);
      setStages([]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch('/api/audit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: trimmed, syntheticGoal }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? `Audit failed with HTTP ${response.status}.`);
        }
        if (!response.body) throw new Error('The audit endpoint returned no stream.');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // NDJSON: split on newlines, keeping the trailing partial line for the
        // next chunk. A JSON object may straddle a chunk boundary.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line) as {
              stage: AuditStage;
              detail?: string;
              reportId?: string;
              message?: string;
            };

            if (event.stage === 'failed') throw new Error(event.message ?? 'The audit failed.');

            if (event.stage === 'complete' && event.reportId) {
              router.push(`/report/${event.reportId}`);
              return;
            }

            setStages((previous) => {
              const next = previous.filter((entry) => entry.stage !== event.stage);
              return [
                ...next.map((entry) => ({ ...entry, done: true })),
                { stage: event.stage, detail: event.detail ?? '', done: false },
              ];
            });
          }
        }

        throw new Error('The audit stream ended before a report was produced.');
      } catch (caught) {
        if ((caught as Error).name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setRunning(false);
        abortRef.current = null;
      }
    },
    [router, running, syntheticGoal],
  );

  return (
    <div className="w-full" data-testid="audit-launcher">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(url);
        }}
        className="flex items-stretch gap-2"
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint" aria-hidden />
          <input
            type="text"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="example.com"
            aria-label="URL to audit"
            disabled={running}
            spellCheck={false}
            autoComplete="url"
            className="w-full rounded-md border border-line bg-panel py-2.5 pr-3 pl-9 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none disabled:opacity-60"
          />
        </div>
        <button
          type="submit"
          disabled={running || url.trim().length === 0}
          className="flex items-center gap-2 rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-bright disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ArrowRight className="size-4" aria-hidden />}
          {running ? 'Auditing' : 'Audit'}
        </button>
      </form>

      {error ? (
        <p
          role="alert"
          data-testid="audit-error"
          className="mt-3 flex items-start gap-2 rounded-md border border-critical/30 bg-critical/10 px-3 py-2 text-sm text-critical"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}

      {stages.length > 0 ? (
        <ol className="mt-4 space-y-2" data-testid="audit-progress" aria-live="polite">
          {AUDIT_STAGES.filter((stage) => stage !== 'complete').map((stage) => {
            const state = stages.find((entry) => entry.stage === stage);
            const reached = Boolean(state);
            return (
              <li key={stage} className="flex items-start gap-3 text-sm">
                <span
                  aria-hidden
                  className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                    !reached ? 'bg-line-bright' : state?.done ? 'bg-grade-a' : 'animate-pulse bg-accent'
                  }`}
                />
                <span className="min-w-0">
                  <span className={reached ? 'text-ink' : 'text-ink-faint'}>{STAGE_LABELS[stage]}</span>
                  {state?.detail ? (
                    <span className="block font-mono text-xs text-ink-faint">{state.detail}</span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

export default AuditLauncher;
