import { z } from 'zod';
import { LANE_ORDER, LANE_TITLES } from '@ground-control/core';
import type { Attention, Lane, LaneId, LanedCard, RetainedActivity } from '@ground-control/core';
import type { BoardCard, IssueCard, Session } from './types.js';

export { LANE_ORDER, LANE_TITLES };
export type { Attention, Lane, LaneId, LanedCard };

/** The lanes a developer may move a card into. `archived` is not one: only a status takes a card off the board. */
export const PLACEABLE_LANES: readonly LaneId[] = LANE_ORDER.filter((id) => id !== 'archived');

/**
 * The statuses whose cards stay on the board. Each also names a stage, in `DEFAULT_STATUS_LANES`.
 * `docs/mechanics.md` M17 lists all 17 and what they mean.
 */
export const DEFAULT_BOARD_STATUSES: readonly string[] = ['🎁 Assigned', '⚒️ Dev', '🔍 Dev Review'];

/**
 * The statuses that carry a lane, for a card the developer has never placed. A status the map does not name says nothing about stage and
 * leaves the card to its other signals.
 *
 * Triage reads the same map for what a status means (R38), which is why 🎁 Assigned is named although an unmapped status already
 * arrives in Unstarted: the lane it gives is the one the card had anyway, and the meaning it gives is what the label turns on.
 */
export const DEFAULT_STATUS_LANES: Readonly<Record<string, LaneId>> = {
  '🎁 Assigned': 'unstarted',
  '⚒️ Dev': 'build',
  '🔍 Dev Review': 'review',
};

/** What the board judges a card against: which statuses keep it, which carry a lane, and whose pull requests are the developer's own. */
export interface BoardRules {
  boardStatuses: readonly string[];
  statusLanes: Readonly<Record<string, LaneId>>;
  logins: readonly string[];
}

/** What the board remembers per card: where the developer put it, and when it was last off the board. */
export interface CardMemory {
  /** Card key to the lane the developer moved it into. A card absent here has never been moved, and arrives on its own evidence. */
  placements: Record<string, LaneId>;
  /**
   * Card key to when it was last rendered archived. Issue keys only — work with no issue never left. A date rather than a set, because it is
   * what a session's retained reading is judged against: a card that came back after the reading has ended the pass the reading belonged to.
   */
  pastMyHandsAt: Record<string, number>;
  /** The cards the last render put in Archived, so the next one can tell a card newly past the developer's hands from one that has sat there. */
  archived: string[];
  /** The returned cards the developer has placed since. Moving one is the only evidence they have seen it, and it is what clears the mark. */
  seen: string[];
  /** The membership set this memory was written against. A changed one carries cards across the archive line for reasons no card caused. */
  statuses: string[];
}

export const EMPTY_MEMORY: CardMemory = { placements: {}, pastMyHandsAt: {}, archived: [], seen: [], statuses: [] };

/** A caller may keep what it is handed, so an unusable stored value yields its own empty memory, not a shared one. */
function emptyMemory(statuses: readonly string[]): CardMemory {
  return { placements: {}, pastMyHandsAt: {}, archived: [], seen: [], statuses: [...statuses] };
}

/** `mergeBoard` keys a card with no issue by the checkout its sessions share. R4 cards exist only while one runs. */
const SESSION_KEY_PREFIX = 'session:';

const laneId = z.enum(LANE_ORDER as [LaneId, ...LaneId[]]);

const cardMemory = z.object({
  placements: z.record(z.string(), z.string()),
  /** The bare key list an older build wrote: it carries the marks without the dates a reading is judged against. */
  seenPastMyHands: z.array(z.string()).default([]),
  pastMyHandsAt: z.record(z.string(), z.number()).default({}),
  archived: z.array(z.string()).default([]),
  seen: z.array(z.string()).default([]),
  // Absent from a memory written before the set was recorded, which reads as a change and costs that developer their seen marks once.
  statuses: z.array(z.string()).default([]),
});

/** Membership is a set, so a reordered settings array is not a change. */
function sameStatuses(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
}

/**
 * The stored memory, or an empty one. This is durable state a developer can hand-edit and an older build can have
 * written in another shape, and an unparsed read of it throws on every render with no way back but clearing it.
 */
