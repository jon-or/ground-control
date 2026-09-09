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

/** Maximum triage explanation length. */
const DETAIL_LIMIT = 160;

/** Retry delays after classification failures. After these are exhausted, require a return or manual retry. */
const BACKOFF_MS = [60_000, 120_000, 300_000, 1_800_000];

/**
 * Threshold for displaying exhausted retries. After all BACKOFF_MS delays have been used, nextAt is Infinity
 * and no automatic retry is due.
 */
const SPENT_ATTEMPTS_MS = 60 * 60 * 1000;

/**
 * Increment when prompt or decision changes invalidate stored triage. Older revisions are discarded and classified
 * again.
 */
export const TRIAGE_REVISION = 7;

const detailProperty = { type: 'string', maxLength: DETAIL_LIMIT } as const;

/** Request only an explanation for a settled action; otherwise require an allowed action too. */
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

// Validate responses against the same action list sent to the model.
const parsed = z.object({
  action: z.enum(TRIAGE_ACTIONS),
  detail: z.string().min(1),
});

const parsedDetail = z.object({ detail: z.string().min(1) });

/** Parse the result and shorten overlong explanations at a word boundary instead of rejecting the classification. */
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

/** Shared action labels, checked by parity tables in both clients. */
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

/** Shared action and review-round label. */
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
 * Status-change timestamp that triggers automatic triage (R38). Other evidence changes only mark results stale.
 * Empty off the project board.
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

/** Validate persisted triage, discarding invalid entries individually to avoid reclassifying the entire board. */
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

/** Triage only assigned issues; ad-hoc and unassigned cards are ineligible. */
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

      // Defer retries until backoff expires; exhausted attempts require a return or manual retry.
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
 * Mark archived entries so a return triggers classification once. Prune absent cards only after a successful
 * source read.
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

    // Clear failures while archived so a later return can retry.
    if (archived.has(key)) {
      delete failures[key];
    }
  }

  return { entries, failures };
}

/** Store the triage result and clear its previous failure. */
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

/** Clear stored triage so a manual retry is immediately eligible. */
export function forgetTriage(state: TriageState, key: string): TriageState {
  const entries = { ...state.entries };
  const failures = { ...state.failures };
  delete entries[key];
  delete failures[key];

  return { entries, failures };
}

function isDeveloperLogin(login: string | null, logins: readonly string[]): boolean {
  return login !== null && logins.some((developerLogin) => developerLogin.toLowerCase() === login.toLowerCase());
}

/**
 * Detect later review rounds from the developer's own PR history. address-review requires a developer reply;
 * review-others requires a developer review or comment. Other people's rounds, bots included, are not the developer's.
 */
export function qualifierOf(action: TriageAction, context: TriageContext): TriageQualifier | null {
  const pr = context.pullRequest;

  if (pr === null) {
    return null;
  }

  if (action === 'address-review') {
    const commented = pr.comments.some((comment) => isDeveloperLogin(comment.author, context.logins));
    const replied = pr.threads.some((thread) =>
      thread.comments.slice(1).some((comment) => isDeveloperLogin(comment.author, context.logins)),
    );

    return commented || replied ? 'followup' : 'initial';
  }

  if (action === 'review-others') {
    // A pending review is a draft nobody but its writer has seen, and `gh` runs as the developer, so it is fetched.
    const reviewed = pr.reviews.some((review) => review.state !== 'PENDING' && isDeveloperLogin(review.author, context.logins));
    // On somebody else's pull request every word of the developer's is a review, whatever GitHub filed it as. Only
    // the most recent comments are fetched, so a first pass further back than that reads as a first pass here too.
    const commented = pr.comments.some((comment) => isDeveloperLogin(comment.author, context.logins));

    return reviewed || commented ? 'followup' : 'initial';
  }

  return null;
}

/**
 * Derive failing-check actions from own open, non-draft PRs. Merge requests require instructions, not mergeability
 * (R39).
 */
export function derivedAction(context: TriageContext): TriageAction | null {
  const pr = context.pullRequest;

  if (pr === null || pr.state !== 'OPEN' || pr.isDraft || !isDeveloperLogin(pr.author, context.logins)) {
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
  const mappedAction = statusAction(context.status, statusLanes);
  const pr = context.pullRequest;
  const ownOpenReview = mappedAction === 'review-others' && pr !== null && pr.state === 'OPEN' && isDeveloperLogin(pr.author, context.logins);

  return (ownOpenReview ? null : mappedAction) ?? derivedAction(context);
}

/** Combine the explanation with the action supplied before classification, preserving consistency between them (R24). */
export function resolveTriage(
  settled: TriageAction | null,
  result: TriageResult,
  context: TriageContext,
): { action: TriageAction; qualifier: TriageQualifier | null; detail: string } {
  const action = settled ?? result.action;

  return { action, qualifier: qualifierOf(action, context), detail: result.detail };
}

/** Attach triage only to eligible cards. */
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
