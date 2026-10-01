import { describe, expect, it, vi } from 'vitest';
import type { MachineReaders } from '@ground-control/core';
import { perRun } from '../src/perRun.js';

function disk(): MachineReaders & { text: string; dir: string[] } {
  const control = {
    text: 'ref: refs/heads/one\n',
    dir: ['a'],
    readText: vi.fn(() => control.text),
    listDir: vi.fn(() => control.dir),
    mtime: () => null,
    readTail: () => null,
    readHead: () => null,
    home: '/home',
    stateDir: '/state',
  };

  return control;
}

describe('perRun', () => {
  it('reads each file and directory once within a run', () => {
    const readers = disk();
    const once = perRun(readers, () => undefined);

    expect(once.readText('/c/.git/HEAD')).toBe('ref: refs/heads/one\n');
    readers.text = 'ref: refs/heads/two\n';
    expect(once.readText('/c/.git/HEAD')).toBe('ref: refs/heads/one\n');
    expect(once.listDir('/c')).toEqual(['a']);
    expect(once.listDir('/c')).toEqual(['a']);
    expect(readers.readText).toHaveBeenCalledTimes(1);
    expect(readers.listDir).toHaveBeenCalledTimes(1);
  });

  it('reads the disk again for a caller that held the readers across an await, and says the run ended', async () => {
    const readers = disk();
    const ended = vi.fn();
    const held = perRun(readers, ended);

    held.readText('/c/.git/HEAD');
    held.listDir('/c');
    await Promise.resolve();
    readers.text = 'ref: refs/heads/two\n';
    readers.dir = ['a', 'b'];

    expect(ended).toHaveBeenCalledTimes(1);
    expect(held.readText('/c/.git/HEAD')).toBe('ref: refs/heads/two\n');
    expect(held.listDir('/c')).toEqual(['a', 'b']);
  });
});
