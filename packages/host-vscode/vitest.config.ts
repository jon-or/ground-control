import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Both shell out to the real machine — `netstat`, PowerShell, and `node:sqlite` over a live `workspaceStorage`
      // tree — and hand what they read to the pure functions beside them, which is where every decision is tested.
      exclude: ['src/stores.ts', 'src/windows.ts'],
      thresholds: { lines: 85, branches: 85, functions: 85, statements: 85 },
    },
  },
});
