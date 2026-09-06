import { z } from 'zod';
import { TRIAGE_ACTIONS } from '@ground-control/core';
import type {
  CardTriage,
  IssueCard,
  Lane,
  LanedCard,
  TriageAction,
  TriageContext,
  TriageEntry,
  TriageFailure,
  TriageQualifier,
  TriageResult,
  TriagePullRequest,
  TriageState,
} from '@ground-control/core';

export { TRIAGE_ACTIONS };

/** `mergeBoard` keys work with no issue by the directory it runs in. Such a card has no conversation to read. */
const SESSION_KEY_PREFIX = 'session:';

/** One sentence. Long enough to name the work, short enough that a card stays a card. */
const DETAIL_LIMIT = 160;

/**
 * How long a card waits after each failed attempt, and how many it gets. Without this every failure mode — a
 * logged-out CLI, a usage limit, a timeout — retries at the rate the board broadcasts, which is a spawn loop that
 * only stops when the developer notices. After the last one the card waits for a return or for the developer to ask.
 */
const BACKOFF_MS = [60_000, 120_000, 300_000, 1_800_000];

/**
 * What the board's reading of a card is worth. Bumped whenever the prompt, the action list or the qualifier rules
 * change what an answer to the same evidence would be: a stored entry from an older revision is dropped on read,
 * which is what makes its card due again. Without it the board goes on showing sentences a fixed classifier would
 * no longer write, since a card is read once and nothing else re-reads it.
 */
export const TRIAGE_REVISION = 2;

/** The actions the hub reads off the pull request itself, whatever anybody wrote about it. */
export const DERIVED_ACTIONS: readonly TriageAction[] = ['fix-checks', 'merge-upstream', 'resolve-conflicts', 'land'];

/**
 * The one action the model is never offered. The line is that the model may report a problem somebody named, and
 * only the hub may say everything is fine: a comment reading "auto-merge failed" or "please rebase" is evidence, and
 * a common one, but "ship it" is an opinion where mergeability is a fact. `mergeable` is `UNKNOWN` in exactly the
 * window a card arrives (`docs/mechanics.md` §31), so a model with no word for a conflict has nowhere to put one.
 */
export const MODEL_MAY_NOT_SAY: readonly TriageAction[] = ['land'];

/** What the model may answer. `derivedAction` still outranks it wherever GitHub has computed a fact. */
export const CLASSIFIED_ACTIONS = TRIAGE_ACTIONS.filter((action) => !MODEL_MAY_NOT_SAY.includes(action));

/** What the model is held to. Two fields, and an action outside the list is refused rather than read as `other`. */
export const triageJsonSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: CLASSIFIED_ACTIONS },
    detail: { type: 'string', maxLength: DETAIL_LIMIT },
  },
  required: ['action', 'detail'],
  additionalProperties: false,
} as const;

// The schema is what the model is asked for; this is what is accepted. Both name the classified actions only, so an
// answer of `land` is refused rather than passed through on a pull request whose facts said nothing.
const parsed = z.object({
  action: z.enum(CLASSIFIED_ACTIONS as [TriageAction, ...TriageAction[]]),
  detail: z.string().min(1),
});

/**
 * The classifier's answer, or null where it is not one. `maxLength` in the schema is what the model is asked for and
 * a long sentence is not worth discarding a good classification over, so an over-long one is cut at a word here.
 */
export function readTriageResult(value: unknown): TriageResult | null {
  const result = parsed.safeParse(value);

  if (!result.success) {
    return null;
  }

  const detail = result.data.detail.trim();

  if (detail.length <= DETAIL_LIMIT) {
    return { action: result.data.action, detail };
  }

  const cut = detail.slice(0, DETAIL_LIMIT - 1);
  const space = cut.lastIndexOf(' ');

  return { action: result.data.action, detail: `${space > 0 ? cut.slice(0, space) : cut}…` };
}

/** What each action is called on a card. Duplicated into both clients, so it is pinned by a parity table in each. */
export const TRIAGE_LABELS: Readonly<Record<TriageAction, string>> = {
  'begin-work': 'Begin work',
  'answer-design-question': 'Answer design question',
  'uat-question': 'UAT question',
  'uat-failure': 'UAT failure',
  'review-others': 'Review their PR',
  'address-review': 'Answer review',
  'fix-checks': 'Fix failing checks',
  'merge-upstream': 'Merge upstream',
  'resolve-conflicts': 'Resolve conflicts',
  land: 'Land it',
  other: 'Other',
};

