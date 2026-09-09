import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';

/** Lock age after which installation may replace it as stale. */
export const LOCK_STALE_MS = 60_000;

/** Check whether an existing lock has expired. */
export function lockIsStale(mtimeMs: number, now: number): boolean {
  return now - mtimeMs > LOCK_STALE_MS || mtimeMs > now + LOCK_STALE_MS;
}

/** Return null for missing or unreadable files. */
export function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Persist accepted configuration before using paths it records. Never truncate the previous configuration. */
export function writeDurable(path: string, text: string): void {
  if (read(path) === text) return;
  const temp = `${path}.${process.pid}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'w', 0o600);
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    attempt(() => renameSync(temp, path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { rmSync(temp, { force: true }); } catch { /* Preserve the write failure. */ }
  }
}

/** Verify lock ownership before release so a delayed process cannot remove another installer's lock. */
const NONCE = `${process.pid}-${Math.random().toString(36).slice(2)}`;

/** Acquire the install lock, replacing stale locks. Return false while another installer owns it. */
export function takeLock(path: string, now: number = Date.now()): boolean {
  const take = (): boolean => {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, NONCE);
      closeSync(fd);
    } catch {
      return false;
    }

    // Stale-lock deletion and creation can race; verify the stored nonce after acquiring.
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
    // The lock was removed or replaced by another process.
  }
}

/** Block without spinning while another process releases a file. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Retry transient Windows access failures synchronously within 90 ms, as measured on shared Claude settings. */
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

/** Write via a temporary file and rename. Fall back to in-place writes when Windows open handles prevent replacement. */
export function writeAtomic(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;

  attempt(() => writeFileSync(temp, text));

  try {
    attempt(() => renameSync(temp, path));
  } catch {
    writeInPlace(path, text);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Write settings in place when open handles prevent rename. The caller backs up the file before truncation. */
export function writeInPlace(path: string, text: string): void {
  attempt(() => writeFileSync(path, text));
}

/** Skip unchanged content to avoid repeated filesystem writes during rendering. */
export function writeIfChanged(path: string, text: string): boolean {
  if (read(path) === text) {
    return false;
  }

  writeAtomic(path, text);

  return true;
}
