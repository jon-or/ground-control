/** Log levels in threshold order. Debug adds frequent per-item detail and is disabled by default. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Configurable log thresholds. Above info, lifecycle lines are dropped; failures still reach boards as snapshot failures. */
export const LOG_FLOORS = ['debug', 'info', 'warn', 'error'] as const;

export type LogFloor = (typeof LOG_FLOORS)[number];

/** Which process said it. One interleaved stream is only readable if every line carries who it came from. */
export type LogSource = 'hub' | 'browser';

/**
 * Log entry written by the hub or client. Hub entries are stored and streamed to subscribers; client entries
 * remain in their process.
 */
export interface LogEntry {
  /** ISO 8601 from the writer's own clock. */
  at: string;
  level: LogLevel;
  source: LogSource;
  /** Component scope, such as github or sessions. Absent for process-wide messages. */
  scope?: string;
  message: string;
}

/** Shared logging contract for packages that cannot import the hub. */
export interface Logger {
  debug(message: string, scope?: string): void;
  info(message: string, scope?: string): void;
  warn(message: string, scope?: string): void;
  error(message: string, scope?: string): void;
  /** The floor a client asked for. A line under it is neither written nor streamed. */
  setLevel(level: LogFloor): void;
  level(): LogLevel;
  /** Subscribe to new entries until the returned unsubscribe function is called. No subscriber history is retained. */
  watch(onEntry: (entry: LogEntry) => void): () => void;
}

/** Whether a line at `level` survives a writer whose floor is `floor`. */
export function meetsLevel(level: LogLevel, floor: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(floor);
}

/** Bracket the level so the editor log grammar colors it, and the scope so colons in messages are not scope separators. */
export function formatLogLine(entry: LogEntry): string {
  const scope = entry.scope === undefined ? '' : `[${entry.scope}] `;

  return `${entry.at} [${entry.level}] ${scope}${entry.message}`;
}

/** Accept only lowercase scope words to avoid treating bracketed third-party output as a scope. */
const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) \[(debug|info|warn|error)\] (?:\[([a-z][a-z0-9-]*)\] )?(.*?)\r?$/;

/**
 * Parse log entries while preserving unstructured stdout/stderr. Associate raw lines with the preceding
 * timestamp so stack traces remain beside their error and crash output is not discarded.
 */
export function parseLogLines(lines: readonly string[]): LogEntry[] {
  const entries: LogEntry[] = [];

  // Empty until the first line that carries one. A tail read that opens mid-stack-trace has nothing better to say.
  let at = '';

  for (const line of lines) {
    const text = line.replace(/\r$/, '');

    if (text === '') {
      continue;
    }

    const match = LINE.exec(text);

    if (match === null) {
      entries.push({ at, level: 'info', source: 'hub', scope: 'raw', message: text });

      continue;
    }

    at = match[1]!;

    const level = match[2] as LogLevel;
    const scope = match[3];
    const message = match[4]!;

    entries.push(scope === undefined ? { at, level, source: 'hub', message } : { at, level, source: 'hub', scope, message });
  }

  return entries;
}
