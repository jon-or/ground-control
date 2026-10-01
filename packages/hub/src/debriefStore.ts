import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { z } from 'zod';
import type { DebriefCache, FrictionEntry } from '@ground-control/core';
import { writeAtomic } from './fs.js';

/** What the runner remembers about one Claude session (R52). */
const sessionState = z.object({
  /** The last message a successful debrief covered; the next one starts after it. */
  throughMessageUuid: z.string().nullable(),
  debriefedAt: z.string().nullable(),
  /** Failed attempts on the range ending at `attemptedThrough`. */
  attempts: z.number().int().min(0),
  lastError: z.string().nullable(),
  attemptedAt: z.string().nullable(),
  attemptedThrough: z.string().nullable(),
});

/**
 * A Codex thread a debriefed session delegated to. `pending` holds it for the Codex command until it answers, says the
 * thread is not Codex's, or fails three times; a later debrief that names it again sets it pending again.
 */
const codexState = z.object({
  parentSessionId: z.string(),
  /** The parent's directory, which the thread's log line records. */
  cwd: z.string(),
  /** The last successful debrief; the next one asks only about turns since. */
  debriefedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  pending: z.boolean(),
  attempts: z.number().int().min(0),
  attemptedAt: z.string().nullable(),
});

const debriefState = z.object({
  v: z.literal(1),
  sessions: z.record(z.string(), sessionState),
  codex: z.record(z.string(), codexState),
  /** When each subagent a fork was shown was last debriefed, keyed `<sessionId>/<agentId>`. */
  subagents: z.record(z.string(), z.string()).default({}),
});

export type SessionDebriefState = z.infer<typeof sessionState>;
export type CodexDebriefState = z.infer<typeof codexState>;
export type DebriefState = z.infer<typeof debriefState>;

export const EMPTY_DEBRIEF_STATE: DebriefState = { v: 1, sessions: {}, codex: {}, subagents: {} };

/** One line of `log/YYYY-MM.jsonl`, the contract the daily analyzer reads. */
export interface DebriefLogEntry {
  v: 1;
  at: string;
  provider: 'claude' | 'codex';
  sessionId: string;
  parentSessionId: string | null;
  cwd: string;
  fromMessageUuid: string | null;
  throughMessageUuid: string | null;
  skills: string[] | null;
  toolCalls: number | null;
  cache: DebriefCache | null;
  friction: FrictionEntry[];
  /** A Claude line's fork start, which the subagents it was shown record as their last debrief. */
  startedAt?: string;
  /** A Claude line's subagents the fork was shown and may have asked. */
  subagents?: string[];
}

/** The newest Claude line for a session, none, or a log that could not be read. */
export type LoggedReading = { latest: LoggedDebrief | null } | { unreadable: true };

/** The newest debrief of a session the log holds; `subagents` is empty for a line written before they were recorded. */
export interface LoggedDebrief {
  throughMessageUuid: string;
  at: string;
  startedAt: string;
  subagents: string[];
}

export interface DebriefStore {
  /** The state, empty when the file does not exist, or null when it exists and cannot be read. */
  readState(): DebriefState | null;
  writeState(state: DebriefState): boolean;
  appendLog(entry: DebriefLogEntry): boolean;
  /** The newest Claude line for this session in the two newest log files. */
  logged(sessionId: string): LoggedReading;
}

/** Whether the file exists and its last byte is not a newline. */
function endsInsideLine(path: string): boolean {
  let file: number;

  try {
    file = openSync(path, 'r');
  } catch {
    return false;
  }

  try {
    const size = fstatSync(file).size;
    const last = Buffer.alloc(1);

    return size > 0 && readSync(file, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
  } finally {
    closeSync(file);
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Files under the configured debrief directory. The runner is the only writer of `state.json` and `log/`. */
export function makeDebriefStore(dir: string): DebriefStore {
  const statePath = `${dir}/state.json`;

  return {
    readState() {
      let text;

      try {
        text = readFileSync(statePath, 'utf8');
      } catch (error) {
        return missing(error) ? structuredClone(EMPTY_DEBRIEF_STATE) : null;
      }

      try {
        const parsed = debriefState.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },

    writeState(state) {
      try {
        mkdirSync(dir, { recursive: true });
        writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
        return true;
      } catch {
        return false;
      }
    },

    appendLog(entry) {
      try {
        mkdirSync(`${dir}/log`, { recursive: true });
        const path = `${dir}/log/${entry.at.slice(0, 7)}.jsonl`;
        // A write cut short leaves a line without its newline; starting a fresh line keeps this one readable.
        appendFileSync(path, `${endsInsideLine(path) ? '\n' : ''}${JSON.stringify(entry)}\n`);
        return true;
      } catch {
        return false;
      }
    },

    logged(sessionId) {
      let names: string[];

      try {
        names = readdirSync(`${dir}/log`).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort().slice(-2);
      } catch (error) {
        return missing(error) ? { latest: null } : { unreadable: true };
      }

      let latest: LoggedDebrief | null = null;

      for (const name of names) {
        let text;

        try {
          text = readFileSync(`${dir}/log/${name}`, 'utf8');
        } catch (error) {
          if (missing(error)) continue;
          return { unreadable: true };
        }

        for (const line of text.split('\n')) {
          if (!line.includes(sessionId)) continue;

          try {
            const entry = JSON.parse(line) as Partial<DebriefLogEntry>;

            if (entry.provider === 'claude' && entry.sessionId === sessionId && typeof entry.throughMessageUuid === 'string' && typeof entry.at === 'string' && (latest === null || entry.at > latest.at)) {
              const subagents = Array.isArray(entry.subagents) ? entry.subagents.filter((id): id is string => typeof id === 'string') : [];
              latest = { throughMessageUuid: entry.throughMessageUuid, at: entry.at, startedAt: typeof entry.startedAt === 'string' ? entry.startedAt : entry.at, subagents };
            }
          } catch {
            // A line cut short by a stopped write holds no debrief.
          }
        }
      }

      return { latest };
    },
  };
}
