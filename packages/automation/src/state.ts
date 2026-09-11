import { z } from 'zod';
import { ACTION_REVISION, AUTOMATABLE_ACTIONS, CREATE_WORKTREE } from '@ground-control/core';
import type {
  ActionOutcome,
  ActionRefusalRecord,
  ActionReport,
  ActionRun,
  ActionState,
  AutomatableAction,
  CardAction,
  Lane,
  WorktreeCreation,
} from '@ground-control/core';

/** Rolling dispatch-count window, preserved across hub restarts. */
export const DISPATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Minimum interval between automatic action checks, each of which requires fresh GitHub context. */
export const ACTION_GATE_MS = 30 * 60 * 1000;

const actionRun = z.object({
  key: z.string(),
  action: z.enum([...AUTOMATABLE_ACTIONS, CREATE_WORKTREE]),
  next: z.enum(AUTOMATABLE_ACTIONS).optional(),
  revision: z.number(),
  evidence: z.string(),
  startedAt: z.number(),
  endedAt: z.number().nullable().default(null),
  agent: z.string(),
  sessionId: z.string().nullable().default(null),
  shortId: z.string(),
  outcome: z.enum(['running', 'landed', 'halted', 'failed', 'stopped']),
  detail: z.string().default(''),
});

// Drop refusals from older rules, including for actions no longer enabled.
const actionRefusal = z.object({ kind: z.string(), message: z.string(), at: z.number(), revision: z.number().default(0) });

const actionState = z.object({
  runs: z.record(z.string(), z.unknown()).default({}),
  refusals: z.record(z.string(), z.unknown()).default({}),
  // Validate entries separately so one invalid timestamp does not reset every retry interval.
  gates: z.record(z.string(), z.unknown()).catch({}).default({}),
  dispatches: z.array(z.number()).default([]),
});

/**
 * Parse durable action state, filtering invalid run/refusal/gate entries individually. An invalid outer shape
 * returns empty state; this fallback does not preserve prior dispatch authorization or limits.
 */
export function readActionState(stored: unknown): ActionState {
  const outer = actionState.safeParse(stored);

  if (!outer.success) {
    return { runs: {}, refusals: {}, gates: {}, dispatches: [] };
  }

  const runs: Record<string, ActionRun> = {};
  const refusals: Record<string, ActionRefusalRecord> = {};

  for (const [key, value] of Object.entries(outer.data.runs)) {
    const run = actionRun.safeParse(value);

    if (run.success) {
      runs[key] = run.data;
    }
  }

  for (const [key, value] of Object.entries(outer.data.refusals)) {
    const refusal = actionRefusal.safeParse(value);

    if (refusal.success && refusal.data.revision === ACTION_REVISION) {
      refusals[key] = refusal.data;
    }
  }

  return {
    runs,
    refusals,
    gates: Object.fromEntries(
      Object.entries(outer.data.gates).flatMap(([key, at]) => (typeof at === 'number' && Number.isFinite(at) ? [[key, at]] : [])),
    ),
    dispatches: outer.data.dispatches.filter((at) => Number.isFinite(at)),
  };
}

/**
 * Session-reported outcome. `pushed` maps to landed; completion is not independently verified (R39). A worktree
 * run reports `ready` with the worktree's path (R46).
 */
const actionReport = z.object({
  outcome: z.enum(['pushed', 'halted', 'ready']),
  detail: z.string().min(1),
  auditPath: z.string().optional(),
  worktree: z.string().min(1).optional(),
});

/** Parse the session result file, or return null for invalid data. */
export function readActionReport(stored: unknown): ActionReport | null {
  const parsed = actionReport.safeParse(stored);

  return parsed.success ? parsed.data : null;
}

/**
 * Block automatic repeats under the current revision for unchanged evidence. A landed run also blocks changed
 * evidence so its own push cannot trigger another merge. Failed starts and older revisions do not block; the
 * read gate limits retries. Manual requests bypass this check.
 */
export function alreadyRun(state: ActionState, key: string, evidence: string): boolean {
  const run = state.runs[key];

  // A worktree run has no PR evidence and is not the action; the action after it reads its own (R46).
  if (run === undefined || run.revision !== ACTION_REVISION || run.outcome === 'failed' || run.action === CREATE_WORKTREE) {
    return false;
  }

  return run.outcome === 'landed' || run.evidence === evidence;
}

/** Whether a card has a running action, preventing another dispatch. */
export function running(state: ActionState, key: string): boolean {
  return state.runs[key]?.outcome === 'running';
}

/** Whether the next automatic action check is due. */
export function gateOpen(state: ActionState, key: string, now: number): boolean {
  return (state.gates[key] ?? 0) <= now;
}

/** Count dispatch attempts in the rolling limit window. */
export function dispatchesInWindow(state: ActionState, now: number): number {
  return state.dispatches.filter((at) => now - at < DISPATCH_WINDOW_MS).length;
}

/**
 * Record the attempt and timestamp regardless of its outcome. A run that continues one already counted — the
 * action after its worktree run — is not counted again: one request is one attempt against the daily limit.
 */
