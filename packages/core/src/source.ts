import type { IssueCard } from './cards.js';
import type { DetailReading, DetailSubject } from './detail.js';
import type { TriageContext } from './triage.js';
import type { ReadFailure } from './types.js';

/** Source read metadata, including counts for incomplete-result notices (R1). */
export interface WorkItems {
  cards: IssueCard[];
  /** Logins used for this read and for identifying own PRs. */
  owners: string[];
  matched: number;
  totalAssigned: number;
  notOnProject: number;
  truncated: boolean;
  fetchedAt: string;
  /** Why the configured status field cannot supply status, or null. Shown by both clients. */
  fieldProblem: string | null;
}

/**
 * Source result. Null items with a failure retain cached items (R24). Detected identities in needs require
 * developer selection by a client (R26, R28).
 */
export interface SourceReading {
  items: WorkItems | null;
  failure: ReadFailure | null;
  needs: { detected: string[] } | null;
}

/** Whose face a review-status card shows. Off-review lanes have no pull request to name, so they use their own list. */
export const REVIEW_AVATARS = ['pull-request-author', 'assignee'] as const;
export type ReviewAvatar = (typeof REVIEW_AVATARS)[number];

/** Whose face a card shows outside the review statuses: unstarted, plan, build, done, and icebox. */
export const OFF_REVIEW_AVATARS = ['issue-author', 'assignee'] as const;
export type OffReviewAvatar = (typeof OFF_REVIEW_AVATARS)[number];

/** Whose face a card shows, chosen separately for review statuses and every other status (R5). */
export interface AvatarPolicy {
  review: ReviewAvatar;
  offReview: OffReviewAvatar;
}

export const DEFAULT_AVATAR_POLICY: AvatarPolicy = { review: 'pull-request-author', offReview: 'assignee' };

/** Board policy a source needs to shape its cards; the hub derives it from board settings, not from source settings. */
export interface BoardPolicy {
  /** Statuses the board maps to the review lane. */
  reviewStatuses: readonly string[];
  avatar: AvatarPolicy;
}

/** Mirrors the review entry of the board package's DEFAULT_STATUS_LANES, which core cannot import. */
export const DEFAULT_BOARD_POLICY: BoardPolicy = { reviewStatuses: ['🔍 Dev Review'], avatar: { ...DEFAULT_AVATAR_POLICY } };

/** Work-source adapter selected by configuration and registry ID. */
export interface WorkSource {
  readonly id: string;
  readonly displayName: string;
  /** Validate and store source configuration, or return a failure. Without a board policy, sources use DEFAULT_BOARD_POLICY. */
  configure(raw: unknown, board?: BoardPolicy): ReadFailure | null;
  read(): Promise<SourceReading>;
  /** Optional conversation context for triage; omit if unavailable (R30). */
  readContext?(card: IssueCard, signal: AbortSignal): Promise<ContextReading>;
  /**
   * Optional issue lookup by repositoryKey and number. Return null for an unsupported repository, distinct from a
   * missing issue. Without lookup, preserve the unlinked session (R4).
   */
  readCard?(repository: string, number: number, signal: AbortSignal): Promise<CardReading | null>;
  /**
   * Optional read-only conversation for one card, requested when a client opens it. Return null for a card this
   * source does not serve, distinct from a subject it serves and cannot find.
   */
  readDetail?(card: IssueCard, subject: DetailSubject, signal: AbortSignal): Promise<DetailReading | null>;
}

/** One item read by number. `card` null beside no failure is a number the source served and found nothing for. */
export interface CardReading {
  card: IssueCard | null;
  failure: ReadFailure | null;
}

/** Complete triage context or failure; never classify partial context. */
export interface ContextReading {
  context: TriageContext | null;
  failure: ReadFailure | null;
}
