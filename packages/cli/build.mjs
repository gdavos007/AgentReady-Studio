/**
 * Bundles the CLI.
 *
 * The core engine lives at the repository root rather than in `packages/`, so
 * it is bundled in at build time under the `@agentgrade/core` alias rather than
 * declared as a dependency. That keeps the published package free of a
 * circular workspace link, and leaves it with exactly one runtime dependency —
 * Playwright, which ships platform binaries and must stay external.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const outDir = resolve(here, 'dist');

const manifest = JSON.parse(await readFile(resolve(here, 'package.json'), 'utf8'));

/** Resolves `@agentgrade/core` to the root engine's source. */
const coreAlias = {
  name: 'agentgrade-core-alias',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@agentgrade\/core$/ }, () => ({
      path: resolve(repoRoot, 'src', 'index.ts'),
    }));
    pluginBuild.onResolve({ filter: /^@agentgrade\/core\// }, (args) => ({
      path: resolve(repoRoot, 'src', `${args.path.replace('@agentgrade/core/', '')}.ts`),
    }));
  },
};

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  // Playwright ships browser binaries and native bindings; bundling it would
  // break its runtime path resolution.
  external: ['playwright', 'playwright-core'],
  plugins: [coreAlias],
  define: {
    __AGENTGRADE_VERSION__: JSON.stringify(manifest.version),
  },
  logLevel: 'warning',
};

await mkdir(outDir, { recursive: true });

// No `banner` here: `src/cli.ts` already starts with a shebang and esbuild
// preserves it, so adding one would emit it twice and break the parse.
await build({
  ...shared,
  entryPoints: [resolve(here, 'src', 'cli.ts')],
  outfile: resolve(outDir, 'cli.js'),
});

await build({
  ...shared,
  entryPoints: [resolve(here, 'src', 'index.ts')],
  outfile: resolve(outDir, 'index.js'),
});

// The bin entry has to be executable when npm links or installs it.
await chmod(resolve(outDir, 'cli.js'), 0o755);

// esbuild does not emit declarations; the public surface is small and stable,
// so it is declared by hand rather than by adding a second compiler pass whose
// output would need the same `@agentgrade/core` alias at consumer type-check
// time.
await writeFile(
  resolve(outDir, 'index.d.ts'),
  `export type { AuditRunResult, RunAuditOptions } from '../src/audit.js';
export type { JsonReportEnvelope } from '../src/formatters/json.js';
export type { MarkdownOptions } from '../src/formatters/markdown.js';
export type { PrettyOptions } from '../src/formatters/pretty.js';
export type { CliIo, OutputFormat, ParsedArgs } from '../src/cli.js';

export declare const EXIT_CODES: { pass: 0; belowThreshold: 1; usage: 2; scanFailed: 3 };
export declare const FORMATS: readonly ['pretty', 'json', 'markdown'];
export declare const DEFAULT_THRESHOLD: number;
export declare const COMMENT_MARKER: string;

export declare function runAudit(
  url: string,
  options: import('../src/audit.js').RunAuditOptions,
): Promise<import('../src/audit.js').AuditRunResult>;
export declare function normaliseUrl(input: string): string;
export declare function formatJson(result: import('../src/audit.js').AuditRunResult): string;
export declare function formatMarkdown(
  result: import('../src/audit.js').AuditRunResult,
  options?: import('../src/formatters/markdown.js').MarkdownOptions,
): string;
export declare function formatPretty(
  result: import('../src/audit.js').AuditRunResult,
  options?: import('../src/formatters/pretty.js').PrettyOptions,
): string;
export declare function parseArgs(argv: string[]): import('../src/cli.js').ParsedArgs;
export declare function main(argv: string[], io?: import('../src/cli.js').CliIo): Promise<number>;
`,
  'utf8',
);

process.stdout.write(`agentgrade CLI built to ${outDir}\n`);
