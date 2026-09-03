import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // A real Chromium launch plus navigation needs more than the 5s default.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 30_000,
    // Chromium instances are heavy; keep the suite serial and predictable.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    reporters: ['default'],
  },
});
