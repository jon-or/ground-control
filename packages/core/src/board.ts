import type { CardAction } from './actions.js';
import type { CardCheckout } from './checkout.js';
import type { IssueCard } from './cards.js';
import type { CardTriage } from './triage.js';
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
 * One card. An issue with the sessions attempting it (R3), or a session with no issue of its own (R4). `issue` and
 * `issueNumber` are null together: a session naming an issue nothing could read is work with no issue.
 */
export interface BoardCard {
  key: string;
  issue: IssueCard | null;
  issueNumber: number | null;
  sessions: Session[];
  /** Present only on an issue card with no live sessions. Older snapshots omit it. */
  lastSession?: HistoricalSession;
  /** Set on a card the developer is not assigned, which a session named and the board looked up. Absent means assigned. */
  unassigned?: true;
}

/**
 * The one state a card's edge carries. `blocked` and `your-turn` are R6's two marks, in that order; `running` is a
 * session still working, which asks nothing and is drawn as the quiet third rather than as a mark of its own.
 */
export type Attention = 'blocked' | 'your-turn' | 'running';

export interface LanedCard extends BoardCard {
  lane: LaneId;
  returned: boolean;
  /** What the card asks of the developer, or that a session on it is working. Null when there is nothing to say. */
  attention: Attention | null;
  /** What the card's status says about it being on the board. Never why it is in its lane. */
  reason: string;
  /** What the board has worked out this card is asking for, where it has read one. Absent on a card never triaged. */
  triage?: CardTriage;
  /** What the board can do about that reading, or has done. Absent where the card's action is not one it performs. */
  action?: CardAction;
  /** Where this card's work happens, where the board has somewhere to point an editor at. Absent where it has not. */
  checkout?: CardCheckout;
}

export interface Lane {
  id: LaneId;
  title: string;
  cards: LanedCard[];
}
