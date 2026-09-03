import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { LOCK_STALE_MS, lockIsStale, read, releaseLock, takeLock, writeAtomic, writeInPlace } from '../src/fs.js';
import { tempHome } from './helpers.js';

let home: string;
let dispose: () => void;

beforeEach(() => {
  ({ home, dispose } = tempHome());
});

afterEach(() => dispose());

const lockPath = (): string => `${home}/install.lock`;

describe('lockIsStale', () => {
  const now = 1_788_000_000_000;

  it('takes a lock nobody has cleared, and leaves a fresh one alone', () => {
    expect(lockIsStale(now - LOCK_STALE_MS - 1, now)).toBe(true);
    expect(lockIsStale(now - 1_000, now)).toBe(false);
    expect(lockIsStale(now, now)).toBe(false);
  });

  // A lock stamped in the future is a clock the hub cannot reason about, and would otherwise never expire.
  it('takes a lock stamped in the future', () => {
    expect(lockIsStale(now + LOCK_STALE_MS + 1, now)).toBe(true);
  });
});

describe('the install lock', () => {
  it('is taken when nothing holds it, and refused while something does', () => {
    expect(takeLock(lockPath())).toBe(true);
    expect(existsSync(lockPath())).toBe(true);
  });

  /** Not this process's own second take: a lock file already there is another process mid-install. */
  it('refuses a lock a live process is holding', () => {
    writeFileSync(lockPath(), 'another-process');

    expect(takeLock(lockPath())).toBe(false);
  });

  it('breaks a lock nothing alive is holding', () => {
    writeFileSync(lockPath(), 'a process that crashed');
    const stale = new Date(Date.now() - LOCK_STALE_MS - 5_000);
    utimesSync(lockPath(), stale, stale);

    expect(takeLock(lockPath())).toBe(true);
  });

  /** The `finally` must not unlink a lock another process now owns, or two would write the settings at once. */
  it('releases only the lock it is still holding', () => {
    takeLock(lockPath());
    writeFileSync(lockPath(), 'somebody else');
    releaseLock(lockPath());

    expect(read(lockPath())).toBe('somebody else');
  });

  it('releases the one it took', () => {
    takeLock(lockPath());
    releaseLock(lockPath());

    expect(existsSync(lockPath())).toBe(false);
  });

  it('tolerates releasing a lock that has already gone', () => {
    expect(() => releaseLock(lockPath())).not.toThrow();
  });
});

describe('read', () => {
  it('reads a file, and is null for anything that is not a readable one', () => {
    writeFileSync(`${home}/note.txt`, 'hello');

    expect(read(`${home}/note.txt`)).toBe('hello');
    expect(read(home)).toBeNull();
    expect(read(`${home}/absent`)).toBeNull();
  });
});

describe('writeAtomic', () => {
  it('writes the file and leaves no temporary behind for a reader to find', () => {
    writeAtomic(`${home}/lanes.json`, '{"placements":{}}');

    expect(readFileSync(`${home}/lanes.json`, 'utf8')).toBe('{"placements":{}}');
    expect(readdirSync(home)).toEqual(['lanes.json']);
  });

  it('replaces a file that is already there', () => {
    writeAtomic(`${home}/lanes.json`, 'first');
    writeAtomic(`${home}/lanes.json`, 'second');

    expect(readFileSync(`${home}/lanes.json`, 'utf8')).toBe('second');
  });

  /**
   * A rename over a path another process holds open fails on Windows where a write does not, so the file has to
   * land either way. Here the destination is a directory, which makes the rename fail on every platform.
   */
  it('leaves nothing behind when it cannot write at all', () => {
    expect(() => writeAtomic(home, 'not a directory')).toThrow();
    expect(readdirSync(home)).toEqual([]);
  });
});

describe('writeInPlace', () => {
  it('truncates and rewrites a file live processes may hold open', () => {
    writeFileSync(`${home}/settings.json`, '{"hooks":{}}');
    writeInPlace(`${home}/settings.json`, '{}');

    expect(readFileSync(`${home}/settings.json`, 'utf8')).toBe('{}');
  });

  it('throws when the path cannot be written, rather than reporting a write that did not happen', () => {
    expect(() => writeInPlace(home, 'not a directory')).toThrow();
  });
});
