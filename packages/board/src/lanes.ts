import { z } from 'zod';
import { LANE_ORDER, LANE_TITLES, STAGE_HISTORY_LIMIT, WORKFLOW_STAGES, stageStepSchema } from '@ground-control/core';
import type { ActivityPhase, Attention, CardStage, Lane, LaneId, LanedCard, RetainedActivity, StageEntry, StageStep, WorkflowStage } from '@ground-control/core';
import type { BoardCard, IssueCard, Session } from './types.js';

export { LANE_ORDER, LANE_TITLES };
export type { Attention, Lane, LaneId, LanedCard };

/** The lanes a developer may move a card into. `archived` is not one: only a status takes a card off the board. */
export const PLACEABLE_LANES: readonly LaneId[] = LANE_ORDER.filter((id) => id !== 'archived');

/** Default active board statuses; also mapped to lanes below. See mechanics M17 for all 17 statuses. */
export const DEFAULT_BOARD_STATUSES: readonly string[] = ['🎁 Assigned', '⚒️ Dev', '🔍 Dev Review'];

/**
 * Initial lane and triage mappings. Explicitly map Assigned to Unstarted so triage can determine Develop; unmapped
 * statuses require other evidence (R38).
 */
export const DEFAULT_STATUS_LANES: Readonly<Record<string, LaneId>> = {
  '🎁 Assigned': 'unstarted',
  '⚒️ Dev': 'build',
  '🔍 Dev Review': 'review',
};

/** Membership statuses, initial lanes, and developer logins. */
export interface BoardRules {
  boardStatuses: readonly string[];
  statusLanes: Readonly<Record<string, LaneId>>;
  logins: readonly string[];
}

/** Persisted placements and archive history. */
export interface CardMemory {
  /** Manual lanes by card key; otherwise infer the arrival lane. */
  placements: Record<string, LaneId>;
  /** Reported workflow stages by card key; one takes the place of a manual lane while it holds (R49). */
  stages: Record<string, CardStage>;
  /** Last archive transition by issue key. Retained activity at or before this timestamp is invalid. */
  pastMyHandsAt: Record<string, number>;
  /** Archived card keys used to detect new archive transitions. */
  archived: string[];
  /** Cards whose returned attention was cleared by a manual move. */
  seen: string[];
  /** Configured membership statuses used to detect settings changes. */
  statuses: string[];
}

export const EMPTY_MEMORY: CardMemory = { placements: {}, stages: {}, pastMyHandsAt: {}, archived: [], seen: [], statuses: [] };

/** Return independent empty state to avoid shared mutable memory. */
function emptyMemory(statuses: readonly string[]): CardMemory {
  return { placements: {}, stages: {}, pastMyHandsAt: {}, archived: [], seen: [], statuses: [...statuses] };
}

/** `mergeBoard` keys a card with no issue by the checkout its sessions share. R4 cards exist only while one runs. */
const SESSION_KEY_PREFIX = 'session:';

const laneId = z.enum(LANE_ORDER as [LaneId, ...LaneId[]]);

const stageEntry = z.object({ stage: z.enum(WORKFLOW_STAGES), note: z.string(), step: stageStepSchema.optional(), at: z.number() });

/** A stored stage; records written before steps and history read as entering their stage at their report. */
const cardStage = stageEntry.extend({
  changedAt: z.number().optional(),
  since: z.number().optional(),
  history: z.array(z.unknown()).default([]),
});

/** Drop an absent step, which `exactOptionalPropertyTypes` would otherwise carry as `undefined`. */
function entryOf(read: z.infer<typeof stageEntry>): StageEntry {
  const { step, ...rest } = read;

  return step === undefined ? rest : { ...rest, step };
}

/** Longest note a stage report keeps; a longer one is clipped (R49). */
export const STAGE_NOTE_LIMIT = 120;

/**
 * A stage yields to a status change GitHub records this long after the report. The margin absorbs clock skew between
 * this machine and GitHub, so a status set just before the report does not release it (R49).
 */
export const STAGE_RELEASE_MARGIN_MS = 60_000;

/** How long a stage waits for an issue the board does not show: one that never arrives is forgotten after this. */
export const UNSEEN_STAGE_MS = 30 * 24 * 60 * 60 * 1000;

