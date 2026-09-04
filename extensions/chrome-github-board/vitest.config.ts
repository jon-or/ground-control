import { defineConfig } from 'vitest/config';

// The two files that hold no `chrome` port. What `worker.js` and `content.js` have left after `state.js` is wiring —
// connect, observe, relay — and the Playwright run is what proves that, not a number here.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/overlay.js', 'src/state.js'],
      thresholds: { lines: 85, branches: 85, functions: 85, statements: 85 },
    },
  },
});