export function readMemory(stored: unknown, statuses: readonly string[], now: number = Date.now()): CardMemory {
  const parsed = cardMemory.safeParse(stored);

  if (!parsed.success) {
    return emptyMemory(statuses);
  }

  const placements: Record<string, LaneId> = {};

  // One unreadable entry drops that card back to the lane it would arrive in; it does not cost the developer every other placement.
  for (const [key, lane] of Object.entries(parsed.data.placements)) {
    if (laneId.safeParse(lane).success) {
      placements[key] = lane as LaneId;
    }
  }

  const pastMyHandsAt: Record<string, number> = { ...parsed.data.pastMyHandsAt };

  // An older build recorded that a card had been archived but not when. Dated to this read, which is the earliest moment this build can
  // stand behind: dating it to the epoch instead would let a reading taken before the archive read as one taken after it.
  for (const key of parsed.data.seenPastMyHands) {
    pastMyHandsAt[key] ??= now;
  }

  // A changed membership set carries cards across the archive line wholesale, which is not any of them coming back. The lane a card that is
  // off the board holds goes with the marks: it belongs to a pass past the developer's hands that the old set had already ended. Only those —
  // a card that returned and was placed since is in this pass, and taking its lane would be R8 broken by a settings edit.
  //
  // The departure dates stay and every one of them reads as seen: forgetting when a card went would un-end a reading the departure had
  // ended, and R6 gives nothing that power, while marking them seen is what keeps the edit from reading as a dozen cards returning at once.
  if (!sameStatuses(parsed.data.statuses, statuses)) {
    for (const key of parsed.data.archived) {
      delete placements[key];
    }

    return { placements, pastMyHandsAt, archived: [], seen: Object.keys(pastMyHandsAt), statuses: [...statuses] };
  }

  return { placements, pastMyHandsAt, archived: parsed.data.archived, seen: parsed.data.seen, statuses: [...statuses] };
}


/** Lanes where the developer has already said the card is not theirs to push on, so an agent finishing there asks nothing of them. */
const SETTLED_LANES: readonly LaneId[] = ['done', 'icebox', 'archived'];

/**
 * The phase a reading kept past its own process renders and reads as. `running` is the one that cannot stand: the process is gone, so the work
 * stopped mid-turn, and that is the developer's move — which is `idle`'s answer, drawn in `idle`'s colour so the row and the card agree.
 */
export function retainedPhase(retained: RetainedActivity): 'waiting' | 'idle' {
  return retained.phase === 'waiting' ? 'waiting' : 'idle';
}

/**
 * Rank card attention as blocked, your-turn, then running; no observed phase means no attention. Include
 * retained session state after lane departure rules have invalidated older observations. Finished sessions do
 * not retain blocked attention (R6, R24).
 */
export function attentionOf(sessions: readonly Session[], lane: LaneId, retained?: RetainedActivity): Attention | null {
  // A finished agent cannot be blocked on anybody. Its last event can still be a prompt it never got past, and reading that as blocked
  // would leave a dead session saying "waiting for input" for as long as the CLI keeps listing it.
  if (sessions.some((session) => session.activity?.phase === 'waiting' && !session.finished)) {
    return 'blocked';
  }

  if (retained && retainedPhase(retained) === 'waiting') {
    return 'blocked';
  }

  if (SETTLED_LANES.includes(lane)) {
    return null;
  }

  if (sessions.some((session) => session.activity?.phase === 'idle') || retained !== undefined) {
    return 'your-turn';
  }

  // A session the agent called finished is not working, whatever its last event was — the same reading `blocked` takes, for the same reason.
  return sessions.some((session) => session.activity?.phase === 'running' && !session.finished) ? 'running' : null;
}

function authoredByDeveloper(login: string | null, logins: readonly string[]): boolean {
  return login !== null && logins.some((mine) => mine.toLowerCase() === login.toLowerCase());
}

/**
 * Where a card arrives, read from what the world says about it. Recomputed on every render for a card the developer has never placed, so a
 * pull request opening or a status moving carries the card with no new state. This is R8's arrival table; a placement outranks it.
 */
