#!/usr/bin/env node
/**
 * AgentGrade — command line front-end for the inspection engine.
 *
 * Usage:
 *   npm run scan -- https://example.com [--out report.json] [--timeout 45000]
 *                                       [--headed] [--proxy url] [--skip-descriptors] [--quiet]
 */

import { writeFile } from 'node:fs/promises';

import { scanUrl } from './engine.js';
import { validateAuditReport } from './validation.js';
import type { ScanDiagnostic, ScannerOptions } from './types.js';

interface ParsedArgs {
  url: string | null;
  out: string | null;
  quiet: boolean;
  options: ScannerOptions;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { url: null, out: null, quiet: false, options: {} };
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
  const { url, out, quiet, options } = parseArgs(process.argv.slice(2));
  if (!url) {
    process.stderr.write('usage: scan <url> [--out report.json] [--timeout ms] [--headed] [--proxy url] [--skip-descriptors]\n');
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

  const json = JSON.stringify(report, null, 2);
  if (out) {
    await writeFile(out, json + '\n', 'utf8');
    process.stderr.write(`wrote ${out}\n`);
  } else {
    process.stdout.write(json + '\n');
  }

  if (!quiet) {
    const { summary } = report.data;
    process.stderr.write(
      `\n${url} → grade ${summary.grade} (${summary.agentReadinessScore}/100): ` +
        `${summary.totalTools} tool(s), ${summary.formCount} surface(s), ${summary.frictionTrapCount} friction trap(s)\n`,
    );
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
