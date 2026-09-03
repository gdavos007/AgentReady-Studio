import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // tsconfig sets `jsx: preserve` for Next's own compiler, which would leave
  // JSX untransformed here. Vitest transforms with esbuild, so it needs the
  // automatic runtime spelled out.
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  // Mirrors the `@/*` path alias from tsconfig.json, so tests can import the
  // Next.js app's route handlers and components exactly as the app does.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // A real Chromium launch plus navigation needs more than the 5s default.
    testTimeout: 120_000,
    hookTimeout: 240_000,
    teardownTimeout: 30_000,
    // Chromium instances are heavy; keep the suite serial and predictable.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    reporters: ['default'],
    // Component tests declare `@vitest-environment jsdom` in a docblock; the
    // scanner, evals, and API suites stay on the node environment.
  },
});
