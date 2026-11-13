import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each test file builds its own in-memory database, so files can run in parallel.
    testTimeout: 20000,
  },
});
