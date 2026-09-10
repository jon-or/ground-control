/** Which conversation a detail request is for. A card's pull request is the one its snapshot already selected. */
export type DetailSubject = 'issue' | 'pull-request';

/** One reaction content name, such as `THUMBS_UP`, with how many people left it. Zero-count groups are dropped. */
export interface DetailReaction {
  content: string;
  count: number;
}

/**
 * Something a person wrote: a conversation comment, a review summary, or a reply on a review thread. `bodyHtml` is
 * the source's own render, sanitized again by the client before it reaches a document.
 */
export interface DetailPost {
  kind: 'comment' | 'review';
  author: string | null;
  avatarUrl: string | null;
  bodyHtml: string;
  createdAt: string;
  editedAt: string | null;
  reactions: DetailReaction[];
  /** Why the source hid this comment, or null. Hidden comments are shown collapsed, never dropped. */
  hidden: string | null;
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, or `DISMISSED` for a review; null for a comment. */
  state: string | null;
  /** Inline threads this review opened. Empty for a comment. */
  threads: DetailThread[];
}

/**
 * Something that happened rather than something someone wrote: a commit, a label, an assignment, a status move.
 * The source composes `summary` because the wording is a product decision, not a client one.
 */
export interface DetailNote {
  kind: 'commit' | 'note';
  actor: string | null;
  avatarUrl: string | null;
  createdAt: string;
  /** One line, without the actor: `added the bug label`, `a1b2c3d Fix the totals`. */
  summary: string;
  /** What the note points at, or null. */
  url: string | null;
}

/** The conversation in the order it happened. */
export type DetailEvent = DetailPost | DetailNote;

/** One inline review conversation on a pull request's diff. Issues have none. */
export interface DetailThread {
  /** File the thread is attached to, as the source reports it. */
  path: string;
  /** Line in the current diff, or the line the thread was written against when the diff moved past it. */
  line: number | null;
  resolved: boolean;
  /** The diff the thread was written against is no longer part of the pull request. */
  outdated: boolean;
  comments: DetailPost[];
  /** The read stopped before the thread's first reply. Only a thread past one page can set this. */
  moreComments: boolean;
}

/**
 * Read-only conversation for one issue or pull request, rendered by the source rather than by a client markdown
 * parser. Requested per card and never carried in snapshots, which would broadcast every body on every poll.
 */
export interface ItemDetail {
  subject: DetailSubject;
  number: number;
  /** `owner/name`, as GitHub reports it. */
  repository: string;
  title: string;
  url: string;
  /** `OPEN`, `CLOSED`, or `MERGED`, as the source reports it. */
  state: string;
  bodyHtml: string;
  author: string | null;
  authorAvatarUrl: string | null;
  createdAt: string;
  editedAt: string | null;
  reactions: DetailReaction[];
  labels: DetailLabel[];
  assignees: string[];
  milestone: string | null;
  /** Pull requests only: the branches this change moves between. */
  branches: { base: string; head: string } | null;
  draft: boolean;
  /** `APPROVED`, `CHANGES_REQUESTED`, or `REVIEW_REQUIRED` for a pull request; null otherwise. */
  reviewDecision: string | null;
  /** Combined check state for the head commit, such as `SUCCESS` or `FAILURE`; null when no checks ran. */
  checks: string | null;
  /** Everything that happened, oldest first. */
  events: DetailEvent[];
  /**
   * The read stopped before the conversation's start. Reads run backwards from the newest, so a clipped
   * conversation is missing its oldest entries; there is no count, because the source's total overcounts.
   */
  moreEvents: boolean;
  /** The read stopped at its thread page limit with more to fetch. */
  moreThreads: boolean;
  /** Threads whose opening review is not in the timeline, so they belong to no event above. */
  threads: DetailThread[];
}

export interface DetailLabel {
  name: string;
  /** Six hex digits with no leading `#`, as GitHub reports it. */
  color: string;
}

/** Null detail beside no failure is a subject the source served and found nothing for. */
export interface DetailReading {
  detail: ItemDetail | null;
  failure: { message: string; remedy: string } | null;
}

/**
 * The address of a link a reader followed inside a conversation, or null. Conversation HTML is written by anyone
 * who can comment, so a host opens only `http` and `https`, never a scheme that runs or reads something local.
 */
export function readableLink(url: unknown): string | null {
  if (typeof url !== 'string') {
    return null;
  }

  try {
    return ['http:', 'https:'].includes(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
}