const cardMemory = z.object({
  placements: z.record(z.string(), z.string()),
  stages: z.record(z.string(), z.unknown()).default({}),
  /** Legacy archive keys without timestamps. */
  seenPastMyHands: z.array(z.string()).default([]),
  pastMyHandsAt: z.record(z.string(), z.number()).default({}),
  archived: z.array(z.string()).default([]),
  seen: z.array(z.string()).default([]),
  // Missing legacy statuses count as a membership change and clear returned attention once.
  statuses: z.array(z.string()).default([]),
});

/** Membership is a set, so a reordered settings array is not a change. */
function sameStatuses(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
}

/** Validate persisted state, including older formats and manual edits. Return empty memory for an invalid outer shape. */
export function readMemory(stored: unknown, statuses: readonly string[], now: number = Date.now()): CardMemory {
  const parsed = cardMemory.safeParse(stored);

  if (!parsed.success) {
    return emptyMemory(statuses);
  }

  const placements: Record<string, LaneId> = {};

  // Discard invalid placements individually.
  for (const [key, lane] of Object.entries(parsed.data.placements)) {
    if (laneId.safeParse(lane).success) {
      placements[key] = lane as LaneId;
    }
  }

  const stages: Record<string, CardStage> = {};

  for (const [key, stage] of Object.entries(parsed.data.stages)) {
    const read = cardStage.safeParse(stage);

    if (read.success) {
      const { changedAt, since, history, ...current } = read.data;
      const kept = history.flatMap((entry) => {
        const one = stageEntry.safeParse(entry);

        return one.success ? [entryOf(one.data)] : [];
      });

      stages[key] = { ...entryOf(current), changedAt: changedAt ?? current.at, since: since ?? current.at, history: kept.slice(-STAGE_HISTORY_LIMIT) };
    }
  }

  const pastMyHandsAt: Record<string, number> = { ...parsed.data.pastMyHandsAt };

  // Date legacy archive entries to this read; an epoch default would accept activity from before departure.
  for (const key of parsed.data.seenPastMyHands) {
    pastMyHandsAt[key] ??= now;
  }

  // On membership changes, clear archived placements and returned attention, but preserve placements made after a return. Keep departure dates to prevent restoring invalidated activity (R6, R8).
  if (!sameStatuses(parsed.data.statuses, statuses)) {
    for (const key of parsed.data.archived) {
      delete placements[key];
      delete stages[key];
    }

    return { placements, stages, pastMyHandsAt, archived: [], seen: Object.keys(pastMyHandsAt), statuses: [...statuses] };
  }

  return { placements, stages, pastMyHandsAt, archived: parsed.data.archived, seen: parsed.data.seen, statuses: [...statuses] };
}


/** Lanes that suppress failed, idle, and running attention. */
const SETTLED_LANES: readonly LaneId[] = ['icebox', 'archived'];

/**
 * Retained running activity renders as idle because its process ended. Retained waiting still requires input,
 * and a retained failure still needs a decision.
 */
export function retainedPhase(retained: RetainedActivity): 'waiting' | 'idle' | 'failed' {
  return retained.phase === 'waiting' || retained.phase === 'failed' ? retained.phase : 'idle';
}

/**
 * Rank card attention as failed, blocked, your-turn, then running; no observed phase means no attention. Include
 * retained session state after lane departure rules have invalidated older observations. Finished sessions
 * produce no attention. Settled lanes keep only blocked (R6, R24).
 */
export function attentionOf(sessions: readonly Session[], lane: LaneId, retained?: RetainedActivity): Attention | null {
  const settled = SETTLED_LANES.includes(lane);
  const live = (phase: ActivityPhase) => sessions.some((session) => session.activity?.phase === phase && !session.finished);

  if (!settled && (live('failed') || (retained && retainedPhase(retained) === 'failed'))) {
    return 'failed';
  }

  if (live('waiting') || (retained && retainedPhase(retained) === 'waiting')) {
    return 'blocked';
  }

  if (settled) {
    return null;
  }

  if (live('idle') || retained !== undefined) {
    return 'your-turn';
  }

  return live('running') ? 'running' : null;
}