export const TRIAGE_QUALIFIERS: Readonly<Record<TriageQualifier, string>> = {
  initial: 'initial',
  followup: 'followup',
};

/** How a triaged card reads, in one place because both boards draw it. */
export function triageLabel(action: TriageAction, qualifier: TriageQualifier | null): string {
  return qualifier === null ? TRIAGE_LABELS[action] : `${TRIAGE_LABELS[action]} · ${TRIAGE_QUALIFIERS[qualifier]}`;
}

/**
 * How long a reading is presented as current whatever else happens. The evidence below is everything the board can
 * see about a card, and it is not everything a card is: a comment on the pull request, a check going red and a
 * branch falling behind all move the work without moving any of it. So a reading also ages out, because saying
 * "this was true yesterday" is honest where claiming it is true now would not be (R24).
 */
export const EVIDENCE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * What the card looked like when it was triaged. A label is decided once, so this is what lets a card say the answer
 * has aged rather than presenting a Monday reading of a Thursday card as current (R24).
 */
export function evidenceOf(issue: IssueCard): string {
  const pr = issue.pullRequest;

  return [issue.updatedAt, issue.status ?? '', pr?.number ?? '', pr?.state ?? '', pr?.reviewDecision ?? ''].join('|');
}

const triageEntry = z.object({
  action: z.enum(TRIAGE_ACTIONS),
  revision: z.literal(TRIAGE_REVISION),
  qualifier: z.enum(['initial', 'followup']).nullable().default(null),
  detail: z.string(),
  at: z.number(),
  agent: z.string(),
  wasArchived: z.boolean().default(false),
  evidence: z.string().default(''),
});

const triageFailure = z.object({
  kind: z.string(),
  message: z.string(),
  attempts: z.number(),
  nextAt: z.number(),
});

const triageState = z.object({
  entries: z.record(z.string(), z.unknown()).default({}),
  failures: z.record(z.string(), z.unknown()).default({}),
});

/**
 * The stored state, or an empty one. Durable, hand-editable, and written by builds that knew a different set of
 * actions — so one unusable entry costs that card its label and nothing else. Refusing the file whole would silently
 * re-triage the entire board, which is the one failure mode here that spends money.
 */
export function readTriageState(stored: unknown): TriageState {
  const outer = triageState.safeParse(stored);

  if (!outer.success) {
    return { entries: {}, failures: {} };
  }

  const entries: Record<string, TriageEntry> = {};
  const failures: Record<string, TriageFailure> = {};

  for (const [key, value] of Object.entries(outer.data.entries)) {
    const entry = triageEntry.safeParse(value);

    if (entry.success) {
      entries[key] = entry.data;
    }
  }

  for (const [key, value] of Object.entries(outer.data.failures)) {
    const failure = triageFailure.safeParse(value);

    if (failure.success) {
      failures[key] = failure.data;
    }
  }

  return { entries, failures };
}

/** Only a card with an issue of its own has a conversation to read. Ad-hoc work and a foreign issue number have none. */
function triageable(card: LanedCard): boolean {
  return card.issue !== null && card.issueNumber !== null && !card.key.startsWith(SESSION_KEY_PREFIX);
}

/**
 * The cards to triage now, in board order. A card is due when it has never been read, or when the last reading
 * belongs to a pass through the developer's hands that has since ended.
 *
 * An archived card is never due, and that is the whole of what keeps this from being a loop. Archived cards stay in
 * every snapshot — the source query does not filter on status — so a rule that made absence the trigger and dropped
 * the entry on archive would re-triage every one of them on every broadcast, for as long as the hub ran.
 */
export function dueForTriage(
  lanes: readonly Lane[],
  state: TriageState,
  running: ReadonlySet<string>,
  now: number,
): string[] {
  const due: string[] = [];

  for (const lane of lanes) {
    if (lane.id === 'archived') {
      continue;
    }

    for (const card of lane.cards) {
      const failure = state.failures[card.key];
      const entry = state.entries[card.key];

      if (!triageable(card) || running.has(card.key)) {
        continue;
      }

      // A card still inside its backoff is not due, and one that has spent its attempts waits for a return or for
      // the developer to ask by hand.
      if (failure !== undefined && failure.nextAt > now) {
        continue;
      }

      if (entry === undefined || entry.wasArchived) {
        due.push(card.key);
      }
    }
  }

  return due;
}

