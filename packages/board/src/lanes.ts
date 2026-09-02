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
 * The statuses whose cards stay on the board. Most decide membership only; the ones that also name a stage are in
 * `DEFAULT_STATUS_LANES`. `docs/mechanics.md` §17 lists all 17 and what they mean.
 */
export const DEFAULT_BOARD_STATUSES: readonly string[] = ['🎁 Assigned', '⚒️ Dev', '🔍 Dev Review'];

/**
 * The statuses that carry a lane, for a card the developer has never placed. Most say nothing about stage — ⚒️ Dev spans planning,
 * building and checking alike — so only the ones that do appear here, and a status the map does not name leaves the card to its other signals.
 */
export const DEFAULT_STATUS_LANES: Readonly<Record<string, LaneId>> = { '🔍 Dev Review': 'review' };

/** What the board judges a card against: which statuses keep it, which carry a lane, and whose pull requests are the developer's own. */
export interface BoardRules {
  boardStatuses: readonly string[];
  statusLanes: Readonly<Record<string, LaneId>>;
  logins: readonly string[];
}

/** What the board remembers per card: where the developer put it, and whether it has ever been off the board. */
export interface CardMemory {
  /** Card key to the lane the developer moved it into. A card absent here has never been moved, and arrives on its own evidence. */
  placements: Record<string, LaneId>;
  /** Card keys seen archived, so a later return can be marked. Issue keys only — work with no issue never left. */
  seenPastMyHands: string[];
  /** The membership set this memory was written against. A changed one carries cards across the archive line for reasons no card caused. */
  statuses: string[];
}

export const EMPTY_MEMORY: CardMemory = { placements: {}, seenPastMyHands: [], statuses: [] };

/** A caller may keep what it is handed, so an unusable stored value yields its own empty memory, not a shared one. */
function emptyMemory(statuses: readonly string[]): CardMemory {
  return { placements: {}, seenPastMyHands: [], statuses: [...statuses] };
}

/** `mergeBoard` keys a card with no issue by the directory its sessions run in. R4 cards exist only while one does. */
const SESSION_KEY_PREFIX = 'session:';

const laneId = z.enum(LANE_ORDER as [LaneId, ...LaneId[]]);

