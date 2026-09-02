import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { compilePattern } from './link.js';
import type { ReadText } from './link.js';
import type { ListDir, ProviderReading, ReadTail, SessionProvider, StatMtime } from './provider.js';
import { providers as registered } from './providers.js';
import type { SessionsConfig, SessionsSnapshot } from './types.js';

export interface SessionsDeps {
  readText?: ReadText;
  mtime?: StatMtime;
  listDir?: ListDir;
  readTail?: ReadTail;
  home?: string;
  /** Test seam: the registry otherwise, whose providers carry their own real transports. */
  agents?: readonly SessionProvider[];
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
export const readTailFromDisk: ReadTail = (path, bytes) => {
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
    const read = readSync(file, buffer, 0, length, stats.size - length);

    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (file !== null) {
      closeSync(file);
    }
  }
};

/**
 * Every live session across every configured agent CLI, read concurrently. Always a snapshot: one CLI being absent
 * must not hide another's sessions, which is R2's "no session is invisible" on a machine running several agents.
 */
export async function fetchSessions(cfg: SessionsConfig, deps: SessionsDeps = {}): Promise<SessionsSnapshot> {
  const { pattern, error } = compilePattern(cfg.branchIssuePattern);

  const providerDeps = {
    readText: deps.readText ?? readTextFromDisk,
    mtime: deps.mtime ?? mtimeFromDisk,
    listDir: deps.listDir ?? listDirFromDisk,
    readTail: deps.readTail ?? readTailFromDisk,
    home: deps.home ?? homedir(),
    pattern,
  };

  const available = deps.agents ?? registered();

  const reads = cfg.agents.map((agent): Promise<ProviderReading> => {
    const provider = available.find((candidate) => candidate.id === agent.id);

    if (!provider) {
      return Promise.resolve({
        sessions: [],
        failure: {
          agent: agent.id,
          kind: 'unknown-agent',
          message: `The board does not know how to read sessions from "${agent.id}".`,
          remedy: 'Remove it from the configured agents, or check the spelling.',
        },
      });
    }

    return provider.listSessions(agent.path || provider.defaultPath, providerDeps);
  });

  const settled = await Promise.all(reads);

  return {
    sessions: settled.flatMap((reading) => reading.sessions),
    failures: settled.flatMap((reading) => (reading.failure ? [reading.failure] : [])),
    patternError: error === null ? null : `groundControl.branchIssuePattern ${error}`,
    fetchedAt: new Date().toISOString(),
  };
}