/** Attention with its source: once no session is live, retained state is the only source left (R6). */
function attentionFields(sessions: readonly Session[], lane: LaneId, retained?: RetainedActivity): Pick<LanedCard, 'attention' | 'retainedAttention'> {
  const attention = attentionOf(sessions, lane, retained);

  return attention !== null && sessions.every((session) => session.finished)
    ? { attention, retainedAttention: true }
    : { attention };
}

function authoredByDeveloper(login: string | null, logins: readonly string[]): boolean {
  return login !== null && logins.some((developerLogin) => developerLogin.toLowerCase() === login.toLowerCase());
}

/** Infer the arrival lane from current status and PR evidence (R8). Manual placement takes precedence. */
export function inferredLane(card: BoardCard, rules: BoardRules): LaneId {
  // Ad-hoc cards exist only for live sessions.
  if (card.issue === null) {
    return 'build';
  }

  const status = card.issue.status;

  // Ignore inherited keys such as `constructor`; they are not valid lane mappings.
  const mappedLane = status !== null && Object.hasOwn(rules.statusLanes, status) ? rules.statusLanes[status]! : null;

  // Build status overrides PR review state because reassigned work may need further implementation (R7).
  if (mappedLane === 'build') {
    return 'build';
  }

  const pr = card.issue.pullRequest;

  // An own open PR takes precedence over other status mappings (R7).
  if (pr !== null && pr.state === 'OPEN' && authoredByDeveloper(pr.author, rules.logins)) {
    return pr.reviewDecision === 'CHANGES_REQUESTED' || pr.isDraft ? 'build' : 'review';
  }

  return mappedLane ?? 'unstarted';
}

/** The lane each workflow stage places its card in (R49). */
const STAGE_LANES: Readonly<Record<WorkflowStage, LaneId>> = { plan: 'plan', build: 'build', review: 'review' };

/**
 * The card's reported stage while it holds: a status change GitHub records after the report hands the card back to
 * status and pull request evidence (R49).
 */
export function heldStage(card: BoardCard, stages: Record<string, CardStage>): CardStage | undefined {
  const stage = stages[card.key];

  if (stage === undefined || card.issue === null) {
    return undefined;
  }

  const changed = card.issue.statusChangedAt === null ? Number.NaN : Date.parse(card.issue.statusChangedAt);

  // Counted from the report that set the note, so a heartbeat cannot undo a status change made since.
  return changed > stage.changedAt + STAGE_RELEASE_MARGIN_MS ? undefined : stage;
}

/** Use a held workflow stage, then a valid manual placement, otherwise infer the lane. */
function placed(card: BoardCard, rules: BoardRules, placements: Record<string, LaneId>, stage: CardStage | undefined): LaneId {
  if (stage !== undefined) {
    return STAGE_LANES[stage.stage];
  }

  const lane = placements[card.key];

  return lane !== undefined && PLACEABLE_LANES.includes(lane) ? lane : inferredLane(card, rules);
}

/** Explain exclusion from assigned issues; closed issues may still be assigned to the developer. */
function offBoardReason(issue: IssueCard, rules: BoardRules): string {
  if (issue.state === 'CLOSED') {
    return 'Closed';
  }

  const yours = issue.assignees.some((login) => authoredByDeveloper(login, rules.logins));
  const head = yours ? 'no longer among the issues your board reads' : 'not assigned to you';

  return issue.status === null ? head[0]!.toUpperCase() + head.slice(1) : `${issue.status} — ${head}`;
}

function place(card: BoardCard, rules: BoardRules, onBoard: ReadonlySet<string>, memory: CardMemory): LanedCard {
  const stage = heldStage(card, memory.stages);
  const lane = placed(card, rules, memory.placements, stage);
  const retained = card.lastSession?.retained;
  const inLane = (id: LaneId, reason: string): LanedCard => ({
    ...card,
    lane: id,
    returned: false,
    ...attentionFields(card.sessions, id, retained),
    // An archived card has left the workflow, and `nextMemory` drops its stage.
    ...(stage === undefined || id === 'archived' ? {} : { stage }),
    reason,
  });

  if (card.issue === null) {
    return inLane(lane, 'Ad-hoc work with no issue.');
  }

  const status = card.issue.status;
  const running = card.sessions.some((session) => !session.finished);

  // Archive unassigned issues even with active sessions (R9).
  if (card.unassigned) {
    return inLane('archived', `${offBoardReason(card.issue, rules)}.`);
  }

  // An assigned issue that is not on the project board has no status to judge, and R1 still puts it on the board.
  if (status === null || onBoard.has(status)) {
    return inLane(lane, status ?? 'Not on the project board.');
  }

  // R2 outranks R9: a status that would archive the card cannot hide a session still running on it.
  return running
    ? inLane(lane, `${status} — session still active.`)
    : inLane('archived', `${status} — outside active board statuses.`);
}

