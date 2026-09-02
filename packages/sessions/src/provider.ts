import type { ReadText } from './link.js';
import type { Failure, Session } from './types.js';

/**
 * The machine a provider reads, injected so the package stays headless and testable. Notably absent: any way of
 * talking to a CLI. How a provider reaches its own CLI is its own business, so two providers can diverge freely.
 */
/** Modified time in epoch milliseconds, or null when the path is not a readable file. */
export type StatMtime = (path: string) => number | null;

/** Directory entry names, or null when the path is not a readable directory. */
export type ListDir = (path: string) => string[] | null;

/**
 * The last `bytes` bytes of a file as text, or null when it cannot be read. A transcript runs to megabytes and the
 * board re-reads it every 30 s, so a reader takes the end of one rather than the whole.
 */
export type ReadTail = (path: string, bytes: number) => string | null;

export interface ProviderDeps {
  readText: ReadText;
  mtime: StatMtime;
  listDir: ListDir;
  readTail: ReadTail;
  home: string;
  /** Null when the configured issue pattern is unusable; a provider then reports branches and links nothing. */
  pattern: RegExp | null;
}

/**
 * Sessions and a failure are not exclusive: a CLI listing ten sessions and one entry the board cannot read reports
 * both, so one malformed entry costs one card instead of every card (R2).
 */
export interface ProviderReading {
  sessions: Session[];
  failure: Failure | null;
}

/**
 * One agent CLI the board reads live sessions from. A provider owns its transport, its response shape, where its
 * transcripts live, and the wording of its failures, and returns finished `Session` rows.
 */
export interface SessionProvider {
  readonly id: string;
  readonly defaultPath: string;
  /** R30: a CLI that is not the developer's primary agent stays off until they enable it, so absence never nags. */
  readonly defaultEnabled: boolean;
  /** Lists every live session this CLI reports. Never throws — a failure comes back classified. */
  listSessions(path: string, deps: ProviderDeps): Promise<ProviderReading>;
}
