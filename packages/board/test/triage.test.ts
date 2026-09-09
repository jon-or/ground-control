import { describe, expect, it } from 'vitest';
import type { IssueCard, Lane, TriageAction, TriageContext, TriageEntry, TriageQualifier, TriageState } from '@ground-control/core';
import { assignLanes } from '../src/lanes.js';
import type { BoardCard } from '../src/types.js';
import {
  TRIAGE_ACTIONS,
  TRIAGE_LABELS,
  TRIAGE_REVISION,
  derivedAction,
  dueForTriage,
  evidenceOf,
  forgetTriage,
  nextTriageState,
  qualifierOf,
  readTriageResult,
  readTriageState,
  resolveTriage,
  settledAction,
  statusAction,
  triageJsonSchema,
  triageLabel,
  triggerOf,
  withTriage,
  withTriageFailure,
  withTriaged,
} from '../src/triage.js';

/** Every label both boards must draw, as literals. Duplicated verbatim in each client's suite — see the test below. */
const TRIAGE_LABEL_ROWS: [TriageAction, TriageQualifier | null, string][] = [
  ['develop', null, 'Develop'],
  ['dev-question', null, 'Dev question'],
  ['qa-question', null, 'QA question'],
  ['qa-failure', null, 'QA failure'],
  ['review-others', 'initial', 'Review their PR · initial'],
  ['review-others', 'followup', 'Review their PR · followup'],
  ['address-review', 'initial', 'Answer review · initial'],
  ['address-review', 'followup', 'Answer review · followup'],
  ['fix-checks', null, 'Fix failing checks'],
  ['merge-upstream', null, 'Merge upstream'],
  ['other', null, 'Other'],
];

const RULES = { boardStatuses: ['⚒️ Dev'], statusLanes: {}, logins: ['dev-1'] };
const MEMORY = { placements: {}, pastMyHandsAt: {}, archived: [], seen: [], statuses: ['⚒️ Dev'] };

function issue(over: Partial<IssueCard> = {}): IssueCard {
  return {
    number: 17198,
    title: 'Channel mapping drops rows past the first page',
    type: 'Bug',
    typeColor: 'RED',
    url: 'https://github.com/example-org/example-repo/issues/17198',
    status: '⚒️ Dev',
    statusColor: 'BLUE',
    statusChangedAt: '2026-08-30T09:00:00Z',
    assignees: ['dev-1'],
    avatar: null,
    pullRequest: null,
    updatedAt: '2026-09-01T10:00:00Z',
    ...over,
  };
}

function card(over: Partial<BoardCard> = {}): BoardCard {
  return { key: 'issue:17198', issue: issue(), issueNumber: 17198, sessions: [], ...over };
}

function lanesOf(...cards: BoardCard[]): Lane[] {
  return assignLanes(cards, RULES, MEMORY);
}

function entry(over: Partial<TriageEntry> = {}): TriageEntry {
  return {
    revision: TRIAGE_REVISION,
    action: 'develop',
    qualifier: null,
    detail: 'Pick it up.',
    at: 1_000,
    agent: 'claude',
    wasArchived: false,
    evidence: evidenceOf(issue()),
    trigger: triggerOf(issue()),
    ...over,
  };
}

function state(over: Partial<TriageState> = {}): TriageState {
  return { entries: {}, failures: {}, ...over };
}

const NONE = new Set<string>();

