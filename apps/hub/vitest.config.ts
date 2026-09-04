import { defineConfig } from 'vitest/config';

// No coverage floor: this package is an argument parser and a spawn. Every decision it makes is in `@ground-control/hub`,
// and what is left is covered by spawning the built entry point (testing.md, "an entry point is covered by its spawn").
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
});
