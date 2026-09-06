import { z } from 'zod';
import { ACTION_REVISION, AUTOMATABLE_ACTIONS } from '@ground-control/core';
import type {
  ActionOutcome,
  ActionRefusalRecord,
  ActionReport,
  ActionRun,
  ActionState,
  AutomatableAction,
  CardAction,
  Lane,
} from '@ground-control/core';

/** A rolling day. What the dispatch ceiling is counted over, so a limit is not reset by a hub restarting. */
export const DISPATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How long the board leaves a card alone after answering for it. Deciding whether to act needs a fresh read of
 * GitHub, and what would change the answer is somebody pushing or writing on the card — neither of which happens
 * on the loop's timescale. Shorter than this is a board asking about a settled card every pass.
 */
export const ACTION_GATE_MS = 30 * 60 * 1000;

const actionRun = z.object({
  key: z.string(),
  action: z.enum(AUTOMATABLE_ACTIONS),
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

// The revision is what a bump clears: a card whose action is since turned off is never reconsidered, so a reason a
// retired gate wrote would otherwise sit on it for good.
const actionRefusal = z.object({ kind: z.string(), message: z.string(), at: z.number(), revision: z.number().default(0) });

const actionState = z.object({
  runs: z.record(z.string(), z.unknown()).default({}),
  refusals: z.record(z.string(), z.unknown()).default({}),
  // Read as unknown and filtered one at a time, never as a record of numbers: a typed record fails whole on one bad
  // entry, and dropping every gate at once is a board that re-reads the entire set of cards it had just answered for.
  gates: z.record(z.string(), z.unknown()).catch({}).default({}),
  dispatches: z.array(z.number()).default([]),
});

/**
 * The stored state, or an empty one. Durable and hand-editable, and one unusable entry costs that card its record
 * rather than the file: refusing the file whole would forget every run at once, and forgetting a run is what makes a
 * card eligible for another. The one failure mode here that spends money is the one that must not be silent.
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

/** What a dispatched session says it did. `pushed` is the whole of what a card reports as a landing (R23). */
const actionReport = z.object({
  outcome: z.enum(['pushed', 'halted']),
  detail: z.string().min(1),
  auditPath: z.string().optional(),
});

/** The report a run left at the path it was given, or null where there is nothing readable there. */
export function readActionReport(stored: unknown): ActionReport | null {
  const parsed = actionReport.safeParse(stored);

  return parsed.success ? parsed.data : null;
}

/**
 * Whether the board may dispatch against this evidence. A run under the current revision blocks it, because that is
 * the board having already spent a session on exactly this state of the card. What unblocks it is the card moving,
 * or the developer asking.
 *
 * A run that `landed` blocks whatever the evidence now says, because the merge it was asked for happened — and the
 * push that merge made is itself what moves `headOid`. Comparing evidence alone would have every successful merge
 * authorise the next one, and a base branch that keeps moving would have the board merging on a timer nobody asked
 * for. The request was answered; only the developer's own press asks again.
 *
 * Two runs do not block. One recorded under an older revision: a gate that has since been corrected must be able to
 * reach the cards the broken one already spent. And one that `failed` — which means no session ever started, so
 * nothing was spent on this card and nothing was done to it. A CLI that was briefly missing would otherwise cost the
 * card every retry until somebody pushed to it (R21). The read gate is what paces that retry.
 */
export function alreadyRun(state: ActionState, key: string, evidence: string): boolean {
  const run = state.runs[key];

  if (run === undefined || run.revision !== ACTION_REVISION || run.outcome === 'failed') {
    return false;
  }

  return run.outcome === 'landed' || run.evidence === evidence;
}

/** Whether a run is still open, so nothing else is dispatched for that card and the card can say it is working. */
export function running(state: ActionState, key: string): boolean {
  return state.runs[key]?.outcome === 'running';
}

/** Whether the board may read this card again for actions, which every automatic decision needs and each one costs. */
export function gateOpen(state: ActionState, key: string, now: number): boolean {
  return (state.gates[key] ?? 0) <= now;
}

/** How many dispatches fall inside the rolling day, which is what the daily ceiling is judged against. */
export function dispatchesInWindow(state: ActionState, now: number): number {
  return state.dispatches.filter((at) => now - at < DISPATCH_WINDOW_MS).length;
}

/** The state after a dispatch. The timestamp is recorded whatever the run goes on to do — starting one is the cost. */
export function withDispatch(state: ActionState, run: ActionRun, now: number): ActionState {
  const refusals = { ...state.refusals };
  delete refusals[run.key];

  return {
    runs: { ...state.runs, [run.key]: run },
    refusals,
    gates: { ...state.gates, [run.key]: now + ACTION_GATE_MS },
    dispatches: [...state.dispatches.filter((at) => now - at < DISPATCH_WINDOW_MS), now],
  };
}

/** The state after a run was settled. A key with no open run is left exactly as it is. */
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

/** The state once a run's session id is known, resolved from the roster by the short id the CLI printed (§33). */
export function withSession(state: ActionState, key: string, sessionId: string): ActionState {
  const run = state.runs[key];

  return run === undefined ? state : { ...state, runs: { ...state.runs, [key]: { ...run, sessionId } } };
}

/**
 * The state after the board declined to act. Recorded so the card can say why and so the same read is not made again
 * on the next pass — a refusal is an answer, and one worth keeping for as long as any other.
 */
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

/**
 * The state after a render. Everything about a card no longer on the board is dropped, the way triage drops its
 * entries — but only on a clean read, because a failed source read re-renders the last good cards and would
 * otherwise forget every run on the board at once.
 */
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

  // A run still working is kept whatever became of its card. The agent is in the developer's checkout either way,
  // and the record is what holds its slot against the concurrency ceiling, blocks a second dispatch, and lets the
  // run be settled when its session ends. Dropped, an issue closed mid-merge leaves a session the board has
  // forgotten. It is dropped on the pass after it settles, since by then the card is gone and the run is not running.
  const runs = kept(state.runs);

  for (const [key, run] of Object.entries(state.runs)) {
    if (run.outcome === 'running') {
      runs[key] = run;
    }
  }

  return { runs, refusals: kept(state.refusals), gates: kept(state.gates), dispatches };
}

/**
 * What one card says about its action. A run outranks a refusal, and both outrank the offer: a card the board acted
 * on says what came of it, and one it declined says why.
 *
 * A card with neither, whose reading names an action the board performs, still says `available` — because a setting
 * is not the only way to run one. The developer's own click is the other, and a card with nothing to press is a
 * feature nobody can try once before configuring it.
 */
export function cardActionOf(
  state: ActionState,
  key: string,
  action: AutomatableAction | null,
  offerRefusal: string | null,
): CardAction | undefined {
  const run = state.runs[key];

  if (run !== undefined && run.outcome === 'running') {
    return { state: 'running', action: run.action, since: run.startedAt };
  }

  if (run !== undefined) {
    return {
      state: 'done',
      action: run.action,
      outcome: run.outcome,
      detail: run.detail,
      at: run.endedAt ?? run.startedAt,
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
