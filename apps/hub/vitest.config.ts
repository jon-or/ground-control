import { defineConfig } from 'vitest/config';
import { testTemp } from '../../tools/vitest-temp.js';

// Spawn tests cover the built entry point; package logic has separate coverage floors (docs/testing.md, Choose the test layer).
export default defineConfig({
  test: { env: testTemp(), include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
});
