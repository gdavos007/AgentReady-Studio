#!/usr/bin/env node
/**
 * AgentGrade — command line front-end for the inspection engine.
 *
 * Usage:
 *   npm run scan -- https://example.com [--out report.json] [--timeout 45000]
 *                                       [--headed] [--proxy url] [--skip-descriptors]
 *                                       [--score] [--goal "Execute product search"] [--quiet]
 */

import { writeFile } from 'node:fs/promises';

import { scanUrl } from './engine.js';
import { validateAuditReport } from './validation.js';
import type { ScanDiagnostic, ScannerOptions } from './types.js';
import { scoreAudit } from '../evals/scorer.js';
import { runSyntheticEvaluation } from '../evals/synthetic-agent.js';

interface ParsedArgs {
  url: string | null;
  out: string | null;
  quiet: boolean;
  /** Emit a Phase 2 `AgentScorecard` alongside the raw scan. */
  score: boolean;
  /** Goal for the synthetic evaluator; implies `--score`. */
  goal: string | null;
  options: ScannerOptions;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { url: null, out: null, quiet: false, score: false, goal: null, options: {} };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    switch (argument) {
      case '--out':
        parsed.out = argv[++index] ?? null;
        break;
      case '--timeout':
        parsed.options.totalTimeoutMs = Number(argv[++index]);
        break;
      case '--nav-timeout':
        parsed.options.navigationTimeoutMs = Number(argv[++index]);
        break;
      case '--headed':
        parsed.options.headless = false;
        break;
      case '--proxy':
        parsed.options.proxy = { server: argv[++index] ?? '' };
        break;
      case '--skip-descriptors':
        parsed.options.skipDescriptors = true;
        break;
      case '--score':
        parsed.score = true;
        break;
      case '--goal':
        parsed.goal = argv[++index] ?? null;
        parsed.score = true;
        break;
      case '--quiet':
        parsed.quiet = true;
        break;
      default:
        if (!argument.startsWith('-') && !parsed.url) parsed.url = argument;
        break;
    }
  }
  return parsed;
}

async function main(): Promise<number> {
  const { url, out, quiet, score, goal, options } = parseArgs(process.argv.slice(2));
  if (!url) {
    process.stderr.write(
      'usage: scan <url> [--out report.json] [--timeout ms] [--headed] [--proxy url]\n' +
        '                  [--skip-descriptors] [--score] [--goal "<goal>"] [--quiet]\n',
    );
    return 2;
  }

  const onDiagnostic = quiet
    ? undefined
    : (diagnostic: ScanDiagnostic): void => {
        process.stderr.write(`[${diagnostic.level}] ${diagnostic.stage}/${diagnostic.code}: ${diagnostic.message}\n`);
      };

  const report = await scanUrl(url, { ...options, onDiagnostic });
  const validation = validateAuditReport(report);
  if (!validation.valid) {
    process.stderr.write(`report failed schema validation:\n  ${validation.errors.join('\n  ')}\n`);
  }

  // The scorecard is additive: `--score` wraps the report rather than
  // replacing it, so existing consumers of the raw payload keep working.
  let payload: unknown = report;
  if (score) {
    const syntheticEvaluation = goal ? await runSyntheticEvaluation(report.data, { goal }) : null;
    payload = { report, scorecard: scoreAudit(report.data, { syntheticEvaluation }) };
  }

  const json = JSON.stringify(payload, null, 2);
  if (out) {
    await writeFile(out, json + '\n', 'utf8');
    process.stderr.write(`wrote ${out}\n`);
  } else {
    process.stdout.write(json + '\n');
  }

  if (!quiet) {
    const { summary } = report.data;
    process.stderr.write(
      `\n${url} → ${summary.totalTools} tool(s), ${summary.formCount} surface(s), ` +
        `${summary.frictionTrapCount} friction trap(s)\n`,
    );
    if (score && payload !== report) {
      const { scorecard } = payload as { scorecard: ReturnType<typeof scoreAudit> };
      process.stderr.write(`AgentGrade ${scorecard.grade} — ${scorecard.overallScore}/100\n`);
      for (const pillar of scorecard.pillars) {
        process.stderr.write(
          `  ${pillar.label.padEnd(34)} ${pillar.weightedPoints.toFixed(1).padStart(5)} / ${pillar.maxPoints}\n`,
        );
      }
      process.stderr.write(`  ${scorecard.benchmark.frictionTax.headline}\n`);
      for (const issue of scorecard.issues.slice(0, 5)) {
        process.stderr.write(`  -${issue.deductionPoints.toFixed(2).padStart(5)}  ${issue.title}\n`);
      }
    }
  }

  if (report.status === 'failed') return 1;
  return validation.valid ? 0 : 3;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