export function inferredLane(card: BoardCard, rules: BoardRules): LaneId {
  // Work with no issue is on the board only while its agent runs, so the running is the only thing there is to read.
  if (card.issue === null) {
    return 'build';
  }

  const status = card.issue.status;

  // `hasOwn`, because a status named after something on Object's prototype would otherwise resolve to a function, and a lane no lane
  // list holds takes the card off every lane at once — R8 broken far worse than a wrong lane.
  const named = status !== null && Object.hasOwn(rules.statusLanes, status) ? rules.statusLanes[status]! : null;

  // A status naming Build outranks the pull request: work comes back to a developer by being reassigned and moved to ⚒️ Dev, so a review
  // decision that asked for nothing is no evidence the code is finished (R7).
  if (named === 'build') {
    return 'build';
  }

  const pr = card.issue.pullRequest;

  // Otherwise the developer's own open pull request outranks the status: a review asking for changes is code to change (R7).
  if (pr !== null && pr.state === 'OPEN' && authoredByDeveloper(pr.author, rules.logins)) {
    return pr.reviewDecision === 'CHANGES_REQUESTED' || pr.isDraft ? 'build' : 'review';
  }

  return named ?? 'unstarted';
}

/** Where the developer last put this card, ignoring a stored lane that is not one they can choose. */
function placed(card: BoardCard, rules: BoardRules, placements: Record<string, LaneId>): LaneId {
  const lane = placements[card.key];

  return lane !== undefined && PLACEABLE_LANES.includes(lane) ? lane : inferredLane(card, rules);
}

/**
 * Why a card a session named is not among the developer's assigned issues. Closing an issue takes it out of the
 * search as surely as being unassigned does, so a card still in their name reads as closed rather than as somebody
 * else's — saying "not assigned to you" about an issue they are assigned to is the board stating a falsehood.
 */
function offBoardReason(issue: IssueCard, rules: BoardRules): string {
  if (issue.state === 'CLOSED') {
    return 'Closed';
  }

  const yours = issue.assignees.some((login) => authoredByDeveloper(login, rules.logins));
  const head = yours ? 'no longer among the issues your board reads' : 'not assigned to you';

  return issue.status === null ? head[0]!.toUpperCase() + head.slice(1) : `${issue.status} — ${head}`;
}

function place(card: BoardCard, rules: BoardRules, onBoard: ReadonlySet<string>, placements: Record<string, LaneId>): LanedCard {
  const lane = placed(card, rules, placements);
  const retained = card.lastSession?.retained;
  const base = { ...card, lane, returned: false, attention: attentionOf(card.sessions, lane, retained) };

  if (card.issue === null) {
    return { ...base, reason: 'Ad-hoc work with no issue.' };
  }

  const status = card.issue.status;
  const running = card.sessions.some((session) => !session.finished);
  const archive = (reason: string): LanedCard => ({
    ...base,
    lane: 'archived',
    attention: attentionOf(card.sessions, 'archived', retained),
    reason,
  });

  // R9 read on assignment rather than on status, and with no exception for a session still on it: a status is a claim
  // about the work, which an agent can outrun, and this is a claim about whose it is, which it cannot.
  if (card.unassigned) {
    return archive(`${offBoardReason(card.issue, rules)}.`);
  }

  // An assigned issue that is not on the project board has no status to judge, and R1 still puts it on the board.
  if (status === null || onBoard.has(status)) {
    return { ...base, reason: status ?? 'Not on the project board.' };
  }

  // R2 outranks R9: a status that would archive the card cannot hide a session still running on it.
  return running
    ? { ...base, reason: `${status} — session still active.` }
    : archive(`${status} — outside active board statuses.`);
}

/**
 * A card's saved session with a reading the card has since outlived taken off it. The developer's hands are what end a reading: a card that
 * went off the board after the reading was taken has finished the pass the reading belonged to, so the next one starts with no phase (R9).
 *
 * Taken off here rather than at the render, so every board is handed one answer and nothing downstream has the dates to disagree with.
 */
function withStandingReading(card: BoardCard, pastMyHandsAt: Record<string, number>): BoardCard {
  const retained = card.lastSession?.retained;

  if (!retained || retained.at > (pastMyHandsAt[card.key] ?? 0)) {
    return card;
  }

  const { retained: _dropped, ...lastSession } = card.lastSession!;

  return { ...card, lastSession };
}

/**
 * Every card in exactly one lane (R8), every lane present so a caller never has to invent an absent one. Within a
 * lane, returned cards come first and the rest keep the order `mergeBoard` produced.
 */
