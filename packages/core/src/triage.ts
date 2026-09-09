/**
 * Supported next-action labels (R38). Status mappings and PR check state can determine an action before
 * classification; conversation interpretation handles the remaining cases.
 */
export const TRIAGE_ACTIONS = [
  'develop',
  'dev-question',
  'qa-question',
  'qa-failure',
  'review-others',
  'address-review',
  'fix-checks',
  'merge-upstream',
  'other',
] as const;

export type TriageAction = (typeof TRIAGE_ACTIONS)[number];

/** Whether a review round is the first or a later one. Read from the pull request's own history, never from the model. */
export type TriageQualifier = 'initial' | 'followup';

/** Classifier action and explanation. */
export interface TriageResult {
  action: TriageAction;
  detail: string;
}

/**
 * Persisted triage with evidence for freshness. Keep archived entries marked so returning cards become due once
 * without repeated classification while archived.
 */
export interface TriageEntry {
  action: TriageAction;
  /** The `TRIAGE_REVISION` this was read under. An entry from an older one is dropped, which re-reads the card. */
  revision: number;
  qualifier: TriageQualifier | null;
  detail: string;
  /** Epoch milliseconds this was decided. */
  at: number;
  /** Agent adapter that produced this result. */
  agent: string;
  wasArchived: boolean;
  evidence: string;
  /** Status-change trigger recorded when classified. */
  trigger: string;
}

/** Persisted classification failure and retry count, preventing immediate retries on every update. */
export interface TriageFailure {
  kind: string;
  message: string;
  attempts: number;
  /** Epoch milliseconds before which this card is not tried again. */
  nextAt: number;
}

/** What the hub remembers about triage across restarts. Keyed by card key, the same key lane placement uses. */
export interface TriageState {
  entries: Record<string, TriageEntry>;
  failures: Record<string, TriageFailure>;
}

export const EMPTY_TRIAGE: TriageState = { entries: {}, failures: {} };

/**
 * Expose running, completed, and failed triage states. Failed cards retain a retry control; the explanation is
 * deduplicated above the board rather than repeated on every card (R25).
 */
export type CardTriage =
  | { state: 'running' }
  | { state: 'done'; action: TriageAction; qualifier: TriageQualifier | null; detail: string; at: number; stale: boolean }
  | { state: 'failed'; attempts: number; exhausted: boolean };

/** One comment on an issue or a pull request, clipped. `authorAssociation` is how a tester is told from a colleague. */
export interface TriageComment {
  author: string | null;
  /** Their profile name, where GitHub has one. Display only — every rule here matches on the login. */
  authorName: string | null;
  authorAssociation: string | null;
  body: string;
  createdAt: string;
}

/** Display identity; retain its ID for name overrides. */
export interface TriageActor {
  /** Their login, or a team's slug. */
  login: string;
  name: string | null;
}

/** One review somebody submitted. What decides whether a review round is the developer's first or a later one. */
export interface TriageReview {
  author: string | null;
  authorName: string | null;
  state: string;
  submittedAt: string | null;
}

export interface TriageThread {
  isResolved: boolean;
  isOutdated: boolean;
  comments: TriageComment[];
}

/**
 * Use the PR selected for the card. Exclude mergeability because merge requests come from instructions, and
 * exclude reviewDecision because it can lag status-based handovers. Reviews and status determine review
 * rounds; action completion is session-reported (R39).
 */
export interface TriagePullRequest {
  number: number;
  title: string;
  body: string;
  state: string;
  isDraft: boolean;
  author: string | null;
  authorName: string | null;
  /** PR base branch. Refuse unattended merges for stacked branches (R39). Empty in older recordings. */
  baseRefName: string;
  /** Head branch receiving the merge. */
  headRefName: string;
  /** PR head commit used in dispatch evidence. */
  headOid: string;
  /** `SUCCESS`, `FAILURE`, `ERROR`, `PENDING`, or null where the repository runs no checks at all. */
  checkState: string | null;
  comments: TriageComment[];
  reviews: TriageReview[];
  /** Requested reviewers used to identify developer review responsibility. */
  reviewRequests: TriageActor[];
  threads: TriageThread[];
}

/** Recorded status or assignment event, interpreted by the board. An empty previous status denotes project addition. */
export interface TriageStateEvent {
  at: string;
  actor: string | null;
  actorName: string | null;
  /** Where the status went, or null on an assignment. `from` is empty only when the card was added to the board. */
  status: { from: string; to: string } | null;
  assigned: string | null;
  unassigned: string | null;
}

/** Everything one card's triage reads. Assembled by a work source; the prompt is a pure function of it. */
export interface TriageContext {
  issueNumber: number;
  title: string;
  body: string;
  status: string | null;
  /** Project status and assignment events, oldest first. */
  stateEvents: TriageStateEvent[];
  comments: TriageComment[];
  pullRequest: TriagePullRequest | null;
  /** The developer's own logins, so the prompt can say which words are theirs. */
  logins: string[];
  /** `owner/name`, as the card's own URL carries it. What a dispatched run is told it is working in. */
  repository: string;
  /**
   * Observed repository default branch. Other PR bases are treated as stacked branches and refused for automation
   * (R39).
   */
  defaultBranch: string | null;
}
