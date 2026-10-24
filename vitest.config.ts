import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // MathJax can take longer than Vitest's 5s default to start on shared CI runners.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
