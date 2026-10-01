import { defineConfig } from 'vitest/config';
import { testTemp } from '../../tools/vitest-temp.js';

export default defineConfig({
  test: {
    env: testTemp(),
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['media/**/*.js'],
      thresholds: { lines: 85, branches: 85, functions: 85, statements: 85 },
    },
  },
});
