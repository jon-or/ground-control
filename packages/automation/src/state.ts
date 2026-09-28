import { z } from 'zod';
import { ACTION_REVISION, AUTOMATABLE_ACTIONS, CREATE_WORKTREE, MERGE_TYPES } from '@ground-control/core';
import type {
  ActionOutcome,
  ActionRefusalRecord,
  ActionReport,
  ActionRun,
  ActionState,
  AutomatableAction,
  CardAction,
  Lane,
  TriageQualifier,
  WorktreeCreation,
} from '@ground-control/core';

const qualifier = z.enum(['initial', 'followup', ...MERGE_TYPES]).nullable().default(null);

/** Rolling dispatch-count window, preserved across hub restarts. */
export const DISPATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Minimum interval between automatic action checks, each of which requires fresh GitHub context. */
export const ACTION_GATE_MS = 30 * 60 * 1000;

/** Records written before the action table name the one merge there was, which was always an upstream merge. */
const LEGACY_MERGE = 'merge-upstream';

const legacyRun = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value;

  const run = value as Record<string, unknown>;

  return run['action'] === LEGACY_MERGE || run['next'] === LEGACY_MERGE
    ? {
        ...run,
        ...(run['action'] === LEGACY_MERGE ? { action: 'merge' } : {}),
        ...(run['next'] === LEGACY_MERGE ? { next: 'merge' } : {}),
        qualifier: 'upstream',
      }
    : run;
};

const actionRun = z.preprocess(legacyRun, z.object({
  key: z.string(),
  action: z.enum([...AUTOMATABLE_ACTIONS, CREATE_WORKTREE]),
  next: z.enum(AUTOMATABLE_ACTIONS).optional(),
  qualifier,
  issueNumber: z.number().int().positive().optional(),
  revision: z.number(),
  evidence: z.string(),
  startedAt: z.number(),
  endedAt: z.number().nullable().default(null),
  agent: z.string(),
  sessionId: z.string().nullable().default(null),
  shortId: z.string(),
  outcome: z.enum(['running', 'landed', 'halted', 'failed', 'stopped']),
  detail: z.string().default(''),
}));

// Drop refusals from older rules, including for actions no longer enabled.
const actionRefusal = z.object({
  action: z.enum(AUTOMATABLE_ACTIONS).nullable().default(null),
  qualifier,
  kind: z.string(),
  message: z.string(),
  at: z.number(),
  revision: z.number().default(0),
});

const sessionLink = z.object({ issueNumber: z.number().int().positive(), at: z.number() });

const actionState = z.object({
  runs: z.record(z.string(), z.unknown()).default({}),
  refusals: z.record(z.string(), z.unknown()).default({}),
  // Validate entries separately so one invalid timestamp does not reset every retry interval.
  gates: z.record(z.string(), z.unknown()).catch({}).default({}),
  dispatches: z.array(z.number()).default([]),
  links: z.record(z.string(), z.unknown()).catch({}).default({}),
});

/** How long a link survives its session's absence, since a history read can begin before the link's session was dispatched. */
export const LINK_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Parse durable action state, filtering invalid run/refusal/gate entries individually. An invalid outer shape
 * returns empty state; this fallback does not preserve prior dispatch authorization or limits.
 */
export function readActionState(stored: unknown): ActionState {
  const outer = actionState.safeParse(stored);

  if (!outer.success) {
    return { runs: {}, refusals: {}, gates: {}, dispatches: [], links: {} };
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
    links: Object.fromEntries(
      Object.entries(outer.data.links).flatMap(([key, value]) => {
        const link = sessionLink.safeParse(value);

        return link.success ? [[key, link.data]] : [];
      }),
    ),
  };
}

/**
 * Session-reported outcome. `done`, or the earlier `pushed`, maps to landed; completion is not independently
 * verified (R39). A worktree run reports `ready` with the worktree's path (R46).
 */
