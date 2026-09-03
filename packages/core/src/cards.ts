/**
 * What a work item looks like once a source has read it. Named here rather than in the source that produces it,
 * because the snapshot the boards render carries these and `core` may not import a source.
 */
export interface IssueCard {
  number: number;
  title: string;
  type: string | null;
  /** GitHub's own colour name for the type and the status — `RED`, `BLUE`, `GRAY` … — or null when there is none. */
  typeColor: string | null;
  url: string;
  status: string | null;
  statusColor: string | null;
  assignees: string[];
  avatar: CardAvatar | null;
  /** The most recently updated pull request that would close this issue, or null when none is linked. */
  pullRequest: CardPullRequest | null;
  updatedAt: string;
}

export interface CardPullRequest {
  number: number;
  url: string;
  state: string;
  /** Who opened it, or null when GitHub reports no author — a deleted account. What tells the developer's own PR from a colleague's. */
  author: string | null;
  isDraft: boolean;
  /** `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or null when no review has been asked for. */
  reviewDecision: string | null;
}

export interface CardAvatar {
  login: string;
  url: string;
  source: 'pull-request' | 'issue';
}
