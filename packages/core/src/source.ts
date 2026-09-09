import type { IssueCard } from './cards.js';
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

/** Whose face a card shows: the selected pull request's author while the status is a review status, or always the assignee. */
export const AVATAR_POLICIES = ['review-author', 'assignee'] as const;
export type AvatarPolicy = (typeof AVATAR_POLICIES)[number];

/** Board policy a source needs to shape its cards; the hub derives it from board settings, not from source settings. */
export interface BoardPolicy {
  /** Statuses the board maps to the review lane. */
  reviewStatuses: readonly string[];
  avatar: AvatarPolicy;
}

/** Mirrors the review entry of the board package's DEFAULT_STATUS_LANES, which core cannot import. */
export const DEFAULT_BOARD_POLICY: BoardPolicy = { reviewStatuses: ['🔍 Dev Review'], avatar: 'review-author' };

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
