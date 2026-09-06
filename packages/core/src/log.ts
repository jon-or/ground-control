/**
 * The levels, in the order a floor compares them. `debug` is per-item detail — a line per page of a CLI's paging,
 * per session read, per marker batch — and is off by default because it is noise in a file whose reader has usually
 * opened it after something went wrong.
 */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * How much detail a client may ask the hub for. Deliberately not the whole of `LOG_LEVELS`: a floor above `info`
 * would silence the hub coming up, the hub stopping, and every refused request — and a client whose hub will not
 * start is sent to that file to find out why. The setting decides how much the log holds, never whether it holds
 * what happened.
 */
export const LOG_FLOORS = ['debug', 'info'] as const;

export type LogFloor = (typeof LOG_FLOORS)[number];

/** Which process said it. One interleaved stream is only readable if every line carries who it came from. */
export type LogSource = 'hub' | 'board' | 'browser';

/**
 * One line of what a process is doing. The hub writes these to `hub.log` and streams them to whichever client has
 * asked for them; each client also makes its own about itself, and those never leave the process that wrote them.
 */
export interface LogEntry {
  /** ISO 8601 from the writer's own clock. */
  at: string;
  level: LogLevel;
  source: LogSource;
  /** Which part of the process spoke: `github`, `sessions`, `gh`. Absent where the line is the process itself. */
  scope?: string;
  message: string;
}

/**
 * What anything that writes lines is handed. It lives here rather than beside the hub's implementation because a
 * work source is a seam `packages/github` implements, and that package may reach `core` and nothing else.
 */
export interface Logger {
  debug(message: string, scope?: string): void;
  info(message: string, scope?: string): void;
  warn(message: string, scope?: string): void;
  error(message: string, scope?: string): void;
  /** The floor a client asked for. A line under it is neither written nor streamed. */
  setLevel(level: LogFloor): void;
  level(): LogLevel;
  /**
   * Every entry written from now on, until the returned undo is called. Nothing is held for a watcher that is not
   * there, which is what "read nothing until a viewer is open" costs the writer: one empty set.
   */
  watch(onEntry: (entry: LogEntry) => void): () => void;
}

/** Whether a line at `level` survives a writer whose floor is `floor`. */
export function meetsLevel(level: LogLevel, floor: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(floor);
}

/**
 * One entry as `hub.log` holds it. The scope is bracketed rather than punctuated because the file is read back:
 * half the hub's own messages already carry a colon, which is what an unbracketed scope would be parsed as.
 */
export function formatLogLine(entry: LogEntry): string {
  const scope = entry.scope === undefined ? '' : `[${entry.scope}] `;

  return `${entry.at} ${entry.level} ${scope}${entry.message}`;
}

/**
 * A scope is one lowercase word, which every scope this code writes is. Narrow on purpose: a message that opens
 * with a bracket — third-party output does, and several of the hub's messages carry a CLI's own words — would
 * otherwise be read back with its first token torn off and called a scope.
 */
const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (debug|info|warn|error) (?:\[([a-z][a-z0-9-]*)\] )?(.*?)\r?$/;

/**
 * `hub.log` back into entries, which is what a board opening its viewer is shown. The file carries lines the logger
 * never wrote — the spawn points the hub's own stdout and stderr at the same descriptor — so anything that does not
 * parse is kept verbatim under the timestamp of the line above it. That is what puts a stack trace under the error
 * it belongs to rather than at the epoch, and it is why an unreadable line is never dropped: the lines the logger
 * did not write are the ones a developer opening the log after a crash came for.
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
