/** Source-neutral work item carried in board snapshots. */
export interface IssueCard {
  number: number;
  title: string;
  /** `owner/name`, as GitHub reports it. Shortened where it is drawn; a snapshot cached by an older hub omits it. */
  repository?: string;
  type: string | null;
  /** GitHub type and status color names, such as RED or BLUE, or null. */
  typeColor: string | null;
  url: string;
  /** `OPEN` or `CLOSED`, as GitHub reports it. Omitted by a snapshot an older hub cached. */
  state?: string;
  status: string | null;
  statusColor: string | null;
  /** Last status-change time, or null off the project board; triggers triage (R38). */
  statusChangedAt: string | null;
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
  /** PR author login, or null for an unavailable account; used to identify own PRs. */
  author: string | null;
  isDraft: boolean;
  /** `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or null when no review has been asked for. */
  reviewDecision: string | null;
  /** PR update timestamp, independent of issue updates. */
  updatedAt: string | null;
  /** PR head commit; null in older cached snapshots. */
  headOid: string | null;
  /**
   * Whether the head commit's checks have failed. Null where the repository runs none, which is not the same as
   * passing.
   */
  checksRed: boolean | null;
}

export interface CardAvatar {
  login: string;
  url: string;
  /** Whose avatar this is: the selected PR's author, the issue's author, or an assignee (R5). */
  source: 'pull-request' | 'issue-author' | 'issue';
  /** The login GitHub recorded, when a linked account stands in for it (R28). */
  aliasOf?: string;
}
