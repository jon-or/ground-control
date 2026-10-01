import { defineConfig } from 'vitest/config';
import { testTemp } from '../../tools/vitest-temp.js';

// Measure unit coverage for overlay, state, and preference policy. Playwright tests Chrome messaging and observers in
// worker.js and content.js.
export default defineConfig({
  test: {
    env: testTemp(),
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/overlay.js', 'src/panel.js', 'src/custody.js', 'src/state.js', 'src/preferences.js'],
      thresholds: { lines: 85, branches: 85, functions: 85, statements: 85 },
    },
  },
});
