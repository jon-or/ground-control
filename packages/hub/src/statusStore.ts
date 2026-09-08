import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import { groundControlDirOf } from '@ground-control/core';
import type { HistoricalSession, RetainedActivity, Session } from '@ground-control/core';
import { read, writeIfChanged } from './fs.js';
import { statusPathOf } from './paths.js';

/** How a session is addressed here: two CLIs can mint the same id, and the roster already tells them apart this way. */
export function statusKeyOf(session: Pick<Session, 'agent' | 'sessionId'>): string {
  return `${session.agent}:${session.sessionId}`;
}

const entry = z.object({
  phase: z.enum(['running', 'waiting', 'idle']),
  event: z.string(),
  at: z.number(),
});

const stored = z.object({ entries: z.record(z.string(), entry).default({}) });

/**
 * The last phase the board saw each session in, kept past the session's own process. The roster is the only thing
 * that proves a session is alive, and the marker it read the phase from is deleted the moment the session ends
 * cleanly — so without this the card loses an unanswered question as soon as its window closes (R6).
 */
export interface StatusStore {
  read(): Map<string, RetainedActivity>;
  write(entries: ReadonlyMap<string, RetainedActivity>): void;
}

export function makeStatusStore(home: string): StatusStore {
  const path = statusPathOf(home);

  return {
    read(): Map<string, RetainedActivity> {
      const text = read(path);

      if (text === null) {
        return new Map();
      }

      try {
        const parsed = stored.safeParse(JSON.parse(text));

        return new Map(Object.entries(parsed.success ? parsed.data.entries : {}));
      } catch {
        return new Map();
      }
    },

    write(entries: ReadonlyMap<string, RetainedActivity>): void {
      try {
        mkdirSync(groundControlDirOf(home), { recursive: true });
        writeIfChanged(path, `${JSON.stringify({ entries: Object.fromEntries(entries) }, null, 2)}\n`);
      } catch {
        // A reading that could not be stored costs one card its mark once its window closes. Failing the render is worse.
      }
    },
  };
}

/**
 * The readings to store after a roster read. A live session's own phase outranks whatever was held for it, and a session the read did not list
 * keeps what it had — that absence is the case the store exists for.
 *
 * A reading is replaced unless it is the same phase of the same stretch of work. `PostToolBatch` lands on every tool batch of a running turn,
 * so restamping on each would rewrite this file all turn — and the moment the phase began is what a live row already counts from, so the kept
 * row reads the same number either way. `activity.since` is what tells one stretch from the next, so a session asked again after a resume
 * still takes a fresh date even though the phase has not moved: without that, its new question would be judged by the old one's date.
 */
export function retaining(
  held: ReadonlyMap<string, RetainedActivity>,
  sessions: readonly Session[],
): Map<string, RetainedActivity> {
  const next = new Map(held);

  for (const session of sessions) {
    const activity = session.activity;

    // The agent's own word that the session ended takes the reading away rather than merely declining to write one: R6 claims no mark for a
    // finished session, and a phase recorded while it was live would put the mark back the moment the CLI stopped listing it.
    if (session.finished) {
      next.delete(statusKeyOf(session));

      continue;
    }

    const key = statusKeyOf(session);

    if (!activity) {
      continue;
    }

    const held = next.get(key);

    if (held?.phase !== activity.phase || held.at < activity.since) {
      next.set(key, { phase: activity.phase, event: activity.event, at: activity.at });
    }
  }

  return next;
}

/**
 * The readings left after both the roster and the history have been read cleanly. A session in neither is one whose
 * transcript is gone, so nothing will ever show its reading again and the entry is what would grow without bound.
 */
export function pruned(
  held: ReadonlyMap<string, RetainedActivity>,
  sessions: readonly Session[],
  history: readonly HistoricalSession[],
): Map<string, RetainedActivity> {
  const known = new Set([...sessions, ...history].map(statusKeyOf));

  return new Map([...held].filter(([key]) => known.has(key)));
}
