import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import type { HistoricalSession, RetainedActivity, Session } from '@ground-control/core';
import { read, writeIfChanged } from './fs.js';
import { statusPathOf } from './paths.js';

/** Key sessions by agent and ID to avoid collisions between CLIs. */
export function statusKeyOf(session: Pick<Session, 'agent' | 'sessionId'>): string {
  return `${session.agent}:${session.sessionId}`;
}

const entry = z.object({
  phase: z.enum(['running', 'waiting', 'idle', 'failed']),
  event: z.string(),
  at: z.number(),
  error: z.object({ kind: z.string(), message: z.string().nullable() }).optional(),
});

const stored = z.object({ entries: z.record(z.string(), entry).default({}) });

/** Retain phases after session exit because clean shutdown deletes markers. The roster alone establishes liveness (R6). */
export interface StatusStore {
  read(): Map<string, RetainedActivity>;
  write(entries: ReadonlyMap<string, RetainedActivity>): void;
}

export function makeStatusStore(stateDir: string): StatusStore {
  const path = statusPathOf(stateDir);

  return {
    read(): Map<string, RetainedActivity> {
      const text = read(path);

      if (text === null) {
        return new Map();
      }

      try {
        const parsed = stored.safeParse(JSON.parse(text));

        return new Map(
          Object.entries(parsed.success ? parsed.data.entries : {}).map(([key, { error, ...rest }]) => [key, error ? { ...rest, error } : rest]),
        );
      } catch {
        return new Map();
      }
    },

    write(entries: ReadonlyMap<string, RetainedActivity>): void {
      try {
        mkdirSync(stateDir, { recursive: true });
        writeIfChanged(path, `${JSON.stringify({ entries: Object.fromEntries(entries) }, null, 2)}\n`);
      } catch {
        // A failed write may lose retained attention after session exit without failing rendering.
      }
    },
  };
}

/**
 * Retain missing sessions' observations. Replace a live observation when its phase or work interval changes;
 * same-turn PostToolBatch events must not rewrite the file continuously. Explicit finished state removes the
 * observation.
 */
export function retaining(
  held: ReadonlyMap<string, RetainedActivity>,
  sessions: readonly Session[],
): Map<string, RetainedActivity> {
  const next = new Map(held);

  for (const session of sessions) {
    const activity = session.activity;

    // Remove observations for explicitly finished sessions so they cannot restore attention after leaving the roster (R6).
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
      next.set(key, { phase: activity.phase, event: activity.event, at: activity.at, ...(activity.error ? { error: activity.error } : {}) });
    }
  }

  return next;
}

/** After complete roster and history reads, remove observations absent from both to bound retained state. */
export function pruned(
  held: ReadonlyMap<string, RetainedActivity>,
  sessions: readonly Session[],
  history: readonly HistoricalSession[],
): Map<string, RetainedActivity> {
  const known = new Set([...sessions, ...history].map(statusKeyOf));

  return new Map([...held].filter(([key]) => known.has(key)));
}
