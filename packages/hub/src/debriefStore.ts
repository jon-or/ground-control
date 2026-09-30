import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
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
});

export type SessionDebriefState = z.infer<typeof sessionState>;
export type CodexDebriefState = z.infer<typeof codexState>;
export type DebriefState = z.infer<typeof debriefState>;

export const EMPTY_DEBRIEF_STATE: DebriefState = { v: 1, sessions: {}, codex: {} };

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
}

/** The newest Claude line for a session, none, or a log that could not be read. */
export type LoggedReading = { latest: { throughMessageUuid: string; at: string } | null } | { unreadable: true };

export interface DebriefStore {
  /** The state, empty when the file does not exist, or null when it exists and cannot be read. */
  readState(): DebriefState | null;
  writeState(state: DebriefState): boolean;
  appendLog(entry: DebriefLogEntry): boolean;
  /** The newest Claude line for this session in the two newest log files. */
  logged(sessionId: string): LoggedReading;
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
        appendFileSync(`${dir}/log/${entry.at.slice(0, 7)}.jsonl`, `${JSON.stringify(entry)}\n`);
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

      let latest: { throughMessageUuid: string; at: string } | null = null;

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
              latest = { throughMessageUuid: entry.throughMessageUuid, at: entry.at };
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
