import { describe, expect, it } from 'vitest';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listDirFromDisk, mtimeFromDisk, readTailFromDisk, readTextFromDisk } from '../src/sessions.js';
import { join as joinForward } from '../src/paths.js';

// This package's own directory, which has the two shapes the readers must tell apart.
const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = join(pkg, 'package.json');

describe('readTextFromDisk', () => {
  it('reads a file', () => {
    expect(readTextFromDisk(manifest)).toContain('@ground-control/sessions');
  });

  it('returns null for a directory, which is how a plain .git is told from a worktree pointer', () => {
    expect(readTextFromDisk(pkg)).toBeNull();
  });

  it('returns null for a path that is not there', () => {
    expect(readTextFromDisk(join(pkg, 'no-such-file'))).toBeNull();
  });

  it('accepts the forward-slash paths this package builds', () => {
    expect(readTextFromDisk(joinForward(pkg, 'package.json'))).toContain('@ground-control/sessions');
  });
});

describe('mtimeFromDisk', () => {
  it('reports the file own write time', () => {
    expect(mtimeFromDisk(manifest)).toBe(statSync(manifest).mtimeMs);
  });

  it('returns null for a directory', () => {
    expect(mtimeFromDisk(pkg)).toBeNull();
  });

  it('returns null for a path that is not there', () => {
    expect(mtimeFromDisk(join(pkg, 'no-such-file'))).toBeNull();
  });
});

describe('listDirFromDisk', () => {
  it('lists a directory', () => {
    expect(listDirFromDisk(pkg)).toContain('package.json');
  });

  it('returns null for a file', () => {
    expect(listDirFromDisk(manifest)).toBeNull();
  });

  it('returns null for a path that is not there', () => {
    expect(listDirFromDisk(join(pkg, 'no-such-directory'))).toBeNull();
  });
});

describe('readTailFromDisk', () => {
  it('reads the end of a file, not its start', () => {
    const whole = readTextFromDisk(manifest)!;

    expect(readTailFromDisk(manifest, 40)).toBe(whole.slice(-40));
  });

  it('reads a whole file smaller than the window asked for', () => {
    expect(readTailFromDisk(manifest, 1_000_000)).toBe(readTextFromDisk(manifest));
  });

  it('is null for a directory and for a path that is not there', () => {
    expect(readTailFromDisk(pkg, 100)).toBeNull();
    expect(readTailFromDisk(join(pkg, 'no-such-file'), 100)).toBeNull();
  });
});
