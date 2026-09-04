import { describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('node:child_process', () => ({
  execFile: (_path: string, _args: string[], options: Record<string, unknown>, done: (e: null, o: string, s: string) => void) => {
    seen.push(options);
    done(null, '', '');
  },
}));

const { detectLogins, makeGhRunner } = await import('../src/index.js');

/** The hub that runs these has no console of its own, so a spawn without this opens one on the developer's screen. */
describe('what gh is spawned with', () => {
  it('runs a query without a console window', async () => {
    await makeGhRunner('gh')(['--version']);

    expect(seen.at(-1)?.['windowsHide']).toBe(true);
  });

  it('reads the logins without a console window', async () => {
    await detectLogins('gh');

    expect(seen.at(-1)?.['windowsHide']).toBe(true);
  });
});
