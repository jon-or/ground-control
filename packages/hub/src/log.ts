import { mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** Big enough to hold a day of a hub's starts and failures, small enough that nobody has to open it in pieces. */
export const LOG_LIMIT_BYTES = 1_000_000;

/** The current file plus this many older ones. Two is one crash back, which is as far as anyone reads. */
export const LOGS_KEPT = 2;

/**
 * Moves the log aside when it has grown past the limit, oldest dropped first. Called once at startup rather than on
 * every write: the hub's output is a few lines per start, so the file only grows across restarts.
 */
export function rotateLog(path: string, limit = LOG_LIMIT_BYTES, kept = LOGS_KEPT): boolean {
  try {
    if (statSync(path).size < limit) {
      return false;
    }
  } catch {
    return false;
  }

  rmSync(`${path}.${kept}`, { force: true });

  for (let index = kept - 1; index >= 1; index--) {
    try {
      renameSync(`${path}.${index}`, `${path}.${index + 1}`);
    } catch {
      // That generation does not exist yet.
    }
  }

  try {
    renameSync(path, `${path}.1`);
  } catch {
    // Something is holding it open; the hub appends to it rather than losing its own output.
    return false;
  }

  return true;
}

/** An append-only file descriptor for the hub's stdout and stderr, with its directory created if it is not there. */
export function openLog(path: string): number {
  mkdirSync(dirname(path), { recursive: true });
  rotateLog(path);

  return openSync(path, 'a');
}