describe('which cards are due', () => {
  it('reads a card nobody has read', () => {
    expect(dueForTriage(lanesOf(card()), state(), NONE, 0)).toEqual(['issue:17198']);
  });

  it('does not read one it has already read', () => {
    expect(dueForTriage(lanesOf(card()), state({ entries: { 'issue:17198': entry() } }), NONE, 0)).toEqual([]);
  });

  it('never reads an archived card, however many passes run over it', () => {
    // Archived cards remain in snapshots; retaining marked entries prevents repeated classification.
    const gone = lanesOf(card({ issue: issue({ status: '🚀 Released' }) }));

    expect(gone.find((lane) => lane.id === 'archived')?.cards).toHaveLength(1);

    let held = state({ entries: { 'issue:17198': entry() } });

    for (let pass = 0; pass < 20; pass++) {
      expect(dueForTriage(gone, held, NONE, pass * 1_000)).toEqual([]);
      held = nextTriageState(gone, held, true);
    }

    expect(held.entries['issue:17198']?.wasArchived).toBe(true);
  });

  it('classifies returned cards once', () => {
    const away = lanesOf(card({ issue: issue({ status: '🚀 Released' }) }));
    const back = lanesOf(card());

    const archived = nextTriageState(away, state({ entries: { 'issue:17198': entry() } }), true);

    expect(dueForTriage(back, archived, NONE, 0)).toEqual(['issue:17198']);

    // Reading it clears the mark, so the next pass leaves it alone rather than reading it again.
    const read = withTriaged(archived, 'issue:17198', entry({ action: 'address-review' }));

    expect(dueForTriage(back, read, NONE, 0)).toEqual([]);
  });

  it('never reads work with no issue of its own', () => {
    const adhoc = card({ key: 'session:d--work-repo', issue: null, issueNumber: null });

    expect(dueForTriage(lanesOf(adhoc), state(), NONE, 0)).toEqual([]);
  });

  /** What an issue somebody else now owns is waiting on is not the developer's to be told, and not theirs to pay for. */
  it('never reads an issue the developer is not assigned', () => {
    const foreign = card({ key: 'issue:99', issueNumber: 99, unassigned: true });

    expect(dueForTriage(lanesOf(foreign), state(), NONE, 0)).toEqual([]);
  });

  it('does not read one it is already reading', () => {
    expect(dueForTriage(lanesOf(card()), state(), new Set(['issue:17198']), 0)).toEqual([]);
  });

  it('waits out a failure, then tries again', () => {
    const failed = withTriageFailure(state(), 'issue:17198', { kind: 'classify-failed', message: 'no' }, 1_000);

    expect(failed.failures['issue:17198']).toMatchObject({ attempts: 1, nextAt: 61_000 });
    expect(dueForTriage(lanesOf(card()), failed, NONE, 60_999)).toEqual([]);
    expect(dueForTriage(lanesOf(card()), failed, NONE, 61_000)).toEqual(['issue:17198']);
  });

  it('stops automatic retries after the retry budget', () => {
    let failed = state();

    for (const expected of [60_000, 120_000, 300_000, 1_800_000]) {
      failed = withTriageFailure(failed, 'issue:17198', { kind: 'classify-missing', message: 'no' }, 0);
      expect(failed.failures['issue:17198']?.nextAt).toBe(expected);
    }

    failed = withTriageFailure(failed, 'issue:17198', { kind: 'classify-missing', message: 'no' }, 0);

    expect(failed.failures['issue:17198']?.attempts).toBe(5);
    expect(dueForTriage(lanesOf(card()), failed, NONE, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('reads every due card, in board order', () => {
    const cards = [card(), card({ key: 'issue:17199', issue: issue({ number: 17199 }), issueNumber: 17199 })];

    expect(dueForTriage(lanesOf(...cards), state(), NONE, 0)).toEqual(['issue:17198', 'issue:17199']);
  });
});

describe('what a pass leaves behind', () => {
  it('marks an archived card rather than dropping it', () => {
    const away = lanesOf(card({ issue: issue({ status: '🚀 Released' }) }));
    const next = nextTriageState(away, state({ entries: { 'issue:17198': entry() } }), true);

    expect(next.entries['issue:17198']).toMatchObject({ action: 'develop', wasArchived: true });
  });

  it('prunes a card that left the board on a clean read, and keeps it on a failed one', () => {
    const held = state({ entries: { 'issue:17198': entry() } });

    expect(nextTriageState([], held, true).entries).toEqual({});
    expect(nextTriageState([], held, false).entries).toHaveProperty('issue:17198');
  });

  it('clears failures for archived cards so a return can retry', () => {
    const away = lanesOf(card({ issue: issue({ status: '🚀 Released' }) }));
    const failed = withTriageFailure(state(), 'issue:17198', { kind: 'classify-failed', message: 'no' }, 0);

    expect(nextTriageState(away, failed, true).failures).toEqual({});
  });

  it('forgets one card when the developer asks for it again', () => {
    const held = withTriageFailure(state({ entries: { 'issue:17198': entry() } }), 'issue:17198', { kind: 'k', message: 'm' }, 0);
    const forgotten = forgetTriage(held, 'issue:17198');

    expect(forgotten.entries).toEqual({});
    expect(forgotten.failures).toEqual({});
    expect(dueForTriage(lanesOf(card()), forgotten, NONE, 0)).toEqual(['issue:17198']);
  });
});

describe('reading the stored state', () => {
  it('drops one unusable entry rather than the whole file, which would re-read the entire board', () => {
    const stored = {
      entries: {
        'issue:1': { revision: TRIAGE_REVISION, action: 'merge-upstream', qualifier: null, detail: 'go', at: 1, agent: 'claude', wasArchived: false, evidence: 'e' },
        'issue:2': { revision: TRIAGE_REVISION, action: 'a-thing-no-build-has', detail: 'go', at: 1, agent: 'claude' },
      },
      failures: { 'issue:3': { kind: 'k', message: 'm', attempts: 1, nextAt: 5 }, 'issue:4': { kind: 'k' } },
    };

    const read = readTriageState(stored);

    expect(Object.keys(read.entries)).toEqual(['issue:1']);
    expect(Object.keys(read.failures)).toEqual(['issue:3']);
  });

  it('defaults optional fields within the current revision', () => {
    const read = readTriageState({
      entries: { 'issue:1': { revision: TRIAGE_REVISION, action: 'merge-upstream', detail: 'go', at: 1, agent: 'claude' } },
    });

    expect(read.entries['issue:1']).toMatchObject({ qualifier: null, wasArchived: false, evidence: '' });
  });

  it('drops an entry read under an older revision, which is what re-reads those cards', () => {
    // Discard older triage revisions so stale explanations are classified again.
    const older = { action: 'develop', detail: 'Pick it up.', at: 1, agent: 'claude' };
    const read = readTriageState({
      entries: {
        'issue:1': older,
        'issue:2': { ...older, revision: TRIAGE_REVISION - 1 },
        'issue:3': { ...older, revision: TRIAGE_REVISION },
      },
    });

    expect(Object.keys(read.entries)).toEqual(['issue:3']);
  });

  it('drops an entry naming an action this build retired, so a shrunken list re-reads too', () => {
    const read = readTriageState({
      entries: {
        'issue:1': { revision: TRIAGE_REVISION, action: 'awaiting-others', detail: 'Waiting.', at: 1, agent: 'claude' },
        'issue:2': { revision: TRIAGE_REVISION, action: 'develop', detail: 'Pick it up.', at: 1, agent: 'claude' },
      },
    });

    expect(Object.keys(read.entries)).toEqual(['issue:2']);
  });

  it('reads an unusable file as empty rather than throwing on every render', () => {
    expect(readTriageState('nonsense')).toEqual({ entries: {}, failures: {} });
    expect(readTriageState(null)).toEqual({ entries: {}, failures: {} });
  });
});

/** The actions the open-mode schema offers, read back out of the document the model is actually sent. */
function offered(): readonly string[] {
  return (triageJsonSchema(null) as { properties: { action: { enum: string[] } } }).properties.action.enum;
}

describe('the classifier answer', () => {
  it('takes an answer that is one of the actions the model was offered', () => {
    expect(readTriageResult({ action: 'qa-failure', detail: 'Safari.' }, null)).toEqual({ action: 'qa-failure', detail: 'Safari.' });
  });

  it('refuses an action no build has, rather than reading it as other', () => {
    expect(readTriageResult({ action: 'ship-it', detail: 'go' }, null)).toBeNull();
    expect(readTriageResult({ action: 'other' }, null)).toBeNull();
    expect(readTriageResult({ detail: 'go' }, null)).toBeNull();
    expect(readTriageResult({ action: 'other', detail: '' }, null)).toBeNull();
    expect(readTriageResult('other', null)).toBeNull();
  });

  it('takes a merge from the model, because a merge is a request rather than a fact', () => {
    // Merges require written requests. Failing-check facts are applied before model classification (R39).
    for (const action of ['merge-upstream', 'fix-checks'] as const) {
      expect(readTriageResult({ action, detail: 'go' }, null)).toEqual({ action, detail: 'go' });
      expect(offered()).toContain(action);
    }
  });

  it('refuses a retired action, so a stale answer never reaches a card', () => {
    expect(readTriageResult({ action: 'land', detail: 'go' }, null)).toBeNull();
    expect(readTriageResult({ action: 'resolve-conflicts', detail: 'go' }, null)).toBeNull();
    expect(offered()).not.toContain('land');
    expect(offered()).not.toContain('resolve-conflicts');
  });

  it('truncates overlong explanations at a word boundary', () => {
    const long = `${'word '.repeat(60)}end`;
    const result = readTriageResult({ action: 'other', detail: long }, null);

    expect(result?.detail.length).toBeLessThanOrEqual(160);
    expect(result?.detail.endsWith('…')).toBe(true);
    expect(result?.detail).not.toContain('wor…');
  });

  it('offers the model every action there is, and labels all nine', () => {
    expect(offered()).toEqual([...TRIAGE_ACTIONS]);
    expect(Object.keys(TRIAGE_LABELS).sort()).toEqual([...TRIAGE_ACTIONS].sort());
  });
});

describe('what the evidence settles before the model is asked', () => {
  function context(over: Partial<TriageContext['pullRequest']> = {}, logins = ['dev-1']): TriageContext {
    return {
      issueNumber: 17198,
      title: 'x',
      body: '',
      status: '⚒️ Dev',
      stateEvents: [],
      comments: [],
      logins,
      pullRequest: {
        number: 42,
        title: 'x',
        body: '',
        state: 'OPEN',
        isDraft: false,
        author: 'dev-1',
        authorName: null,
        baseRefName: 'master',
        headRefName: '17198-channel-mapping',
        headOid: '9ab0cde1111111111111111111111111111111ff',
        checkState: 'SUCCESS',
        comments: [],
        reviews: [],
        reviewRequests: [],
        threads: [],
        ...over,
      },
      repository: 'example-org/example-repo',
      defaultBranch: 'master',
    };
  }

  it('reads a red check rollup as the one fact it derives', () => {
    expect(derivedAction(context({ checkState: 'FAILURE' }))).toBe('fix-checks');
    expect(derivedAction(context({ checkState: 'ERROR' }))).toBe('fix-checks');
  });

  /** Only failing checks derive an action from PR facts across these states (R39). */
  it('derives nothing but the failing check, over every state a pull request can be in', () => {
    const states: Partial<TriageContext['pullRequest']>[] = [];

    for (const checkState of ['SUCCESS', 'PENDING', null]) {
      for (const isDraft of [true, false]) {
        for (const baseRefName of ['master', '17000-parent-feature']) {
          states.push({ checkState, isDraft, baseRefName });
        }
      }
    }

    expect(states).toHaveLength(12);
    expect([...new Set(states.map((state) => derivedAction(context(state))))]).toEqual([null]);
  });

  /** Stale or conflicting branches alone do not authorize merges (R39). */
  it('says nothing about a green pull request, whatever else is true of it', () => {
    expect(derivedAction(context({ checkState: 'SUCCESS' }))).toBeNull();
    expect(derivedAction(context({ checkState: null }))).toBeNull();
  });

  it('reads a null check rollup as a repository with no checks, not as checks that failed', () => {
    expect(derivedAction(context({ checkState: null }))).toBeNull();
  });

  it('says nothing about a draft, a colleague pull request, or one already landed', () => {
    expect(derivedAction(context({ isDraft: true, checkState: 'FAILURE' }))).toBeNull();
    expect(derivedAction(context({ author: 'dev-9', checkState: 'FAILURE' }))).toBeNull();
    expect(derivedAction(context({ state: 'MERGED', checkState: 'FAILURE' }))).toBeNull();
    expect(derivedAction(context({ state: 'CLOSED', checkState: 'FAILURE' }))).toBeNull();
  });

  it('says nothing at all about a card with no pull request', () => {
    expect(derivedAction({ ...context(), pullRequest: null })).toBeNull();
  });

  it('reads the action off the status, whatever the pull request says about itself', () => {
    // Review status can require reviewing a colleague PR even when it cannot merge.
    const lanes = { '🎁 Assigned': 'unstarted', '🔍 Dev Review': 'review' } as const;

    expect(statusAction('🔍 Dev Review', lanes)).toBe('review-others');
    expect(statusAction('🎁 Assigned', lanes)).toBe('develop');
    expect(settledAction({ ...context({ author: 'dev-9', checkState: 'FAILURE' }), status: '🔍 Dev Review' }, lanes)).toBe('review-others');
    expect(settledAction({ ...context({ checkState: 'FAILURE' }), status: '🎁 Assigned' }, lanes)).toBe('develop');
  });

  it('never calls the developer own open pull request theirs to review, whatever the status says', () => {
    // Review status alone cannot identify whose PR needs review.
    const lanes = { '🔍 Dev Review': 'review' } as const;
    const own = (over = {}) => ({ ...context(over), status: '🔍 Dev Review' });

    expect(settledAction(own({ checkState: 'FAILURE' }), lanes)).toBe('fix-checks');
    // Nothing computed about it either, so the conversation decides — a pull request awaiting a reviewer is Other.
    expect(settledAction(own(), lanes)).toBeNull();
    // A merged or closed one is read as nothing, the way lane arrival reads it, so the status stands again.
    expect(settledAction(own({ state: 'MERGED' }), lanes)).toBe('review-others');
    expect(settledAction({ ...own(), pullRequest: null }, lanes)).toBe('review-others');
  });

  it('leaves the action to the pull request and the model where the status names none', () => {
    const lanes = { '🎁 Assigned': 'unstarted', '🔍 Dev Review': 'review' } as const;

    // ⚒️ Dev spans planning, building and answering review alike, so it settles nothing on its own.
    expect(statusAction('⚒️ Dev', lanes)).toBeNull();
    expect(statusAction(null, lanes)).toBeNull();
    expect(statusAction('⚒️ Dev', {})).toBeNull();
    expect(settledAction(context({ checkState: 'FAILURE' }), lanes)).toBe('fix-checks');
    expect(settledAction(context(), lanes)).toBeNull();
  });

  it('ignores inherited status mappings', () => {
    expect(statusAction('toString', {})).toBeNull();
    expect(statusAction('constructor', {})).toBeNull();
  });

  it('preserves the explanation for the settled action', () => {
    // Pass deterministic actions before classification to keep labels and explanations consistent (R24).
    expect(resolveTriage('review-others', { action: 'develop', detail: 'Rich sent it over for review.' }, context())).toEqual({
      action: 'review-others',
      qualifier: 'initial',
      detail: 'Rich sent it over for review.',
    });
  });

  it('takes the model action where nothing settled one', () => {
    expect(resolveTriage(null, { action: 'qa-failure', detail: 'Safari.' }, context())).toMatchObject({
      action: 'qa-failure',
      detail: 'Safari.',
    });
  });

  it('keeps review rounds initial until the developer responds', () => {
    const said = (author: string) => ({ author, authorName: null, authorAssociation: 'MEMBER', body: 'x', createdAt: '2026-01-01T00:00:00Z' });

    expect(qualifierOf('address-review', context())).toBe('initial');
    expect(qualifierOf('address-review', context({ comments: [said('dev-9')] }))).toBe('initial');
    expect(qualifierOf('address-review', context({ comments: [said('DEV-1')] }))).toBe('followup');
    expect(
      qualifierOf('address-review', context({ threads: [{ isResolved: false, isOutdated: false, comments: [said('dev-9'), said('dev-1')] }] })),
    ).toBe('followup');
    // The developer opening a thread is not them replying to one.
    expect(
      qualifierOf('address-review', context({ threads: [{ isResolved: false, isOutdated: false, comments: [said('dev-1')] }] })),
    ).toBe('initial');
  });

  it('calls a review of somebody else work initial until the developer has reviewed it', () => {
    const review = (author: string | null) => ({ author, authorName: null, state: 'COMMENTED', submittedAt: null });
    const said = (author: string) => ({ author, authorName: null, authorAssociation: 'MEMBER', body: 'x', createdAt: '2026-01-01T00:00:00Z' });
    const theirs = { author: 'dev-9' };

    expect(qualifierOf('review-others', context({ ...theirs, reviews: [] }))).toBe('initial');
    // Count developer replies and reviews only; colleague and bot reviews do not establish a prior round.
    expect(qualifierOf('review-others', context({ ...theirs, reviews: [review('dev-9'), review('DEV-9')] }))).toBe('initial');
    expect(qualifierOf('review-others', context({ ...theirs, reviews: [review('some-bot')] }))).toBe('initial');
    expect(qualifierOf('review-others', context({ ...theirs, reviews: [review('dev-2')] }))).toBe('initial');
    expect(qualifierOf('review-others', context({ ...theirs, reviews: [review(null)] }))).toBe('initial');
    // The developer's own round under any of their logins, however GitHub cased the login.
    expect(qualifierOf('review-others', context({ ...theirs, reviews: [review('some-bot'), review('DEV-1')] }))).toBe('followup');
    expect(qualifierOf('review-others', context({ ...theirs, reviews: [review('dev-1-ai')] }, ['dev-1', 'dev-1-ai']))).toBe('followup');
    // A review given as a plain comment rather than a GitHub review, which is how most of them arrive here.
    expect(qualifierOf('review-others', context({ ...theirs, comments: [said('DEV-1')] }))).toBe('followup');
    expect(qualifierOf('review-others', context({ ...theirs, comments: [said('dev-9')] }))).toBe('initial');
    // A pending review is a draft nobody but its writer has seen, and `gh` runs as the developer, so it is fetched.
    expect(
      qualifierOf('review-others', context({ ...theirs, reviews: [{ author: 'dev-1', authorName: null, state: 'PENDING', submittedAt: null }] })),
    ).toBe('initial');
  });

  it('qualifies nothing else', () => {
    expect(qualifierOf('fix-checks', context())).toBeNull();
    expect(qualifierOf('qa-failure', context())).toBeNull();
  });

  /** Match literal labels in both clients, which cannot import the TypeScript implementation at runtime (testing.md). */
  it.each(TRIAGE_LABEL_ROWS)('reads %s/%s as "%s" on every board', (action, qualifier, expected) => {
    expect(triageLabel(action, qualifier)).toBe(expected);
  });

  it('covers every action in that table, so a new one cannot ship unlabelled', () => {
    expect(new Set(TRIAGE_LABEL_ROWS.map(([action]) => action))).toEqual(new Set(TRIAGE_ACTIONS));
  });
});

describe('what a card carries', () => {
  it('shows a card being read as running, and nothing else', () => {
    const [lane] = withTriage(lanesOf(card()), state({ entries: { 'issue:17198': entry() } }), new Set(['issue:17198']), 1_000);

    expect(lane?.cards[0]?.triage).toEqual({ state: 'running' });
  });

  /** Hide stored triage and its action controls after unassignment. */
  it('shows nothing on a card the developer is no longer assigned, however recently it was read', () => {
    const held = state({ entries: { 'issue:17198': entry({ action: 'merge-upstream' }) } });
    const [lane] = withTriage(lanesOf(card({ unassigned: true })), held, NONE, 1_000);

    expect(lane?.cards[0]?.triage).toBeUndefined();
  });

  it('shows what was read, with the qualifier and the sentence', () => {
    const held = state({ entries: { 'issue:17198': entry({ action: 'address-review', qualifier: 'followup', detail: 'Answer the naming notes.' }) } });
    const [lane] = withTriage(lanesOf(card()), held, NONE, 1_000);

    expect(lane?.cards[0]?.triage).toEqual({
      state: 'done',
      action: 'address-review',
      qualifier: 'followup',
      detail: 'Answer the naming notes.',
      at: 1_000,
      stale: false,
    });
  });

  it('says a reading has aged when the card has moved under it', () => {
    const held = state({ entries: { 'issue:17198': entry({ evidence: 'something else entirely' }) } });
    const [lane] = withTriage(lanesOf(card()), held, NONE, 1_000);

    expect(lane?.cards[0]?.triage).toMatchObject({ stale: true });
  });

  const PULL_REQUEST = {
    number: 9,
    url: 'u',
    state: 'OPEN',
    author: 'dev-1',
    isDraft: false,
    reviewDecision: null,
    updatedAt: '2026-09-01T09:00:00Z',
    headOid: 'a1b2c3d',
    checksRed: false,
  };

  it('reads a pull request opening as the card having moved', () => {
    const before = evidenceOf(issue());

    expect(evidenceOf(issue({ pullRequest: PULL_REQUEST }))).not.toBe(before);
    expect(evidenceOf(issue({ updatedAt: '2026-09-02T10:00:00Z' }))).not.toBe(before);
    expect(evidenceOf(issue())).toBe(before);
  });

  /** PR comments, pushes, and check failures need not change issue updatedAt. */
  it.each([
    ['a comment or a review on the pull request', { updatedAt: '2026-09-02T11:00:00Z' }],
    ['a push', { headOid: 'f9e8d7c' }],
    ['a build going red', { checksRed: true }],
  ])('reads %s as the card having moved', (_what, moved) => {
    const before = evidenceOf(issue({ pullRequest: PULL_REQUEST }));

    expect(evidenceOf(issue({ pullRequest: { ...PULL_REQUEST, ...moved } }))).not.toBe(before);
  });

  it('carries nothing on a card that has never been read', () => {
    expect(withTriage(lanesOf(card()), state(), NONE, 1_000)[0]?.cards[0]?.triage).toBeUndefined();
  });

  it('gives a card it could not read somewhere to press, and no words about why', () => {
    // Failed triage retains a retry control; show the failure once above the board (R25).
    const failed = withTriageFailure(state(), 'issue:17198', { kind: 'classify-failed', message: 'no' }, 0);
    const [lane] = withTriage(lanesOf(card()), failed, NONE, 1_000);

    expect(lane?.cards[0]?.triage).toEqual({ state: 'failed', attempts: 1, exhausted: false });
  });

  it('reports exhausted automatic retries', () => {
    let failed = state();

    for (let attempt = 0; attempt < 5; attempt++) {
      failed = withTriageFailure(failed, 'issue:17198', { kind: 'classify-missing', message: 'no' }, 0);
    }

    expect(withTriage(lanesOf(card()), failed, NONE, 1_000)[0]?.cards[0]?.triage).toMatchObject({ exhausted: true });
  });

  it('leaves a reading nothing has contradicted current, however old it is', () => {
    const held = state({ entries: { 'issue:17198': entry({ at: 0, evidence: evidenceOf(issue()) }) } });

    for (const now of [1_000, 13 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000]) {
      expect(withTriage(lanesOf(card()), held, NONE, now)[0]?.cards[0]?.triage).toMatchObject({ stale: false });
    }
  });

  it('leaves every other card alone', () => {
    const two = [card(), card({ key: 'issue:17199', issue: issue({ number: 17199 }), issueNumber: 17199 })];
    const [lane] = withTriage(lanesOf(...two), state({ entries: { 'issue:17198': entry() } }), NONE, 1_000);

    expect(lane?.cards).toHaveLength(2);
    expect(lane?.cards[0]?.triage).toBeDefined();
    expect(lane?.cards[1]?.triage).toBeUndefined();
  });

  it('changes no lane and no placement', () => {
    const before = lanesOf(card());
    const after = withTriage(before, state({ entries: { 'issue:17198': entry() } }), NONE, 1_000);

    expect(after.map((lane) => lane.cards.map((c) => c.key))).toEqual(before.map((lane) => lane.cards.map((c) => c.key)));
    expect(after.map((lane) => lane.id)).toEqual(before.map((lane) => lane.id));
  });
});
