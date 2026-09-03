import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';

/**
 * How stale a lock has to be before it is another process's crash rather than its work in progress. One install is a
 * read, a compare and a rename, so a lock this old is not being held by anything alive.
 */
export const LOCK_STALE_MS = 60_000;

/** Whether to take a lock, given the age of the one already there. A lock nobody clears would block installs forever. */
export function lockIsStale(mtimeMs: number, now: number): boolean {
  return now - mtimeMs > LOCK_STALE_MS || mtimeMs > now + LOCK_STALE_MS;
}

/** Never throws: a file that cannot be read is one the caller has to cope with, not an error to propagate. */
export function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The lock's own identity. Releasing must not unlink a lock that is no longer the one this process took: another
 * process whose turn came while this one was stalled would then be writing settings with nothing holding the door.
 */
const NONCE = `${process.pid}-${Math.random().toString(36).slice(2)}`;

/** Takes the install lock, breaking one nothing alive is holding. False means another process is mid-install. */
export function takeLock(path: string, now: number = Date.now()): boolean {
  const take = (): boolean => {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, NONCE);
      closeSync(fd);
    } catch {
      return false;
    }

    // Exclusive create is not enough on its own: breaking a stale lock is a delete and a create, and two processes
    // doing that at once both succeed. Whoever's nonce is in the file at the end is the one that holds it.
    return read(path) === NONCE;
  };

  if (take()) {
    return true;
  }

  try {
    if (!lockIsStale(statSync(path).mtimeMs, now)) {
      return false;
    }
  } catch {
    return false;
  }

  rmSync(path, { force: true });

  return take();
}

export function releaseLock(path: string): void {
  try {
    if (read(path) === NONCE) {
      rmSync(path, { force: true });
    }
  } catch {
    // A lock that has already gone, or one another process now owns.
  }
}

/** A real sleep, not a spin: the lock being waited out is another process's, so this thread has nothing to do. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Retried: on Windows a write to a path another process has momentarily open fails outright and succeeds a moment
 * later — measured on `~/.claude/settings.json`, which every live session reads. Synchronous, because 90 ms is the
 * whole budget and a torn settings file is not.
 */
export function attempt(action: () => void): void {
  for (let left = 3; ; left--) {
    try {
      action();

      return;
    } catch (error) {
      if (left === 0) {
        throw error;
      }

      pause(30);
    }
  }
}

/**
 * For a file nothing else holds open: a partial one is never visible under the real name. Falls back to writing in
 * place, because a rename over a path something else has open fails on Windows where a write does not.
 */
export function writeAtomic(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;

  attempt(() => writeFileSync(temp, text));

  try {
    attempt(() => renameSync(temp, path));
  } catch {
    attempt(() => writeFileSync(path, text));
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * For a file live processes hold open, such as an agent's settings: a rename over it fails where a write does not,
 * and the backup taken beforehand is what makes truncating safe.
 */
export function writeInPlace(path: string, text: string): void {
  attempt(() => writeFileSync(path, text));
}