const actionReport = z.object({
  outcome: z.enum(['done', 'pushed', 'halted', 'ready']),
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
 * Block automatic repeats of the action under the current revision for unchanged evidence, whatever the qualifier:
 * a follow-up review of a head the initial review already read has nothing new to read. A landed run also blocks
 * changed evidence until the card's status changes after it ended, so a merge's own push cannot trigger another; a
 * reread alone is not a new request. Failed starts, older revisions, and other actions do not block; the read gate
 * limits retries. Manual requests bypass this check.
 */
export function alreadyRun(
  state: ActionState,
  key: string,
  evidence: string,
  action: AutomatableAction,
  statusChangedAt: number | null,
): boolean {
  const run = state.runs[key];

  // A worktree run has no PR evidence and is not the action; the action after it reads its own (R46).
  if (run === undefined || run.revision !== ACTION_REVISION || run.outcome === 'failed' || run.action === CREATE_WORKTREE) {
    return false;
  }

  if (run.action !== action) {
    return false;
  }

  if (run.outcome === 'landed') {
    return (statusChangedAt ?? 0) <= (run.endedAt ?? run.startedAt);
  }

  return run.evidence === evidence;
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
 * Record the attempt, and its timestamp when `counted`, regardless of its outcome. Manual requests are not counted,
 * nor is the action after its worktree run: one automatic request is one attempt against the daily limit.
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
    links: state.links,
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

/** Record the session ID resolved from the dispatch ID (M33), and link the session to the run's issue (R3). */
export function withSession(state: ActionState, key: string, sessionId: string, now: number): ActionState {
  const run = state.runs[key];

  if (run === undefined) {
    return state;
  }

  const links = run.issueNumber === undefined
    ? state.links
    : { ...state.links, [`${run.agent}:${sessionId}`]: { issueNumber: run.issueNumber, at: now } };

  return { ...state, runs: { ...state.runs, [key]: { ...run, sessionId } }, links };
}

/**
 * Drop links whose session is in neither the roster nor history. `present` must come from complete reads of both;
 * a link younger than LINK_GRACE_MS stays, since a history read can start before its session was dispatched.
 */
export function withoutAbsentLinks(state: ActionState, present: ReadonlySet<string>, now: number): ActionState {
  const links = Object.fromEntries(
    Object.entries(state.links).filter(([key, link]) => present.has(key) || now - link.at < LINK_GRACE_MS),
  );

  return Object.keys(links).length === Object.keys(state.links).length ? state : { ...state, links };
}

/** The issue each linked session belongs to, by `agent:sessionId`. */
export function sessionLinks(state: ActionState): ReadonlyMap<string, number> {
  return new Map(Object.entries(state.links).map(([key, link]) => [key, link.issueNumber]));
}

/** Persist a refusal of the row, where one was known, for display, and defer the next automatic context read. */
export function withRefusal(
  state: ActionState,
  key: string,
  refusal: { kind: string; message: string },
  now: number,
  row: { action: AutomatableAction; qualifier: TriageQualifier | null } | null = null,
): ActionState {
  return {
    ...state,
    refusals: {
      ...state.refusals,
      [key]: { action: row?.action ?? null, qualifier: row?.qualifier ?? null, ...refusal, at: now, revision: ACTION_REVISION },
    },
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

  // Links belong to sessions, not cards, so a card leaving the board keeps its sessions' links.
  return { runs, refusals: kept(state.refusals), gates: kept(state.gates), dispatches, links: state.links };
}

/**
 * What the card's triage says now, where the action table has a row for it. A card the board does not read has a
 * settled reading of no action and no time.
 */
export interface CardReading {
  action: AutomatableAction | null;
  qualifier: TriageQualifier | null;
  /** False while the card is being read again, or where its read failed: neither replaces the reading it has. */
  settled: boolean;
  /** When the reading was taken, or null where there is none. */
  at: number | null;
}

/**
 * Select action display state: running/completed result, a current refusal, a refusal recorded from an earlier attempt,
 * then availability. A recorded refusal, like availability, allows a manual request even when automatic dispatch is
 * disabled; a current one does not. A worktree run shows as the action it precedes; one
 * asked for alone shows on the worktree control instead (`worktreeCreationOf`), and the action stays offerable.
 */
export function cardActionOf(
  state: ActionState,
  key: string,
  reading: CardReading,
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
      : {
          state: 'running',
          action: shown.action,
          qualifier: shown.qualifier,
          since: shown.startedAt,
          ...(run?.action === CREATE_WORKTREE ? { stage: 'worktree' as const } : {}),
        };
  }

  if (shown !== undefined && shown.action !== CREATE_WORKTREE) {
    const ended = shown.endedAt ?? shown.startedAt;
    // A finished run describes the reading it ran under. A settled reading naming another row, or taken after the
    // run ended, replaces it; one still being read, or failed, leaves the outcome rather than blinking it out.
    const superseded =
      reading.settled && (reading.action !== shown.action || reading.qualifier !== shown.qualifier || (reading.at ?? 0) > ended);

    if (!superseded) {
      return { state: 'done', action: shown.action, qualifier: shown.qualifier, outcome: shown.outcome, detail: shown.detail, at: ended };
    }
  }

  if (reading.action === null) {
    return undefined;
  }

  const row = { action: reading.action, qualifier: reading.qualifier };

  if (offerRefusal !== null) {
    return { state: 'refused', ...row, reason: offerRefusal };
  }

  const refusal = state.refusals[key];

  // A refusal of another row, or one made before any row was known, says nothing about this reading's row.
  if (refusal !== undefined && refusal.action === reading.action && refusal.qualifier === reading.qualifier) {
    return { state: 'refused', ...row, reason: refusal.message, retryable: true };
  }

  return { state: 'available', ...row };
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
