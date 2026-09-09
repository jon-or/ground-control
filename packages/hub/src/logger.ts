import { appendFileSync, closeSync, openSync } from 'node:fs';
import { formatLogLine, meetsLevel, parseLogLines } from '@ground-control/core';
import type { LogEntry, LogFloor, LogLevel, Logger, ReadTail } from '@ground-control/core';
import { LOG_LIMIT_BYTES, openLog, rotateLog } from './log.js';
import { logPathOf } from './paths.js';

export interface LoggerDeps {
  /** Formatted log output: file in production, array in tests. */
  write(line: string): void;
  level?: LogFloor;
  /** Inject timestamps for deterministic tests. */
  now?(): string;
}

/** Append to hub.log and rotate by bytes written, avoiding a stat call per line. */
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

    // Catch sink and subscriber errors so logging cannot interrupt hub operations.
    try {
      deps.write(formatLogLine(entry));
    } catch {
      // A log that cannot be written is not a reason to stop tracking.
    }

    for (const watcher of watchers) {
      try {
        watcher(entry);
      } catch {
        // Ignore subscriber failures to avoid recursive logging errors.
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

/** Maximum log tail shown when a viewer opens, including output from previous hub processes. */
export const BACKFILL_BYTES = 64 * 1024;

/** Read log entries on demand from disk, including previous hub output, without an in-memory buffer. */
export function readLogTail(readTail: ReadTail, path: string, bytes = BACKFILL_BYTES): LogEntry[] {
  const text = readTail(path, bytes);

  if (text === null) {
    return [];
  }

  const lines = text.split('\n');

  // Drop the first partial line when the tail starts mid-entry.
  if (text.length >= bytes && lines.length > 1) {
    lines.shift();
  }

  return parseLogLines(lines);
}
