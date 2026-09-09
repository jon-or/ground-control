import { mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** Maximum log size before rotation. */
export const LOG_LIMIT_BYTES = 1_000_000;

/** Number of rotated files retained in addition to the current log. */
export const LOGS_KEPT = 2;

/** Rotate at the size limit, deleting the oldest file. Called at startup and during writes. */
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
    // If rotation fails, keep appending to the current log.
    return false;
  }

  return true;
}

/** Open the hub log for append, creating its directory if needed. */
export function openLog(path: string): number {
  mkdirSync(dirname(path), { recursive: true });
  rotateLog(path);

  return openSync(path, 'a');
}
