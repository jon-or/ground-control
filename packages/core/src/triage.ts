/**
 * What a card is asking the developer to do next, decided once when the card arrives (`prd.md` R38). Six of these are
 * a judgement about what people wrote; the other six are facts about a pull request, and the hub decides those itself
 * rather than leaving them to a classifier (R23 — evidence over an agent's word).
 */
export const TRIAGE_ACTIONS = [
  'begin-work',
  'answer-design-question',
  'uat-question',
  'uat-failure',
  'awaiting-others',
  'review-others',
  'address-review',
  'fix-checks',
  'merge-upstream',
  'resolve-conflicts',
  'land',
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
  qualifier: TriageQualifier | null;
  detail: string;
  /** Epoch milliseconds this was decided. */
  at: number;
  /** Which agent adapter answered, so a board with two says whose reading it is showing. */
  agent: string;
  wasArchived: boolean;
  evidence: string;
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
 * What a client draws. `running` and `stale` are separate states rather than flags because they read differently on a
 * card: one is work in flight, the other is an answer that was true when it was given. A failure draws nothing here —
 * it is one deduplicated line above the lanes, since fifteen cards failing one cause is one condition (R25).
 */
export type CardTriage =
  | { state: 'running' }
  | { state: 'done'; action: TriageAction; qualifier: TriageQualifier | null; detail: string; at: number; stale: boolean };

/** One comment on an issue or a pull request, clipped. `authorAssociation` is how a tester is told from a colleague. */
export interface TriageComment {
  author: string | null;
  authorAssociation: string | null;
  body: string;
  createdAt: string;
}

/** One review somebody submitted. What decides whether a review round is the developer's first or a later one. */
export interface TriageReview {
  author: string | null;
  state: string;
  submittedAt: string | null;
}

export interface TriageThread {
  isResolved: boolean;
  isOutdated: boolean;
  comments: TriageComment[];
}

/**
 * The pull request the card is showing — the same one `selectPullRequest` chose, never a second answer to the same
 * question. `mergeable` and `mergeStateStatus` are `UNKNOWN` until GitHub has computed them, which is often the case
 * the moment a card arrives (`docs/mechanics.md` §31), so they are carried as read and judged nowhere but one place.
 */
export interface TriagePullRequest {
  number: number;
  title: string;
  body: string;
  state: string;
  isDraft: boolean;
  author: string | null;
  reviewDecision: string | null;
  mergeable: string | null;
  mergeStateStatus: string | null;
  /** `SUCCESS`, `FAILURE`, `ERROR`, `PENDING`, or null where the repository runs no checks at all. */
  checkState: string | null;
  comments: TriageComment[];
  reviews: TriageReview[];
  /** Who has been asked to review, which is the only thing that says a colleague's pull request wants the developer. */
  reviewRequests: string[];
  threads: TriageThread[];
}

/** Everything one card's triage reads. Assembled by a work source; the prompt is a pure function of it. */
export interface TriageContext {
  issueNumber: number;
  title: string;
  body: string;
  status: string | null;
  comments: TriageComment[];
  pullRequest: TriagePullRequest | null;
  /** The developer's own logins, so the prompt can say which words are theirs. */
  logins: string[];
}