/** Remove retained activity at or before the last archive transition, before either client renders it (R9). */
function withoutExpiredActivity(card: BoardCard, pastMyHandsAt: Record<string, number>): BoardCard {
  const retained = card.lastSession?.retained;

  if (!retained || retained.at > (pastMyHandsAt[card.key] ?? 0)) {
    return card;
  }

  const { retained: _dropped, ...lastSession } = card.lastSession!;

  return { ...card, lastSession };
}

/** When the card entered the developer's queue, as its age shows it; null for a card with no issue time. */
function queueTime(card: BoardCard): number | null {
  const at = Date.parse(card.issue?.queuedAt ?? card.issue?.statusChangedAt ?? '');

  return Number.isNaN(at) ? null : at;
}

/** Oldest in the queue first; undated cards last. `Array.prototype.sort` is stable, so ties keep merge order. */
function byQueueTime(cards: LanedCard[]): LanedCard[] {
  return cards
    .map((card) => ({ card, at: queueTime(card) }))
    .sort((a, b) => (a.at === null ? (b.at === null ? 0 : 1) : b.at === null ? -1 : a.at - b.at))
    .map(({ card }) => card);
}

/**
 * Assign every card to one lane (R8). Return every lane, with returned cards first, then each group ordered by
 * queue time.
 */
export function assignLanes(cards: BoardCard[], rules: BoardRules, memory: CardMemory): Lane[] {
  const onBoard = new Set(rules.boardStatuses);
  const seen = new Set(memory.seen);

  const laned = cards.map((card) => {
    const result = place(withoutExpiredActivity(card, memory.pastMyHandsAt), rules, onBoard, memory);
    const returned =
      card.issueNumber !== null &&
      memory.pastMyHandsAt[card.key] !== undefined &&
      !seen.has(card.key) &&
      result.lane !== 'archived';

    return { ...result, returned };
  });

  return LANE_ORDER.map((id) => {
    const laneCards = laned.filter((card) => card.lane === id);

    return {
      id,
      title: LANE_TITLES[id],
      cards: [...byQueueTime(laneCards.filter((card) => card.returned)), ...byQueueTime(laneCards.filter((card) => !card.returned))],
    };
  });
}

/**
 * Save manual placement and clear returned attention. Keep the departure timestamp used to invalidate retained
 * activity. A manual move takes the card out of its workflow stage (R49).
 */
export function withPlacement(memory: CardMemory, key: string, lane: LaneId): CardMemory {
  if (!PLACEABLE_LANES.includes(lane)) {
    return memory;
  }

  const { [key]: _released, ...stages } = memory.stages;

  return {
    ...memory,
    placements: { ...memory.placements, [key]: lane },
    stages,
    seen: memory.seen.includes(key) ? memory.seen : [...memory.seen, key],
  };
}

/**
 * Record a reported workflow stage, which replaces any manual placement, or release the card with `done` so status
 * and pull request evidence place it again (R49). A report acknowledges a return as a manual move does.
 */
export function withStage(
  memory: CardMemory,
  key: string,
  stage: WorkflowStage | 'done',
  note: string,
  at: number,
  step?: StageStep,
): CardMemory {
  const { [key]: _placed, ...placements } = memory.placements;
  const { [key]: previous, ...stages } = memory.stages;

  if (stage !== 'done') {
    const clipped = clipNote(note);
    const repeated = previous !== undefined && previous.stage === stage && previous.note === clipped &&
      previous.step?.n === step?.n && previous.step?.of === step?.of;
    // A repeated report is a heartbeat: it refreshes the time and adds nothing to the history.
    const history = previous === undefined || repeated
      ? previous?.history ?? []
      : [...previous.history, entryOf({ stage: previous.stage, note: previous.note, step: previous.step, at: previous.changedAt })].slice(-STAGE_HISTORY_LIMIT);
    const since = previous !== undefined && previous.stage === stage ? previous.since : at;
    const changedAt = repeated ? previous.changedAt : at;

    stages[key] = { stage, note: clipped, ...(step === undefined ? {} : { step }), at, changedAt, since, history };
  }

  return { ...memory, placements, stages, seen: memory.seen.includes(key) ? memory.seen : [...memory.seen, key] };
}

