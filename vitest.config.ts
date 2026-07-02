import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one Postgres database and reset it between tests, so files
    // must NOT run in parallel against each other.
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
    include: ['test/**/*.test.ts', 'packages/**/*.test.ts'],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    // Surface unhandled rejections from background claimers etc.
    dangerouslyIgnoreUnhandledErrors: false,
  },
});
