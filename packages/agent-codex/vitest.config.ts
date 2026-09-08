import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The writer runs as a real child process and may walk the process tree for its Codex parent, which costs a
    // PowerShell start and up to three CIM queries. Under a full-tree run that outlasts vitest own default.
    testTimeout: 60_000,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: { lines: 85, branches: 85, functions: 85, statements: 85 },
    },
  },
});
