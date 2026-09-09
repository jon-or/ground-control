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

/** The classifier's whole answer. Two fields, because a third is a field nobody reads and a chance to be wrong. */
export interface TriageResult {
  action: TriageAction;
  detail: string;
}

/**
 * One card's triage, as it is stored. `wasArchived` is what makes a card that left and came back due again without
 * the entry ever being deleted while it sits archived — deleting it there would make absence the trigger for a card
 * that renders archived on every pass, which is a loop. `evidence` is what the card looked like when this was
 * decided, so a label that has since gone stale can say so rather than reading as current (R24).
 */
export interface TriageEntry {
  action: TriageAction;
  /** The `TRIAGE_REVISION` this was read under. An entry from an older one is dropped, which re-reads the card. */
  revision: number;
  qualifier: TriageQualifier | null;
  detail: string;
  /** Epoch milliseconds this was decided. */
  at: number;
  /** Which agent adapter answered, so a board with two says whose reading it is showing. */
  agent: string;
  wasArchived: boolean;
  evidence: string;
  /** What the card looked like on the one axis worth spending a model call over: when its status last moved. */
  trigger: string;
}

/**
 * A triage that did not produce an answer. Durable and counted, because every failure mode here — a logged-out CLI, a
 * rate limit, a timeout — fails again immediately, and a card with no entry is otherwise due on the very next pass.
 */
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

/**
 * Somebody the board names on a card, where nothing matches on them and they are only ever printed. The identifier
 * is carried all the same, because that is what a name override is keyed on.
 */
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
  /**
   * The branch this would merge into. What decides whether keeping the head current is one merge or a chain: a
   * branch based on another feature branch needs its parent current first, and the board cannot verify that order
   * (R39). Empty only on a recording made before it was selected.
   */
  baseRefName: string;
  /** The branch the work is on, which is what a dispatched merge is told to merge into. */
  headRefName: string;
  /** The head commit, and a run's whole evidence: one run per push, and never a second against the same commit. */
  headOid: string;
  /** `SUCCESS`, `FAILURE`, `ERROR`, `PENDING`, or null where the repository runs no checks at all. */
  checkState: string | null;
  comments: TriageComment[];
  reviews: TriageReview[];
  /** Who has been asked to review, which is the only thing that says a colleague's pull request wants the developer. */
  reviewRequests: TriageActor[];
  threads: TriageThread[];
}

/**
 * One thing somebody did to a card's state: a status move, an assignment, or an unassignment. Carried as read,
 * because what a run of these means is the board's judgement and a work source's job is to report what happened.
 * A status move out of nothing is the card being added to the board rather than anybody moving it.
 */
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
  /** Status moves and assignments, oldest first, on the project the board reads. What says when the card became this. */
  stateEvents: TriageStateEvent[];
  comments: TriageComment[];
  pullRequest: TriagePullRequest | null;
  /** The developer's own logins, so the prompt can say which words are theirs. */
  logins: string[];
  /** `owner/name`, as the card's own URL carries it. What a dispatched run is told it is working in. */
  repository: string;
  /**
   * The branch the repository merges into by default. Read rather than assumed: a pull request based on anything
   * else is a chain the board refuses to automate (R39), and "master" is a convention, not a fact.
   */
  defaultBranch: string | null;
}