const cardMemory = z.object({
  placements: z.record(z.string(), z.string()),
  seenPastMyHands: z.array(z.string()),
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
export function readMemory(stored: unknown, statuses: readonly string[]): CardMemory {
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

  // A changed membership set carries cards across the archive line wholesale, which is not any of them coming back. The placements those
  // cards held go with the marks: each belongs to a pass past the developer's hands that the old set had already ended.
  if (!sameStatuses(parsed.data.statuses, statuses)) {
    for (const key of parsed.data.seenPastMyHands) {
      delete placements[key];
    }

    return { placements, seenPastMyHands: [], statuses: [...statuses] };
  }

  return { placements, seenPastMyHands: parsed.data.seenPastMyHands, statuses: [...statuses] };
}

export type Attention = 'blocked' | 'your-turn';

export interface LanedCard extends BoardCard {
  lane: LaneId;
  returned: boolean;
  /** What the card asks of the developer, or null when it asks nothing. */
  attention: Attention | null;
  /** What the card's status says about it being on the board. Never why it is in its lane. */
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

/** Lanes where the developer has already said the card is not theirs to push on, so an agent finishing there asks nothing of them. */
const SETTLED_LANES: readonly LaneId[] = ['done', 'icebox', 'archived'];

/**
 * What the card asks of the developer. `blocked` is an agent that cannot go on without them; `your-turn` is one that ended its turn and handed
 * control back — finished is not the same as done (R23). Null is a card working, or one whose sessions reported nothing at all (R24).
 */
export function attentionOf(sessions: readonly Session[], lane: LaneId): Attention | null {
  // A finished agent cannot be blocked on anybody. Its last event can still be a prompt it never got past, and reading that as blocked
  // would leave a dead session saying "needs you" for as long as the CLI keeps listing it.
  if (sessions.some((session) => session.activity?.phase === 'waiting' && !isTerminal(session))) {
    return 'blocked';
  }

  if (SETTLED_LANES.includes(lane)) {
    return null;
  }

  return sessions.some((session) => session.activity?.phase === 'idle') ? 'your-turn' : null;
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

  const pr = card.issue.pullRequest;

  // The developer's own open pull request outranks the status: a review asking for changes is code to change (R7), whatever the tracker says.
  if (pr !== null && pr.state === 'OPEN' && authoredByDeveloper(pr.author, rules.logins)) {
    return pr.reviewDecision === 'CHANGES_REQUESTED' || pr.isDraft ? 'build' : 'review';
  }

  const status = card.issue.status;

  // `hasOwn`, because a status named after something on Object's prototype would otherwise resolve to a function, and a lane no lane
  // list holds takes the card off every lane at once — R8 broken far worse than a wrong lane.
  return status !== null && Object.hasOwn(rules.statusLanes, status) ? rules.statusLanes[status]! : 'unstarted';
}

/** Where the developer last put this card, ignoring a stored lane that is not one they can choose. */
function placed(card: BoardCard, rules: BoardRules, placements: Record<string, LaneId>): LaneId {
  const lane = placements[card.key];

  return lane !== undefined && PLACEABLE_LANES.includes(lane) ? lane : inferredLane(card, rules);
}

function place(card: BoardCard, rules: BoardRules, onBoard: ReadonlySet<string>, placements: Record<string, LaneId>): LanedCard {
  const lane = placed(card, rules, placements);
  const base = { ...card, lane, returned: false, attention: attentionOf(card.sessions, lane) };

  if (card.issue === null) {
    return { ...base, reason: card.issueNumber === null ? 'Ad-hoc work with no issue.' : 'Not among your assigned issues.' };
  }

  const status = card.issue.status;

  // An assigned issue that is not on the project board has no status to judge, and R1 still puts it on the board.
  if (status === null || onBoard.has(status)) {
    return { ...base, reason: status ?? 'Not on the project board.' };
  }

  // R2 outranks R9: a status that would archive the card cannot hide a session still running on it.
  return card.sessions.some((session) => !isTerminal(session))
    ? { ...base, reason: `${status} — past your hands, but an agent is still running.` }
    : {
        ...base,
        lane: 'archived',
        attention: attentionOf(card.sessions, 'archived'),
        reason: `${status} — not yours to act on right now.`,
      };
}

/**
 * Every card in exactly one lane (R8), every lane present so a caller never has to invent an absent one. Within a
 * lane, returned cards come first and the rest keep the order `mergeBoard` produced.
 */
export function assignLanes(cards: BoardCard[], rules: BoardRules, memory: CardMemory): Lane[] {
  const onBoard = new Set(rules.boardStatuses);
  const seen = new Set(memory.seenPastMyHands);

  const laned = cards.map((card) => {
    const result = place(card, rules, onBoard, memory.placements);

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
 * The memory after the developer moves a card. Every lane is recorded, because a card that would arrive in Build has to
 * remember being dragged to Unstarted; and moving it is what clears the returned mark — they have seen it.
 */
export function withPlacement(memory: CardMemory, key: string, lane: LaneId): CardMemory {
  if (!PLACEABLE_LANES.includes(lane)) {
    return memory;
  }

  return {
    ...memory,
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
export function nextMemory(lanes: Lane[], memory: CardMemory, sessionsRead: boolean): CardMemory {
  const seen = new Set(memory.seenPastMyHands);
  const shown = new Set<string>();
  const archived = new Set<string>();

  for (const lane of lanes) {
    for (const card of lane.cards) {
      shown.add(card.key);

      if (lane.id === 'archived' && card.issueNumber !== null) {
        seen.add(card.key);
        archived.add(card.key);
      }
    }
  }

  const placements: Record<string, LaneId> = {};

  for (const [key, lane] of Object.entries(memory.placements)) {
    // A failed GitHub read re-renders the last good cards, so a card can be re-archived on a stale read — but only one whose placement
    // this rule already dropped. Nothing is lost twice. Narrowing the membership set is the one thing that drops placements wholesale.
    if (archived.has(key)) {
      continue;
    }

    // Only a session read that actually succeeded proves a session is gone. A failed one reports no sessions at all.
    if (sessionsRead && key.startsWith(SESSION_KEY_PREFIX) && !shown.has(key)) {
      continue;
    }

    placements[key] = lane;
  }

  return { ...memory, placements, seenPastMyHands: [...seen] };
}
