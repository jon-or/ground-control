import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

/** Reads a text file, or returns null for anything that is not a readable file — a directory included. */
export type ReadText = (path: string) => string | null;

/** Modified time in epoch milliseconds, or null when the path is not a readable file. */
export type StatMtime = (path: string) => number | null;

/** Directory entry names, or null when the path is not a readable directory. */
export type ListDir = (path: string) => string[] | null;

/**
 * The last `bytes` bytes of a file as text, or null when it cannot be read. A transcript runs to megabytes and the
 * board re-reads it every 30 s, so a reader takes the end of one rather than the whole.
 */
export type ReadTail = (path: string, bytes: number) => string | null;

/**
 * The machine as an adapter reads it, injected so every package stays headless and testable. Notably absent: any way
 * of talking to a CLI. How an adapter reaches its own CLI is its own business, so two adapters can diverge freely.
 */
export interface MachineReaders {
  readText: ReadText;
  mtime: StatMtime;
  listDir: ListDir;
  readTail: ReadTail;
  readHead: ReadTail;
  home: string;
}

export interface MachineDeps extends MachineReaders {
  /** Null when the configured issue pattern is unusable; an adapter then reports branches and links nothing. */
  pattern: RegExp | null;
}

/** Exported for its own test: a directory read must fail, which is how a worktree pointer is told from a clone. */
export const readTextFromDisk: ReadText = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

export const mtimeFromDisk: StatMtime = (path) => {
  try {
    const stats = statSync(path);

    return stats.isFile() ? stats.mtimeMs : null;
  } catch {
    return null;
  }
};

export const listDirFromDisk: ListDir = (path) => {
  try {
    return readdirSync(path);
  } catch {
    return null;
  }
};

/** One positional read of a file's end. A whole-file read of a multi-megabyte transcript is what this replaces. */
function readSlice(path: string, bytes: number, tail: boolean): string | null {
  let file: number | null = null;

  try {
    file = openSync(path, 'r');
    const stats = fstatSync(file);

    // A directory opens for reading on Windows and stats as zero bytes, which would read as an empty file.
    if (!stats.isFile()) {
      return null;
    }

    const length = Math.min(stats.size, bytes);
    const buffer = Buffer.alloc(length);

    // The count read, not the length asked for: a file truncated between the stat and the read leaves the rest of
    // the buffer zeroed, and NUL is not JSON whitespace, so those bytes would break the first record parsed.
    const read = readSync(file, buffer, 0, length, tail ? stats.size - length : 0);

    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (file !== null) {
      closeSync(file);
    }
  }
}

export const readTailFromDisk: ReadTail = (path, bytes) => readSlice(path, bytes, true);
export const readHeadFromDisk: ReadTail = (path, bytes) => readSlice(path, bytes, false);

/** The real machine, which is what every caller outside a test hands an adapter. */
export function diskReaders(home: string = homedir()): MachineReaders {
  return { readText: readTextFromDisk, mtime: mtimeFromDisk, listDir: listDirFromDisk, readTail: readTailFromDisk, readHead: readHeadFromDisk, home };
}