/**
 * The state after a render. An archived card is **marked**, never dropped: the mark is what makes a later return due
 * exactly once, where deleting the entry would make it due on every pass while it sat there. Keys absent from a clean
 * read are pruned, so a card taken off the board entirely is read afresh if it comes back.
 */
export function nextTriageState(lanes: readonly Lane[], state: TriageState, sourcesRead: boolean): TriageState {
  const entries: Record<string, TriageEntry> = {};
  const failures: Record<string, TriageFailure> = { ...state.failures };
  const shown = new Set<string>();
  const archived = new Set<string>();

  for (const lane of lanes) {
    for (const card of lane.cards) {
      shown.add(card.key);

      if (lane.id === 'archived' && card.issueNumber !== null) {
        archived.add(card.key);
      }
    }
  }

  for (const [key, entry] of Object.entries(state.entries)) {
    // A failed read re-renders the last good cards, so only a clean one proves a card has left the board.
    if (sourcesRead && !shown.has(key)) {
      continue;
    }

    entries[key] = archived.has(key) && !entry.wasArchived ? { ...entry, wasArchived: true } : entry;
  }

  for (const key of Object.keys(failures)) {
    if (sourcesRead && !shown.has(key)) {
      delete failures[key];
    }

    // A card that goes past the developer's hands starts its next pass with a clean slate, attempts included.
    if (archived.has(key)) {
      delete failures[key];
    }
  }

  return { entries, failures };
}

/** The state after a card is read. Its failure, if it had one, is spent — the reading is what replaces it. */
export function withTriaged(state: TriageState, key: string, entry: TriageEntry): TriageState {
  const failures = { ...state.failures };
  delete failures[key];

  return { entries: { ...state.entries, [key]: entry }, failures };
}

/** The state after a card could not be read, with the next time it may be tried. */
export function withTriageFailure(
  state: TriageState,
  key: string,
  failure: { kind: string; message: string },
  now: number,
): TriageState {
  const attempts = (state.failures[key]?.attempts ?? 0) + 1;
  const wait = BACKOFF_MS[attempts - 1];

  return {
    ...state,
    failures: {
      ...state.failures,
      // Out of attempts: never again on its own, which is what keeps a permanently broken CLI from being a spawn loop.
      [key]: { ...failure, attempts, nextAt: wait === undefined ? Number.POSITIVE_INFINITY : now + wait },
    },
  };
}

/** Forgets what the board knows about one card, so the developer asking for it again is read as never having read it. */
export function forgetTriage(state: TriageState, key: string): TriageState {
  const entries = { ...state.entries };
  const failures = { ...state.failures };
  delete entries[key];
  delete failures[key];

  return { entries, failures };
}

function mine(login: string | null, logins: readonly string[]): boolean {
  return login !== null && logins.some((own) => own.toLowerCase() === login.toLowerCase());
}

/**
 * Whether a review round is the first or a later one, read from the pull request's own history rather than from the
 * model: `address-review` is a followup once the developer has replied on it, and `review-others` once anybody but
 * the author has already reviewed it.
 *
 * `review-others` takes two signals because a review here is routinely neither a GitHub review nor the developer's
 * own hand: it is given as a plain comment, or submitted by an agent account that is none of their logins, and a
 * re-review is a re-review whoever gave the first one. The pull request's author is excluded from the first signal
 * because GitHub records their own inline replies as reviews, which would make every answered one read as round two.
 */
export function qualifierOf(action: TriageAction, context: TriageContext): TriageQualifier | null {
  const pr = context.pullRequest;

  if (pr === null) {
    return null;
  }

  if (action === 'address-review') {
    const spoken = pr.comments.some((comment) => mine(comment.author, context.logins));
    const replied = pr.threads.some((thread) =>
      thread.comments.slice(1).some((comment) => mine(comment.author, context.logins)),
    );

    return spoken || replied ? 'followup' : 'initial';
  }

  if (action === 'review-others') {
    // A pending review is a draft nobody but its writer has seen, and `gh` runs as the developer, so it is fetched.
    // An unresolvable author is read as nobody having reviewed: claiming a round they have not had is the worse miss.
    const reviewed = pr.reviews.some(
      (review) =>
        review.author !== null &&
        review.state !== 'PENDING' &&
        pr.author !== null &&
        review.author.toLowerCase() !== pr.author.toLowerCase(),
    );
    // On somebody else's pull request every word of the developer's is a review, whatever GitHub filed it as. Only
    // the most recent comments are fetched, so a first pass further back than that reads as a first pass here too.
    const spoken = pr.comments.some((comment) => mine(comment.author, context.logins));

    return reviewed || spoken ? 'followup' : 'initial';
  }

  return null;
}