export function withDispatch(state: ActionState, run: ActionRun, now: number, counted = true): ActionState {
  const refusals = { ...state.refusals };
  delete refusals[run.key];
  const dispatches = state.dispatches.filter((at) => now - at < DISPATCH_WINDOW_MS);

  return {
    runs: { ...state.runs, [run.key]: run },
    refusals,
    gates: { ...state.gates, [run.key]: now + ACTION_GATE_MS },
    dispatches: counted ? [...dispatches, now] : dispatches,
  };
}

/** Record an outcome if the run exists. */
export function withOutcome(
  state: ActionState,
  key: string,
  outcome: ActionOutcome,
  detail: string,
  now: number,
): ActionState {
  const run = state.runs[key];

  if (run === undefined) {
    return state;
  }

  return { ...state, runs: { ...state.runs, [key]: { ...run, outcome, detail, endedAt: now } } };
}

/** Record the session ID resolved from the dispatch ID (M33). */
export function withSession(state: ActionState, key: string, sessionId: string): ActionState {
  const run = state.runs[key];

  return run === undefined ? state : { ...state, runs: { ...state.runs, [key]: { ...run, sessionId } } };
}

/** Persist a refusal for display and defer the next automatic context read. */
export function withRefusal(
  state: ActionState,
  key: string,
  refusal: { kind: string; message: string },
  now: number,
): ActionState {
  return {
    ...state,
    refusals: { ...state.refusals, [key]: { ...refusal, at: now, revision: ACTION_REVISION } },
    gates: { ...state.gates, [key]: now + ACTION_GATE_MS },
  };
}

/** After a successful source read, remove state for absent cards, except running actions. Retain state on failed reads. */
export function nextActionState(
  lanes: readonly Lane[],
  state: ActionState,
  sourcesRead: boolean,
  now: number,
): ActionState {
  const dispatches = state.dispatches.filter((at) => now - at < DISPATCH_WINDOW_MS);

  if (!sourcesRead) {
    return { ...state, dispatches };
  }

  const shown = new Set(lanes.flatMap((lane) => lane.cards.map((card) => card.key)));
  const kept = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([key]) => shown.has(key)));

  // Keep running actions for absent cards to count concurrency, block duplicate dispatch, and record completion. Remove them after completion on the next pass.
  const runs = kept(state.runs);

  for (const [key, run] of Object.entries(state.runs)) {
    if (run.outcome === 'running') {
      runs[key] = run;
    }
  }

  return { runs, refusals: kept(state.refusals), gates: kept(state.gates), dispatches };
}

/**
 * Select action display state: running/completed result, refusal, then availability. Availability allows a
 * manual request even when automatic dispatch is disabled. A worktree run shows as the action it precedes; one
 * asked for alone shows on the worktree control instead (`worktreeCreationOf`), and the action stays offerable.
 */
export function cardActionOf(
  state: ActionState,
  key: string,
  action: AutomatableAction | null,
  offerRefusal: string | null,
): CardAction | undefined {
  const run = state.runs[key];
  // A worktree run stands for the action it precedes while running, and where it ended short of the action; one
  // that linked its worktree is over, and the action's own record or refusal follows.
  const shown = run === undefined || run.action !== CREATE_WORKTREE
    ? run
    : run.next === undefined || run.outcome === 'landed' ? undefined : { ...run, action: run.next };

  if (shown !== undefined && shown.outcome === 'running') {
    return shown.action === CREATE_WORKTREE
      ? undefined
      : { state: 'running', action: shown.action, since: shown.startedAt, ...(run?.action === CREATE_WORKTREE ? { stage: 'worktree' as const } : {}) };
  }

  if (shown !== undefined && shown.action !== CREATE_WORKTREE) {
    return {
      state: 'done',
      action: shown.action,
      outcome: shown.outcome,
      detail: shown.detail,
      at: shown.endedAt ?? shown.startedAt,
    };
  }

  if (action === null) {
    return undefined;
  }

  const refusal = state.refusals[key];

  if (refusal !== undefined) {
    return { state: 'refused', action, reason: refusal.message };
  }

  return offerRefusal === null ? { state: 'available', action } : { state: 'refused', action, reason: offerRefusal };
}

/**
 * The worktree control's state on a card with no worktree (R46): the run making one, its outcome where it made
 * none, else the offer or its refusal. The caller omits it where the card has a worktree or is read-only.
 */
export function worktreeCreationOf(state: ActionState, key: string, offerRefusal: string | null): WorktreeCreation {
  const run = state.runs[key];

  if (run?.action === CREATE_WORKTREE && run.outcome === 'running') {
    return { state: 'running', since: run.startedAt };
  }

  if (run?.action === CREATE_WORKTREE) {
    return { state: 'done', outcome: run.outcome, detail: run.detail, at: run.endedAt ?? run.startedAt };
  }

  return offerRefusal === null ? { state: 'available' } : { state: 'refused', reason: offerRefusal };
}
