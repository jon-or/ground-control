import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Three file operations and `reg.exe`, handed a plan every decision of which is tested beside it in
      // `chromeHost.test.ts`. Testing this one would mean writing to the developer's own Chrome registration.
      exclude: ['src/chromeHostFs.ts'],
      thresholds: { lines: 85, branches: 85, functions: 85, statements: 85 },
    },
  },
});
