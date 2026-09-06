import { describe, expect, it } from 'vitest';
import type { IssueCard, Lane, TriageAction, TriageContext, TriageEntry, TriageQualifier, TriageState } from '@ground-control/core';
import { assignLanes } from '../src/lanes.js';
import type { BoardCard } from '../src/types.js';
import {
  CLASSIFIED_ACTIONS,
  DERIVED_ACTIONS,
  MODEL_MAY_NOT_SAY,
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
  ['begin-work', null, 'Begin work'],
  ['answer-design-question', null, 'Answer design question'],
  ['uat-question', null, 'UAT question'],
  ['uat-failure', null, 'UAT failure'],
  ['review-others', 'initial', 'Review their PR · initial'],
  ['review-others', 'followup', 'Review their PR · followup'],
  ['address-review', 'initial', 'Answer review · initial'],
  ['address-review', 'followup', 'Answer review · followup'],
  ['fix-checks', null, 'Fix failing checks'],
  ['merge-upstream', null, 'Merge upstream'],
  ['resolve-conflicts', null, 'Resolve conflicts'],
  ['land', null, 'Land it'],
  ['other', null, 'Other'],
];

const RULES = { boardStatuses: ['⚒️ Dev'], statusLanes: {}, logins: ['dev-1'] };
const MEMORY = { placements: {}, seenPastMyHands: [], statuses: ['⚒️ Dev'] };

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
    action: 'begin-work',
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
    // The regression this whole design turns on. An archived card stays in every snapshot — the source query does
    // not filter on status — so a rule that dropped its entry and read absence as due would spawn a classifier for
    // every archived card on every broadcast, for as long as the hub ran.
    const gone = lanesOf(card({ issue: issue({ status: '🚀 Released' }) }));

    expect(gone.find((lane) => lane.id === 'archived')?.cards).toHaveLength(1);

    let held = state({ entries: { 'issue:17198': entry() } });

    for (let pass = 0; pass < 20; pass++) {
      expect(dueForTriage(gone, held, NONE, pass * 1_000)).toEqual([]);
      held = nextTriageState(gone, held, true);
    }

    expect(held.entries['issue:17198']?.wasArchived).toBe(true);
  });

  it('reads a card that went past the developer and came back, exactly once', () => {
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
    const foreign = card({ key: 'issue:99', issue: null, issueNumber: 99 });

    expect(dueForTriage(lanesOf(adhoc, foreign), state(), NONE, 0)).toEqual([]);
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

  it('gives up after four attempts rather than spawning forever against a broken CLI', () => {
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

    expect(next.entries['issue:17198']).toMatchObject({ action: 'begin-work', wasArchived: true });
  });

  it('prunes a card that left the board on a clean read, and keeps it on a failed one', () => {
    const held = state({ entries: { 'issue:17198': entry() } });

    expect(nextTriageState([], held, true).entries).toEqual({});
    expect(nextTriageState([], held, false).entries).toHaveProperty('issue:17198');
  });

  it('gives a card that went past the developer a clean slate, attempts included', () => {
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
        'issue:1': { revision: TRIAGE_REVISION, action: 'land', qualifier: null, detail: 'go', at: 1, agent: 'claude', wasArchived: false, evidence: 'e' },
        'issue:2': { revision: TRIAGE_REVISION, action: 'a-thing-no-build-has', detail: 'go', at: 1, agent: 'claude' },
      },
      failures: { 'issue:3': { kind: 'k', message: 'm', attempts: 1, nextAt: 5 }, 'issue:4': { kind: 'k' } },
    };

    const read = readTriageState(stored);

    expect(Object.keys(read.entries)).toEqual(['issue:1']);
    expect(Object.keys(read.failures)).toEqual(['issue:3']);
  });

  it('defaults the fields that carry a sensible absence, within one revision', () => {
    const read = readTriageState({
      entries: { 'issue:1': { revision: TRIAGE_REVISION, action: 'land', detail: 'go', at: 1, agent: 'claude' } },
    });

    expect(read.entries['issue:1']).toMatchObject({ qualifier: null, wasArchived: false, evidence: '' });
  });

  it('drops an entry read under an older revision, which is what re-reads those cards', () => {
    // The file outlives the build that wrote it, and a card is read once — so without this the board goes on showing
    // sentences a fixed classifier would no longer write. Dropping the entry is what makes its card due again.
    const older = { action: 'begin-work', detail: 'Pick it up.', at: 1, agent: 'claude' };
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
        'issue:2': { revision: TRIAGE_REVISION, action: 'begin-work', detail: 'Pick it up.', at: 1, agent: 'claude' },
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
    expect(readTriageResult({ action: 'uat-failure', detail: 'Safari.' }, null)).toEqual({ action: 'uat-failure', detail: 'Safari.' });
  });

  it('refuses an action no build has, rather than reading it as other', () => {
    expect(readTriageResult({ action: 'ship-it', detail: 'go' }, null)).toBeNull();
    expect(readTriageResult({ action: 'other' }, null)).toBeNull();
    expect(readTriageResult({ detail: 'go' }, null)).toBeNull();
    expect(readTriageResult({ action: 'other', detail: '' }, null)).toBeNull();
    expect(readTriageResult('other', null)).toBeNull();
  });

  it('refuses only the one action the hub alone may say', () => {
    // The model may report a problem somebody named — the commonest comment on a pull request is that its auto-merge
    // failed, and `mergeable` reads UNKNOWN in the window a card arrives. Only "everything is fine" is a fact.
    expect(readTriageResult({ action: 'land', detail: 'go' }, null)).toBeNull();
    expect(offered()).not.toContain('land');

    for (const action of ['resolve-conflicts', 'merge-upstream', 'fix-checks'] as const) {
      expect(readTriageResult({ action, detail: 'go' }, null)).toEqual({ action, detail: 'go' });
      expect(offered()).toContain(action);
    }
  });

  it('cuts an over-long sentence at a word rather than discarding a good classification', () => {
    const long = `${'word '.repeat(60)}end`;
    const result = readTriageResult({ action: 'other', detail: long }, null);

    expect(result?.detail.length).toBeLessThanOrEqual(160);
    expect(result?.detail.endsWith('…')).toBe(true);
    expect(result?.detail).not.toContain('wor…');
  });

  it('offers the model every action but the one only the hub may say, and labels all twelve', () => {
    expect(offered()).toEqual([...CLASSIFIED_ACTIONS]);
    expect([...CLASSIFIED_ACTIONS, ...MODEL_MAY_NOT_SAY].sort()).toEqual([...TRIAGE_ACTIONS].sort());
    expect(Object.keys(TRIAGE_LABELS).sort()).toEqual([...TRIAGE_ACTIONS].sort());
    // Still the hub's to decide wherever GitHub has computed one, whatever the model was allowed to answer.
    expect(DERIVED_ACTIONS).toEqual(['fix-checks', 'merge-upstream', 'resolve-conflicts', 'land']);
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
        reviewDecision: null,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        checkState: 'SUCCESS',
        comments: [],
        reviews: [],
        reviewRequests: [],
        threads: [],
        ...over,
      },
    };
  }

  it('reads each fact as its own action', () => {
    expect(derivedAction(context({ mergeable: 'CONFLICTING' }))).toBe('resolve-conflicts');
    expect(derivedAction(context({ checkState: 'FAILURE' }))).toBe('fix-checks');
    expect(derivedAction(context({ checkState: 'ERROR' }))).toBe('fix-checks');
    expect(derivedAction(context({ mergeStateStatus: 'BEHIND' }))).toBe('merge-upstream');
    expect(derivedAction(context({ mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' }))).toBe('land');
  });

  it('puts a branch that will not merge ahead of one whose checks are red', () => {
    expect(derivedAction(context({ mergeable: 'CONFLICTING', checkState: 'FAILURE' }))).toBe('resolve-conflicts');
    expect(derivedAction(context({ checkState: 'FAILURE', mergeStateStatus: 'BEHIND' }))).toBe('fix-checks');
  });

  it('reads UNKNOWN as not computed rather than as fine, in either direction', () => {
    expect(derivedAction(context({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }))).toBeNull();
    expect(derivedAction(context({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', reviewDecision: 'APPROVED' }))).toBeNull();
  });

  it('reads a null check rollup as a repository with no checks, not as checks that failed', () => {
    expect(derivedAction(context({ checkState: null }))).toBeNull();
  });

  it('says nothing about a draft, a colleague pull request, or one already landed', () => {
    expect(derivedAction(context({ isDraft: true, checkState: 'FAILURE' }))).toBeNull();
    expect(derivedAction(context({ author: 'dev-9', mergeable: 'CONFLICTING' }))).toBeNull();
    expect(derivedAction(context({ state: 'MERGED', mergeable: 'CONFLICTING' }))).toBeNull();
    expect(derivedAction(context({ state: 'CLOSED', mergeable: 'CONFLICTING' }))).toBeNull();
  });

  it('says nothing at all about a card with no pull request', () => {
    expect(derivedAction({ ...context(), pullRequest: null })).toBeNull();
  });

  it('reads the action off the status, whatever the pull request says about itself', () => {
    // The issue is where the team says what a card needs; the pull request is an artefact of doing it. A colleague's
    // pull request moved to review is a card to review even where the branch beneath it will not merge.
    const lanes = { '🎁 Assigned': 'unstarted', '🔍 Dev Review': 'review' } as const;

    expect(statusAction('🔍 Dev Review', lanes)).toBe('review-others');
    expect(statusAction('🎁 Assigned', lanes)).toBe('begin-work');
    expect(settledAction({ ...context({ author: 'dev-9', mergeable: 'CONFLICTING' }), status: '🔍 Dev Review' }, lanes)).toBe('review-others');
    expect(settledAction({ ...context({ checkState: 'FAILURE' }), status: '🎁 Assigned' }, lanes)).toBe('begin-work');
  });

  it('never calls the developer own open pull request theirs to review, whatever the status says', () => {
    // The one thing a status cannot say is whose review it is. Without this a card under a review status reads
    // "Review their PR" about the developer's own branch, which is the guess R24 refuses.
    const lanes = { '🔍 Dev Review': 'review' } as const;
    const own = (over = {}) => ({ ...context(over), status: '🔍 Dev Review' });

    expect(settledAction(own({ mergeable: 'CONFLICTING' }), lanes)).toBe('resolve-conflicts');
    // And Land it stays reachable: it is read off the pull request alone, so a review status must not swallow it.
    expect(settledAction(own({ mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' }), lanes)).toBe('land');
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
    expect(settledAction(context({ mergeable: 'CONFLICTING' }), lanes)).toBe('resolve-conflicts');
    expect(settledAction(context(), lanes)).toBeNull();
  });

  it('reads a status named after something on Object, rather than calling a lane out of the prototype', () => {
    expect(statusAction('toString', {})).toBeNull();
    expect(statusAction('constructor', {})).toBeNull();
  });

  it('keeps the model sentence, because it was written knowing the action', () => {
    // Nothing is overruled after the fact any more: the action is settled before the ask and the model is told it,
    // so a card can no longer carry a label and a sentence describing different states (R24).
    expect(resolveTriage('review-others', { action: 'begin-work', detail: 'Rich sent it over for review.' }, context())).toEqual({
      action: 'review-others',
      qualifier: 'initial',
      detail: 'Rich sent it over for review.',
    });
  });

  it('takes the model action where nothing settled one', () => {
    expect(resolveTriage(null, { action: 'uat-failure', detail: 'Safari.' }, context())).toMatchObject({
      action: 'uat-failure',
      detail: 'Safari.',
    });
  });

  it('calls a review round initial until the developer has spoken on it', () => {
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

  it('calls a review of somebody else work initial until somebody other than its author has reviewed it', () => {
    const review = (author: string | null) => ({ author, authorName: null, state: 'COMMENTED', submittedAt: null });
    const said = (author: string) => ({ author, authorName: null, authorAssociation: 'MEMBER', body: 'x', createdAt: '2026-01-01T00:00:00Z' });
    const theirs = { author: 'dev-9' };

    expect(qualifierOf('review-others', context({ ...theirs, reviews: [] }))).toBe('initial');
    // GitHub records the author's own inline replies as reviews, so counting those makes every answered pull
    // request read as a second round.
    expect(qualifierOf('review-others', context({ ...theirs, reviews: [review('dev-9'), review('DEV-9')] }))).toBe('initial');
    // A re-review is a re-review whoever gave the first one: on this board the first is routinely an agent account
    // that is none of the developer's own logins, which is what made a round two read as a round one.
    expect(qualifierOf('review-others', context({ ...theirs, reviews: [review('some-bot')] }))).toBe('followup');
    expect(qualifierOf('review-others', context({ ...theirs, reviews: [review('dev-1')] }))).toBe('followup');
    expect(qualifierOf('review-others', context({ ...theirs, reviews: [review(null)] }))).toBe('initial');
    // A review given as a plain comment rather than a GitHub review, which is how most of them arrive here.
    expect(qualifierOf('review-others', context({ ...theirs, comments: [said('DEV-1')] }))).toBe('followup');
    expect(qualifierOf('review-others', context({ ...theirs, comments: [said('dev-9')] }))).toBe('initial');
    // A pending review is a draft nobody but its writer has seen, and `gh` runs as the developer, so it is fetched.
    expect(
      qualifierOf('review-others', context({ ...theirs, reviews: [{ author: 'dev-1', authorName: null, state: 'PENDING', submittedAt: null }] })),
    ).toBe('initial');
    // An author GitHub could not resolve must not turn the exclusion off and count their own inline replies.
    expect(qualifierOf('review-others', context({ author: null, reviews: [review('dev-9')] }))).toBe('initial');
  });

  it('qualifies nothing else', () => {
    expect(qualifierOf('land', context())).toBeNull();
    expect(qualifierOf('uat-failure', context())).toBeNull();
  });

  /**
   * The parity table. Neither board can import this at runtime — one is a classic script, the other is plain
   * JavaScript Chrome loads as it stands — so the same literals are asserted in each client's suite. A copy that
   * drifts labels a card one way in the editor and another in the browser (`docs/testing.md`).
   */
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

  it('reads a pull request opening as the card having moved', () => {
    const before = evidenceOf(issue());
    const after = evidenceOf(
      issue({ pullRequest: { number: 9, url: 'u', state: 'OPEN', author: 'dev-1', isDraft: false, reviewDecision: null } }),
    );

    expect(after).not.toBe(before);
    expect(evidenceOf(issue({ updatedAt: '2026-09-02T10:00:00Z' }))).not.toBe(before);
    expect(evidenceOf(issue())).toBe(before);
  });

  it('carries nothing on a card that has never been read', () => {
    expect(withTriage(lanesOf(card()), state(), NONE, 1_000)[0]?.cards[0]?.triage).toBeUndefined();
  });

  it('gives a card it could not read somewhere to press, and no words about why', () => {
    // Without this the cards that most need reading again are the only ones with nothing to click, and the failure's
    // own remedy names a control that does not exist. What went wrong is one line above the lanes (R25).
    const failed = withTriageFailure(state(), 'issue:17198', { kind: 'classify-failed', message: 'no' }, 0);
    const [lane] = withTriage(lanesOf(card()), failed, NONE, 1_000);

    expect(lane?.cards[0]?.triage).toEqual({ state: 'failed', attempts: 1, exhausted: false });
  });

  it('says when it has stopped trying on its own, so the developer knows a click is the only way back', () => {
    let failed = state();

    for (let attempt = 0; attempt < 5; attempt++) {
      failed = withTriageFailure(failed, 'issue:17198', { kind: 'classify-missing', message: 'no' }, 0);
    }

    expect(withTriage(lanesOf(card()), failed, NONE, 1_000)[0]?.cards[0]?.triage).toMatchObject({ exhausted: true });
  });

  it('draws a reading that has simply aged as stale, whatever the card still says', () => {
    const held = state({ entries: { 'issue:17198': entry({ at: 0 }) } });

    expect(withTriage(lanesOf(card()), held, NONE, 1_000)[0]?.cards[0]?.triage).toMatchObject({ stale: false });
    expect(withTriage(lanesOf(card()), held, NONE, 13 * 60 * 60 * 1000)[0]?.cards[0]?.triage).toMatchObject({ stale: true });
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