export function assignLanes(cards: BoardCard[], rules: BoardRules, memory: CardMemory): Lane[] {
  const onBoard = new Set(rules.boardStatuses);
  const seen = new Set(memory.seen);

  const laned = cards.map((card) => {
    const result = place(withStandingReading(card, memory.pastMyHandsAt), rules, onBoard, memory.placements);
    const returned =
      card.issueNumber !== null &&
      memory.pastMyHandsAt[card.key] !== undefined &&
      !seen.has(card.key) &&
      result.lane !== 'archived';

    return { ...result, returned };
  });

  return LANE_ORDER.map((id) => {
    const mine = laned.filter((card) => card.lane === id);

    return {
      id,
      title: LANE_TITLES[id],
      cards: [...mine.filter((card) => card.returned), ...mine.filter((card) => !card.returned)],
    };
  });
}

/**
 * The memory after the developer moves a card. Every lane is recorded, because a card that would arrive in Build has to remember being
 * dragged to Unstarted; and moving it is what clears the returned mark — they have seen it. The departure date stays: it is what a session's
 * retained reading is judged against, and looking at a card is not the card going past the developer's hands again.
 */
export function withPlacement(memory: CardMemory, key: string, lane: LaneId): CardMemory {
  if (!PLACEABLE_LANES.includes(lane)) {
    return memory;
  }

  return {
    ...memory,
    placements: { ...memory.placements, [key]: lane },
    seen: memory.seen.includes(key) ? memory.seen : [...memory.seen, key],
  };
}

/**
 * The statuses that keep a card on the board, from whatever the settings held. A hand-edited value can be any shape,
 * and a bare string would archive every card, so anything unusable falls back to the shipped default.
 */
export function boardStatuses(configured: unknown): string[] {
  const statuses = Array.isArray(configured) ? configured.filter((s) => typeof s === 'string') : [];

  return statuses.length > 0 ? statuses : [...DEFAULT_BOARD_STATUSES];
}

/**
 * The status-to-lane map from whatever the settings held. An empty map is a real choice — infer from pull requests only — so only a value
 * that is not a map of statuses to lanes falls back to the shipped default; a single unusable entry costs that one status its lane.
 */
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

/**
 * The memory to store after a render. A card rendered archived loses its placement — it has gone past the developer's hands, so the lane it
 * held belongs to a pass that ended — and a directory's goes once a successful read shows nothing running there.
 */
export function nextMemory(lanes: Lane[], memory: CardMemory, sessionsRead: boolean, now: number = Date.now()): CardMemory {
  const pastMyHandsAt = { ...memory.pastMyHandsAt };
  const seen = new Set(memory.seen);
  const shown = new Set<string>();
  // Carried forward and edited card by card, never rebuilt from the render: a render before the first source read holds no cards at all, and
  // one that replaced this set with its own would have the next render read every archived card as newly gone and re-date it.
  const archived = new Set(memory.archived);
  const nowArchived = new Set<string>();

  for (const lane of lanes) {
    for (const card of lane.cards) {
      shown.add(card.key);

      if (lane.id !== 'archived' || card.issueNumber === null) {
        archived.delete(card.key);

        continue;
      }

      // Dated on the render that put it there, and again on the render that puts it back after a return. Not on every render in between:
      // a date walking forward would outrun a reading taken while the card was archived, and rewrite this file twice a minute.
      if (!archived.has(card.key)) {
        pastMyHandsAt[card.key] = now;
      }

      // Whether or not the date moved: a card sitting archived has not come back, so there is no return anybody can have seen — including
      // one they placed while it was off the board, which is a lane they chose for a pass that had already ended.
      seen.delete(card.key);
      archived.add(card.key);
      nowArchived.add(card.key);
    }
  }

  const placements: Record<string, LaneId> = {};

  for (const [key, lane] of Object.entries(memory.placements)) {
    // A failed GitHub read re-renders the last good cards, so a card can be re-archived on a stale read — but only one whose placement
    // this rule already dropped. Nothing is lost twice. Narrowing the membership set is the one thing that drops placements wholesale.
    if (nowArchived.has(key)) {
      continue;
    }

    // Only a session read that actually succeeded proves a session is gone. A failed one reports no sessions at all.
    if (sessionsRead && key.startsWith(SESSION_KEY_PREFIX) && !shown.has(key)) {
      continue;
    }

    placements[key] = lane;
  }

  return { ...memory, placements, pastMyHandsAt, archived: [...archived], seen: [...seen] };
}
