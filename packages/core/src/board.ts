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
