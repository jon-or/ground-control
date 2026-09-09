import { z } from 'zod';
import { TRIAGE_ACTIONS } from '@ground-control/core';
import type {
  CardTriage,
  IssueCard,
  Lane,
  LaneId,
  LanedCard,
  TriageAction,
  TriageContext,
  TriageEntry,
  TriageFailure,
  TriageQualifier,
  TriageResult,
  TriageState,
} from '@ground-control/core';

export { TRIAGE_ACTIONS };

/** `mergeBoard` keys work with no issue by the checkout it runs in. Such a card has no conversation to read. */
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
 * Threshold for displaying exhausted retries. After all BACKOFF_MS delays have been used, nextAt is Infinity
 * and no automatic retry is due.
 */
const SPENT_ATTEMPTS_MS = 60 * 60 * 1000;

/**
 * What the board's reading of a card is worth. Bumped whenever the prompt, the action list or the qualifier rules
 * change what an answer to the same evidence would be: a stored entry from an older revision is dropped on read,
 * which is what makes its card due again. Without it the board goes on showing sentences a fixed classifier would
 * no longer write, since a card is read once and nothing else re-reads it.
 */
export const TRIAGE_REVISION = 6;

const detailProperty = { type: 'string', maxLength: DETAIL_LIMIT } as const;

/**
 * What the model is held to. Where the evidence already settled the action it is asked for the sentence alone: the
 * label is then a thing the model cannot get wrong, and its whole attention goes on the one field only it can write.
 * An action outside the list is refused rather than read as `other`.
 */
export function triageJsonSchema(settled: TriageAction | null): object {
  return settled !== null
    ? { type: 'object', properties: { detail: detailProperty }, required: ['detail'], additionalProperties: false }
    : {
        type: 'object',
        properties: { action: { type: 'string', enum: TRIAGE_ACTIONS }, detail: detailProperty },
        required: ['action', 'detail'],
        additionalProperties: false,
      };
}

// The schema is what the model is asked for; this is what is accepted. Both name the same list, so an answer
// outside it is refused rather than read as `other`.
const parsed = z.object({
  action: z.enum(TRIAGE_ACTIONS),
  detail: z.string().min(1),
});

const parsedDetail = z.object({ detail: z.string().min(1) });

/**
 * The classifier's answer, or null where it is not one. `maxLength` in the schema is what the model is asked for and
 * a long sentence is not worth discarding a good classification over, so an over-long one is cut at a word here.
 */
export function readTriageResult(value: unknown, settled: TriageAction | null): TriageResult | null {
  const result = settled !== null ? parsedDetail.safeParse(value) : parsed.safeParse(value);

  if (!result.success) {
    return null;
  }

  const action = settled ?? (result.data as z.infer<typeof parsed>).action;
  const detail = result.data.detail.trim();

  if (detail.length <= DETAIL_LIMIT) {
    return { action, detail };
  }

  const cut = detail.slice(0, DETAIL_LIMIT - 1);
  const space = cut.lastIndexOf(' ');

  return { action, detail: `${space > 0 ? cut.slice(0, space) : cut}…` };
}

