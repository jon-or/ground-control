import type { Session } from '@ground-control/core';
import type { IssueCard } from '@ground-control/github';

/**
 * One card. An issue with the sessions attempting it (R3), or a session with no issue of its own (R4).
 * `issue` is null with `issueNumber` set when a session names an issue that is not on the developer's board.
 */
export interface BoardCard {
  key: string;
  issue: IssueCard | null;
  issueNumber: number | null;
  sessions: Session[];
}

export type { IssueCard, Session };
