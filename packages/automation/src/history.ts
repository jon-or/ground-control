import { z } from 'zod';
import { AUTOMATABLE_ACTIONS, CREATE_WORKTREE } from '@ground-control/core';
import type { ActionHistoryEntry, ActionState } from '@ground-control/core';

/** Entries the history keeps; the oldest go first when it overflows (R50). */
export const HISTORY_LIMIT = 500;

/** How long an entry is kept after its run started. */
export const HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const entry = z.object({
  id: z.string(),
  key: z.string(),
  issueNumber: z.number().int().positive().nullable(),
  action: z.enum([...AUTOMATABLE_ACTIONS, CREATE_WORKTREE]),
  next: z.enum(AUTOMATABLE_ACTIONS).optional().catch(undefined),
  qualifier: z.string().nullable(),
  trigger: z.enum(['automatic', 'editor', 'browser']).optional().catch(undefined),
  agent: z.string(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  outcome: z.enum(['running', 'landed', 'halted', 'failed', 'stopped']),
  detail: z.string(),
});

/** Parse stored history, dropping entries it cannot read one by one. */
export function readActionHistory(stored: unknown): ActionHistoryEntry[] {
  const list = z.object({ entries: z.array(z.unknown()) }).safeParse(stored);

  if (!list.success) return [];

  return list.data.entries.flatMap((value) => {
    const read = entry.safeParse(value);

    return read.success ? [read.data as ActionHistoryEntry] : [];
  });
}

/**
 * Fold the runs in `state` into the history: a run not recorded yet is added, and a recorded one takes its current
 * outcome. A run replaced in the state keeps the last outcome it was recorded with. Oldest first; entries past the
 * retention window or the limit are dropped.
 */
export function historyWith(history: readonly ActionHistoryEntry[], state: ActionState, now: number): ActionHistoryEntry[] {
  const byId = new Map(history.map((one) => [one.id, one]));

  for (const [key, run] of Object.entries(state.runs)) {
    const id = `${key}@${run.startedAt}`;
    const next: ActionHistoryEntry = {
      id,
      key: run.for?.key ?? key,
      issueNumber: run.issueNumber ?? null,
      action: run.action,
      ...(run.next === undefined ? {} : { next: run.next }),
      qualifier: run.qualifier,
      ...(run.trigger === undefined ? {} : { trigger: run.trigger }),
      agent: run.agent,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      outcome: run.outcome,
      detail: run.detail,
    };

    byId.set(id, next);
  }

  return [...byId.values()]
    .filter((one) => now - one.startedAt < HISTORY_RETENTION_MS)
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(-HISTORY_LIMIT);
}