/** What each action is called on a card. Duplicated into both clients, so it is pinned by a parity table in each. */
export const TRIAGE_LABELS: Readonly<Record<TriageAction, string>> = {
  develop: 'Develop',
  'dev-question': 'Dev question',
  'qa-question': 'QA question',
  'qa-failure': 'QA failure',
  'review-others': 'Review their PR',
  'address-review': 'Answer review',
  'fix-checks': 'Fix failing checks',
  'merge-upstream': 'Merge upstream',
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
 * Record issue/PR changes and failing-check state for triage freshness. Exclude reviewDecision because it can
 * lag the team's status-based workflow; submitted reviews already affect PR updatedAt. Elapsed time alone does
 * not invalidate evidence.
 */
export function evidenceOf(issue: IssueCard): string {
  const pr = issue.pullRequest;

  return [
    issue.updatedAt,
    issue.status ?? '',
    issue.statusChangedAt ?? '',
    pr?.number ?? '',
    pr?.state ?? '',
    pr?.updatedAt ?? '',
    pr?.headOid ?? '',
    pr?.checksRed ?? '',
  ].join('|');
}

/**
 * The one thing worth spending a model call to re-read (R38). On this board a status names the work and the assignee
 * names who does it, so a card whose status has moved is a card that has been told something new — where a comment,
 * a review and a check all move `evidenceOf` and none of them is an instruction. Empty off the project board, which
 * is a card whose status can never move.
 */
export function triggerOf(issue: IssueCard): string {
  return issue.statusChangedAt ?? '';
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
  trigger: z.string().default(''),
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

/**
 * Only a card with an issue of the developer's own has a conversation worth paying to read. Ad-hoc work has none,
 * and an issue nobody assigned them is somebody else's to be told what it needs.
 */
function triageable(card: LanedCard): card is LanedCard & { issue: IssueCard } {
  return card.issue !== null && card.issueNumber !== null && card.unassigned !== true && !card.key.startsWith(SESSION_KEY_PREFIX);
}

/**
 * Select eligible cards with no valid reading or a changed membership/status trigger, in board order. Exclude
 * archived cards even though snapshots retain them; absence-based invalidation would repeatedly classify those
 * cards.
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
      const issue = card.issue;

      if (issue === null || !triageable(card) || running.has(card.key)) {
        continue;
      }

      // A card still inside its backoff is not due, and one that has spent its attempts waits for a return or for
      // the developer to ask by hand.
      if (failure !== undefined && failure.nextAt > now) {
        continue;
      }

      if (entry === undefined || entry.wasArchived || entry.trigger !== triggerOf(issue)) {
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
 * Detect later review rounds from PR history. address-review requires a developer reply; review-others also
 * recognizes prior reviews by non-authors and review comments. Exclude author reviews, which can be their own
 * inline replies.
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
    // Submitted reviews require a known PR author to exclude self-reviews; comments are checked separately.
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
 * What the pull request itself says, where it says anything. This outranks the model because it is a fact: a branch
 * whose build is red is a branch to fix whatever anybody wrote about it.
 *
 * Nothing fires on a draft, on somebody else's pull request, or on one already merged or closed. Mergeability is not
 * read at all — a merge is something somebody asks for, not something GitHub computes (R39).
 */
export function derivedAction(context: TriageContext): TriageAction | null {
  const pr = context.pullRequest;

  if (pr === null || pr.state !== 'OPEN' || pr.isDraft || !mine(pr.author, context.logins)) {
    return null;
  }

  // A null rollup is a repository that runs no checks, which is not a repository whose checks have not passed.
  return pr.checkState === 'FAILURE' || pr.checkState === 'ERROR' ? 'fix-checks' : null;
}

/**
 * Interpret Review and Unstarted through the shared status-to-lane map. Build and unmapped statuses leave the
 * action undecided. Use own-property lookup so inherited object properties cannot act as mappings.
 */
export function statusAction(status: string | null, statusLanes: Readonly<Record<string, LaneId>>): TriageAction | null {
  if (status === null || !Object.hasOwn(statusLanes, status)) {
    return null;
  }

  switch (statusLanes[status]) {
    case 'review':
      return 'review-others';
    case 'unstarted':
      return 'develop';
    default:
      return null;
  }
}

/**
 * Prefer deterministic status rules, then PR facts. Review status on the developer's own open PR leaves the
 * action undecided because the outstanding review may belong to someone else.
 */
export function settledAction(context: TriageContext, statusLanes: Readonly<Record<string, LaneId>>): TriageAction | null {
  const named = statusAction(context.status, statusLanes);
  const pr = context.pullRequest;
  const own = named === 'review-others' && pr !== null && pr.state === 'OPEN' && mine(pr.author, context.logins);

  return (own ? null : named) ?? derivedAction(context);
}

/**
 * The card's action and its sentence. Where `settled` decided the action the model was told so and wrote its
 * sentence knowing it, so both describe the same card — which is what a fact overruling a finished reading could
 * never manage, and why there is no generated sentence here (R24).
 */
export function resolveTriage(
  settled: TriageAction | null,
  result: TriageResult,
  context: TriageContext,
): { action: TriageAction; qualifier: TriageQualifier | null; detail: string } {
  const action = settled ?? result.action;

  return { action, qualifier: qualifierOf(action, context), detail: result.detail };
}

/** Every lane again, each triageable card carrying what the board knows about it. A card that is not carries nothing. */
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

      // The same test `dueForTriage` reads. A card read while it was assigned keeps its key once it is not, and
      // rendering that entry would put a stale chip — and the action control behind it — on somebody else's issue.
      if (!triageable(card)) {
        return card;
      }

      const entry = state.entries[card.key];

      if (entry === undefined) {
        const failure = state.failures[card.key];

        // A card that has never been read carries nothing. One the board tried and could not read carries a control
        // and no words: what went wrong is stated once above the lanes, and this is where the developer asks again.
        return failure === undefined
          ? card
          : { ...card, triage: { state: 'failed', attempts: failure.attempts, exhausted: failure.nextAt > now + SPENT_ATTEMPTS_MS } };
      }

      const triage: CardTriage = {
        state: 'done',
        action: entry.action,
        qualifier: entry.qualifier,
        detail: entry.detail,
        at: entry.at,
        stale: entry.evidence !== '' && entry.evidence !== evidenceOf(card.issue),
      };

      return { ...card, triage };
    }),
  }));
}
