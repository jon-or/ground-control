import { z } from 'zod';
import type { BoardCard, Session } from './types.js';

export type LaneId = 'unstarted' | 'plan' | 'build' | 'review' | 'done' | 'icebox' | 'archived';

/** Left to right on the board. `archived` is last and renders only behind the toggle. */
export const LANE_ORDER: readonly LaneId[] = ['unstarted', 'plan', 'build', 'review', 'done', 'icebox', 'archived'];

export const LANE_TITLES: Readonly<Record<LaneId, string>> = {
  unstarted: 'Unstarted',
  plan: 'Plan',
  build: 'Build',
  review: 'Review',
  done: 'Done',
  icebox: 'Icebox',
  archived: 'Archived',
};

/** The lanes a developer may move a card into. `archived` is not one: only a status takes a card off the board. */
export const PLACEABLE_LANES: readonly LaneId[] = LANE_ORDER.filter((id) => id !== 'archived');

/**
 * The statuses whose cards stay on the board. A status is not a stage — ⚒️ Dev spans planning, building and checking
 * alike — so it decides membership only, never which lane. `docs/mechanics.md` §17 lists all 17 and what they mean.
 */
export const DEFAULT_BOARD_STATUSES: readonly string[] = ['🎁 Assigned', '⚒️ Dev'];

/** What the board remembers per card: where the developer put it, and whether it has ever been off the board. */
export interface CardMemory {
  /** Card key to the lane the developer moved it into. A card absent here has never been moved, and starts Unstarted. */
  placements: Record<string, LaneId>;
  /** Card keys seen archived, so a later return can be marked. Issue keys only — session keys are not stable. */
  seenPastMyHands: string[];
}

export const EMPTY_MEMORY: CardMemory = { placements: {}, seenPastMyHands: [] };

/** A caller may keep what it is handed, so an unusable stored value yields its own empty memory, not a shared one. */
function emptyMemory(): CardMemory {
  return { placements: {}, seenPastMyHands: [] };
}

/** `mergeBoard` keys a card with no issue by its session. R4 cards therefore have keys that die with the session. */
const SESSION_KEY_PREFIX = 'session:';

const laneId = z.enum(LANE_ORDER as [LaneId, ...LaneId[]]);

const cardMemory = z.object({
  placements: z.record(z.string(), z.string()),
  seenPastMyHands: z.array(z.string()),
});

/**
 * The stored memory, or an empty one. This is durable state a developer can hand-edit and an older build can have
 * written in another shape, and an unparsed read of it throws on every render with no way back but clearing it.
 */
export function readMemory(stored: unknown): CardMemory {
  const parsed = cardMemory.safeParse(stored);

  if (!parsed.success) {
    return emptyMemory();
  }

  const placements: Record<string, LaneId> = {};

  // One unreadable entry drops that card back to its entry lane; it does not cost the developer every other placement.
  for (const [key, lane] of Object.entries(parsed.data.placements)) {
    if (laneId.safeParse(lane).success) {
      placements[key] = lane as LaneId;
    }
  }

  return { placements, seenPastMyHands: parsed.data.seenPastMyHands };
}

export interface LanedCard extends BoardCard {
  lane: LaneId;
  returned: boolean;
  /** What the card's status says about it being on the board — R25. Never why it is in its lane; that was the developer. */
  reason: string;
}

export interface Lane {
  id: LaneId;
  title: string;
  cards: LanedCard[];
}

/**
 * A session the agent itself reported as finished. `status: "idle"` is not that — an interactive session is idle whenever nobody is typing — and
 * exited sessions are never listed, so a listed session with no state is a running one. R24 forbids a finish the board did not observe.
 */
export function isTerminal(session: Session): boolean {
  return session.state === 'done' || session.state === 'stopped';
}

/** Where a card first appears. Work with no issue is on the board only while its agent runs, so it starts in Build. */
function entryLane(card: BoardCard): LaneId {
  return card.issue === null ? 'build' : 'unstarted';
}

/** Where the developer last put this card, ignoring a stored lane that is not one they can choose. */
function placed(card: BoardCard, placements: Record<string, LaneId>): LaneId {
  const lane = placements[card.key];

  return lane !== undefined && PLACEABLE_LANES.includes(lane) ? lane : entryLane(card);
}

function place(card: BoardCard, boardStatuses: ReadonlySet<string>, placements: Record<string, LaneId>): LanedCard {
  const lane = placed(card, placements);
  const base = { ...card, lane, returned: false };

  if (card.issue === null) {
    return { ...base, reason: card.issueNumber === null ? 'Ad-hoc work with no issue.' : 'Not among your assigned issues.' };
  }

  const status = card.issue.status;

  // An assigned issue that is not on the project board has no status to judge, and R1 still puts it on the board.
  if (status === null || boardStatuses.has(status)) {
    return { ...base, reason: status ?? 'Not on the project board.' };
  }

  // R2 outranks R9: a status that would archive the card cannot hide a session still running on it.
  return card.sessions.some((session) => !isTerminal(session))
    ? { ...base, reason: `${status} — past your hands, but an agent is still running.` }
    : { ...base, lane: 'archived', reason: `${status} — not yours to act on right now.` };
}

/**
 * Every card in exactly one lane (R8), every lane present so a caller never has to invent an absent one. Within a
 * lane, returned cards come first and the rest keep the order `mergeBoard` produced.
 */
export function assignLanes(cards: BoardCard[], boardStatuses: readonly string[], memory: CardMemory): Lane[] {
  const onBoard = new Set(boardStatuses);
  const seen = new Set(memory.seenPastMyHands);

  const laned = cards.map((card) => {
    const result = place(card, onBoard, memory.placements);

    return { ...result, returned: card.issueNumber !== null && seen.has(card.key) && result.lane !== 'archived' };
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
 * The memory after the developer moves a card. Every lane is recorded, because a card whose entry lane is Build has
 * to remember being dragged to Unstarted; and moving it is what clears the returned mark — they have seen it.
 */
export function withPlacement(memory: CardMemory, key: string, lane: LaneId): CardMemory {
  if (!PLACEABLE_LANES.includes(lane)) {
    return memory;
  }

  return {
    placements: { ...memory.placements, [key]: lane },
    seenPastMyHands: memory.seenPastMyHands.filter((seen) => seen !== key),
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
 * The memory to store after a render. An issue's placement survives the issue leaving the board; a session's is dropped
 * once a successful read shows the session gone, because its key names one process and can never match again.
 */
export function nextMemory(lanes: Lane[], memory: CardMemory, sessionsRead: boolean): CardMemory {
  const seen = new Set(memory.seenPastMyHands);
  const shown = new Set<string>();

  for (const lane of lanes) {
    for (const card of lane.cards) {
      shown.add(card.key);

      if (lane.id === 'archived' && card.issueNumber !== null) {
        seen.add(card.key);
      }
    }
  }

  // Only a session read that actually succeeded proves a session is gone. A failed one reports no sessions at all.
  if (!sessionsRead) {
    return { ...memory, seenPastMyHands: [...seen] };
  }

  const placements: Record<string, LaneId> = {};

  for (const [key, lane] of Object.entries(memory.placements)) {
    if (shown.has(key) || !key.startsWith(SESSION_KEY_PREFIX)) {
      placements[key] = lane;
    }
  }

  return { placements, seenPastMyHands: [...seen] };
}
