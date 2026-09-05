import { dirKey } from './paths.js';
import type { IssueCard } from './cards.js';
import type { HistoricalSession, Session } from './types.js';

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

/**
 * One card. An issue with the sessions attempting it (R3), or a session with no issue of its own (R4).
 * `issue` is null with `issueNumber` set when a session names an issue that is not on the developer's board.
 */
export interface BoardCard {
  key: string;
  issue: IssueCard | null;
  issueNumber: number | null;
  sessions: Session[];
  /** Present only on an issue card with no live sessions. Older snapshots omit it. */
  lastSession?: HistoricalSession;
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
 * When a session last showed itself, by whichever signal spoke most recently. Not liveness: it orders sessions
 * against each other and nothing else.
 */
function activeAt(session: Session): number {
  return Math.max(session.activity?.since ?? 0, session.transcriptWrittenAt ?? 0, session.startedAt);
}

/** `only` is false where the card's sessions are spread over more than one directory, and one of them was picked. */
export interface Checkout {
  cwd: string;
  only: boolean;
}

/**
 * The directory a card's work is being done in, or null where the card has no session to read one from. Never
 * guessed from a branch or an issue number: a session records where it runs, and a second answer for the same
 * question is a second thing to be wrong.
 *
 * Several sessions in one checkout is the ordinary case, so the pick only decides anything where two differ. The
 * most recently active wins rather than the most recently started, because a session just opened in the main clone
 * would otherwise beat the older worktree session doing the work — but that disagrees with the order the card
 * lists its sessions in, so `only` is false there and what used it must say which directory it took.
 * Ties break on agent then session id, as `mergeBoard` breaks its own.
 */
export function checkoutOf(card: Pick<BoardCard, 'sessions' | 'lastSession'>): Checkout | null {
  const [first] = [...card.sessions].sort(
    (a, b) => activeAt(b) - activeAt(a) || a.agent.localeCompare(b.agent) || a.sessionId.localeCompare(b.sessionId),
  );

  // `lastSession` is carried only by a card with no live sessions, so it is the other case rather than a fallback.
  const cwd = first?.cwd ?? card.lastSession?.cwd ?? null;

  return cwd === null ? null : { cwd, only: new Set(card.sessions.map((s) => dirKey(s.cwd))).size < 2 };
}