/** One line of at most `STAGE_NOTE_LIMIT` characters. */
export function clipNote(note: string): string {
  const line = note.replace(/\s+/g, ' ').trim();

  return line.length > STAGE_NOTE_LIMIT ? `${line.slice(0, STAGE_NOTE_LIMIT - 1)}…` : line;
}

/** Read active statuses from settings; fall back to defaults for invalid or empty lists. */
export function boardStatuses(configured: unknown): string[] {
  const statuses = Array.isArray(configured) ? configured.filter((s) => typeof s === 'string') : [];

  return statuses.length > 0 ? statuses : [...DEFAULT_BOARD_STATUSES];
}

/** Read valid placeable lanes from settings. Preserve an empty map; use defaults only for an invalid outer shape. */
export function statusLanes(configured: unknown): Record<string, LaneId> {
  if (configured === null || typeof configured !== 'object' || Array.isArray(configured)) {
    return { ...DEFAULT_STATUS_LANES };
  }

  const map: Record<string, LaneId> = {};

  for (const [status, lane] of Object.entries(configured)) {
    if (laneId.safeParse(lane).success && PLACEABLE_LANES.includes(lane as LaneId)) {
      map[status] = lane as LaneId;
    }
  }

  return map;
}

/** Remove archived card placements and, after a successful session read, placements for absent ad-hoc cards. */
export function nextMemory(lanes: Lane[], memory: CardMemory, sessionsRead: boolean, now: number = Date.now()): CardMemory {
  const pastMyHandsAt = { ...memory.pastMyHandsAt };
  const seen = new Set(memory.seen);
  const shown = new Set<string>();
  // Preserve archive history across incomplete renders so absent cards are not redated on the next render.
  const archived = new Set(memory.archived);
  const nowArchived = new Set<string>();

  for (const lane of lanes) {
    for (const card of lane.cards) {
      shown.add(card.key);

      if (lane.id !== 'archived' || card.issueNumber === null) {
        archived.delete(card.key);

        continue;
      }

      // Timestamp only new archive transitions; repeated renders must not invalidate newer activity or rewrite unchanged state.
      if (!archived.has(card.key)) {
        pastMyHandsAt[card.key] = now;
      }

      // Clear returned attention while archived, including after a manual move.
      seen.delete(card.key);
      archived.add(card.key);
      nowArchived.add(card.key);
    }
  }

  const placements: Record<string, LaneId> = {};

  for (const [key, lane] of Object.entries(memory.placements)) {
    // Re-archiving cached cards only removes placements already invalidated by the previous archive transition.
    if (nowArchived.has(key)) {
      continue;
    }

    // A failed session read cannot establish that a session ended.
    if (sessionsRead && key.startsWith(SESSION_KEY_PREFIX) && !shown.has(key)) {
      continue;
    }

    placements[key] = lane;
  }

  // An archived card keeps its stage only where the report followed its departure, for its return. A stage a status
  // change released is kept too, so a heartbeat repeating it stays released; it and an unread issue's go after a while.
  const holding = new Set(lanes.flatMap((lane) => lane.cards).filter((card) => card.stage !== undefined).map((card) => card.key));
  const stages: Record<string, CardStage> = {};

  for (const [key, stage] of Object.entries(memory.stages)) {
    const kept = holding.has(key) ||
      (nowArchived.has(key) && stage.at > (pastMyHandsAt[key] ?? 0)) ||
      (!nowArchived.has(key) && now - stage.at < UNSEEN_STAGE_MS);

    if (kept) {
      stages[key] = stage;
    }
  }

  return { ...memory, placements, stages, pastMyHandsAt, archived: [...archived], seen: [...seen] };
}
