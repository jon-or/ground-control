import { describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('node:child_process', () => ({
  execFile: (_path: string, _args: string[], options: Record<string, unknown>, done: (e: null, o: string, s: string) => void) => {
    seen.push(options);
    done(null, '{}', '');
  },
}));

const { runJsonCli } = await import('../src/execJson.js');

describe('runJsonCli', () => {
  /** The hub has no console, so a child without this opens one — a command prompt on screen at every poll. */
  it('runs the CLI without a console window of its own', async () => {
    await runJsonCli(process.execPath, ['-e', '']);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.['windowsHide']).toBe(true);
  });
});