/**
 * What the pull request itself says, where it says anything. These outrank the model because they are facts: a branch
 * that will not merge is a branch to fix whatever anybody wrote about it.
 *
 * Nothing fires on a draft, on somebody else's pull request, on one already merged or closed, or on `UNKNOWN` —
 * which GitHub answers until it has computed mergeability, and which is common in the very window a card arrives
 * (`docs/mechanics.md` §31). `UNKNOWN` means "not computed", never "fine".
 */
export function derivedAction(context: TriageContext): TriageAction | null {
  const pr = context.pullRequest;

  if (pr === null || pr.state !== 'OPEN' || pr.isDraft || !mine(pr.author, context.logins)) {
    return null;
  }

  if (pr.mergeable === 'CONFLICTING') {
    return 'resolve-conflicts';
  }

  // A null rollup is a repository that runs no checks, which is not a repository whose checks have not passed.
  if (pr.checkState === 'FAILURE' || pr.checkState === 'ERROR') {
    return 'fix-checks';
  }

  if (pr.mergeStateStatus === 'BEHIND') {
    return 'merge-upstream';
  }

  // Keyed on CLEAN rather than assembled from parts: BLOCKED is what a repository requiring review answers for
  // everything else, so a hand-built condition would name every open pull request as ready to land.
  if (pr.mergeStateStatus === 'CLEAN' && pr.reviewDecision === 'APPROVED') {
    return 'land';
  }

  return null;
}

/** What a fact says, in a sentence, for a card whose reading it overruled. */
function factSentence(action: TriageAction, pr: TriagePullRequest): string {
  const at = `Pull request #${pr.number}`;

  switch (action) {
    case 'resolve-conflicts':
      return `${at} has conflicts and will not merge.`;
    case 'fix-checks':
      return `${at} has failing checks.`;
    case 'merge-upstream':
      return `${at} is behind its base branch.`;
    default:
      return `${at} is approved and ready to merge.`;
  }
}

/**
 * The card's action, with the facts given the last word.
 *
 * The model's sentence survives where the facts agreed with it or said nothing, because it describes the work better
 * than anything generated here. Where a fact overruled the reading it does not: the sentence then describes a problem
 * the card no longer has, and "Land it — has merge conflicts to resolve" is a card contradicting itself (R24).
 */
export function overrideAction(result: TriageResult, context: TriageContext): { action: TriageAction; qualifier: TriageQualifier | null; detail: string } {
  const derived = derivedAction(context);
  const action = derived ?? result.action;
  const overruled = derived !== null && derived !== result.action && context.pullRequest !== null;

  return {
    action,
    qualifier: qualifierOf(action, context),
    detail: overruled ? factSentence(derived, context.pullRequest!) : result.detail,
  };
}

/** Every lane again, each triageable card carrying what the board knows about it. */
export function withTriage(
  lanes: readonly Lane[],
  state: TriageState,
  running: ReadonlySet<string>,
  now: number,
): Lane[] {
  return lanes.map((lane) => ({
    ...lane,
    cards: lane.cards.map((card): LanedCard => {
      if (running.has(card.key)) {
        return { ...card, triage: { state: 'running' } };
      }

      if (card.issue === null) {
        return card;
      }

      const entry = state.entries[card.key];

      if (entry === undefined) {
        const failure = state.failures[card.key];

        // A card that has never been read carries nothing. One the board tried and could not read carries a control
        // and no words: what went wrong is stated once above the lanes, and this is where the developer asks again.
        return failure === undefined
          ? card
          : { ...card, triage: { state: 'failed', attempts: failure.attempts, exhausted: failure.nextAt > now + EVIDENCE_MAX_AGE_MS } };
      }

      const triage: CardTriage = {
        state: 'done',
        action: entry.action,
        qualifier: entry.qualifier,
        detail: entry.detail,
        at: entry.at,
        stale: (entry.evidence !== '' && entry.evidence !== evidenceOf(card.issue)) || now - entry.at > EVIDENCE_MAX_AGE_MS,
      };

      return { ...card, triage };
    }),
  }));
}
