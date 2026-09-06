import { appendFileSync, closeSync, openSync } from 'node:fs';
import { formatLogLine, meetsLevel, parseLogLines } from '@ground-control/core';
import type { LogEntry, LogFloor, LogLevel, Logger, ReadTail } from '@ground-control/core';
import { LOG_LIMIT_BYTES, openLog, rotateLog } from './log.js';
import { logPathOf } from './paths.js';

export interface LoggerDeps {
  /** Where a formatted line goes. The file in production, an array in a test. */
  write(line: string): void;
  level?: LogFloor;
  /** Injected so a test reads a fixed timestamp rather than whatever the run happened to take. */
  now?(): string;
}

/**
 * Appends to `hub.log`, rotating on what this run has written rather than on a stat per line: one long-lived hub
 * outwrites its own limit many times over, and the file it leaves is the one a developer opens.
 */
export function fileSink(home: string): (line: string) => void {
  const path = logPathOf(home);

  let fd = openLog(path);
  let written = 0;

  return (line) => {
    const text = `${line}\n`;

    try {
      appendFileSync(fd, text);
      written += text.length;

      if (written >= LOG_LIMIT_BYTES) {
        written = 0;
        closeSync(fd);
        rotateLog(path);
        fd = openSync(path, 'a');
      }
    } catch {
      // A log that cannot be written is not a reason to stop tracking.
    }
  };
}

export function makeLogger(deps: LoggerDeps): Logger {
  const watchers = new Set<(entry: LogEntry) => void>();
  const now = deps.now ?? (() => new Date().toISOString());

  let floor: LogLevel = deps.level ?? 'info';

  function say(level: LogLevel, message: string, scope?: string): void {
    if (!meetsLevel(level, floor)) {
      return;
    }

    const at = now();
    const entry: LogEntry =
      scope === undefined ? { at, level, source: 'hub', message } : { at, level, source: 'hub', scope, message };

    // Both guarded, because these calls sit inside the hub's own control flow now — between registering a client and
    // sending it a snapshot, between writing a placement and broadcasting it. A sink or a stream that threw would
    // leave the operation half done, and neither is worth a board for.
    try {
      deps.write(formatLogLine(entry));
    } catch {
      // A log that cannot be written is not a reason to stop tracking.
    }

    for (const watcher of watchers) {
      try {
        watcher(entry);
      } catch {
        // A client whose stream ended is not something the hub logs about — that would be the next line to throw.
      }
    }
  }

  return {
    debug: (message, scope) => say('debug', message, scope),
    info: (message, scope) => say('info', message, scope),
    warn: (message, scope) => say('warn', message, scope),
    error: (message, scope) => say('error', message, scope),
    setLevel: (level) => {
      floor = level;
    },
    level: () => floor,
    watch: (onEntry) => {
      watchers.add(onEntry);

      return () => {
        watchers.delete(onEntry);
      };
    },
  };
}

/**
 * How much of `hub.log` a viewer is shown when it opens. Enough to carry the start of the hub that is running plus
 * the end of the one before it, which is the pair a developer chasing a restart needs.
 */
export const BACKFILL_BYTES = 64 * 1024;

/**
 * The tail of `hub.log` as entries, which is what a viewer is shown the moment it opens. Read on demand and held
 * nowhere: the file is written whatever happens, so there is no reason for the hub to keep a buffer against the
 * chance that somebody looks. It also means a viewer opened after a restart sees the last hub's dying words.
 */
export function readLogTail(readTail: ReadTail, path: string, bytes = BACKFILL_BYTES): LogEntry[] {
  const text = readTail(path, bytes);

  if (text === null) {
    return [];
  }

  const lines = text.split('\n');

  // A file larger than the window opens the read mid-line, so the first one is a fragment of an entry rather than
  // an entry. Dropped rather than shown, because what it would show is half a sentence with no timestamp.
  if (text.length >= bytes && lines.length > 1) {
    lines.shift();
  }

  return parseLogLines(lines);
}
