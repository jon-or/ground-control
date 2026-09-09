import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { DEFAULT_SESSION_SCOPE } from '@ground-control/core';
import type {
  AgentAdapter,
  ContextReading,
  DispatchInput,
  DispatchResult,
  HistoricalSession,
  HubConfig,
  IssueCard,
  ReadFailure,
  Session,
  Snapshot,
  SourceReading,
  TriageAction,
  TriageContext,
  TriagePullRequest,
  WorkSource,
} from '@ground-control/core';
import { Hub } from '../src/hub.js';
import { makeLaneStore } from '../src/lanes.js';
import { makeMarkStore } from '../src/marks.js';
import { makeTriageStore } from '../src/triageStore.js';
import { makeCheckoutStore } from '../src/checkoutStore.js';
import { makeActionStore } from '../src/actionStore.js';
import { makeIssueStore } from '../src/issueStore.js';
import { makeStatusStore } from '../src/statusStore.js';
import { actionReportPathOf } from '../src/paths.js';
import { captureLog, fakeClock, fakeSession, reportingAgent, tempHome } from './helpers.js';

let home: string;
let dispose: () => void;
/** Use a readable directory for checkout validation and dispatch. */
let CHECKOUT: string;

beforeEach(() => {
  ({ home, dispose } = tempHome());
  CHECKOUT = join(home, '17198-channel-mapping');
  mkdirSync(CHECKOUT, { recursive: true });
});

afterEach(() => dispose());

/** A step past the 30-minute read gate, for the tests that are about a card becoming due again. */
const PAST_GATE = 2_000_000;

function issue(over: Partial<IssueCard> = {}): IssueCard {
  return {
    number: 17198,
    title: 'Channel mapping drops rows past the first page',
    type: 'Bug',
    typeColor: 'RED',
    url: 'https://github.com/example-org/example-repo/issues/17198',
    status: '⚒️ Dev',
    statusColor: 'BLUE',
    statusChangedAt: '2026-09-01T09:00:00Z',
    assignees: ['dev-1'],
    avatar: null,
    pullRequest: {
      number: 4021,
      url: 'https://github.com/example-org/example-repo/pull/4021',
      state: 'OPEN',
      author: 'dev-1',
      isDraft: false,
      reviewDecision: null,
      updatedAt: null,
      headOid: null,
      checksRed: null,
    },
    updatedAt: '2026-09-01T10:00:00Z',
    ...over,
  };
}

function pullRequest(over: Partial<TriagePullRequest> = {}): TriagePullRequest {
  return {
    number: 4021,
    title: 'Fix paging',
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
  };
}

interface Control {
  hub: Hub;
  clock: ReturnType<typeof fakeClock>;
  agent: ReturnType<typeof reportingAgent>;
  cards: IssueCard[];
  /** Saved sessions provide checkouts when no session is running. */
  history: HistoricalSession[];
  /** What the fresh read answers. A test changes this to move the card under the runner. */
  pr: Partial<TriagePullRequest> | null;
  /** Classifier result requesting a merge (R39). */
  classified: { action: TriageAction; detail: string };
  /** Every context read the runner made, so a gate that should have stopped one is visible. */
  reads: number[];
  /** Set to make the source seam throw rather than answer. Both seams are public and either may. */
  readThrows: boolean;
  contextHolding: Promise<void> | null;
  permissions: string[];
  /** Set to make every store write fail, which is the one condition that would leave the runner with no ceilings. */
  storeBroken: boolean;
  /** Set to make `claude stop` refuse, so a card cannot claim a stop the board did not achieve. */
  stopFails: boolean;
  dispatched: DispatchInput[];
  dispatch: DispatchResult;
  stopped: string[];
  notices: string[];
  snapshot(): Snapshot;
  settle(): Promise<void>;
  pass(advance?: number): Promise<void>;
  /** The dispatched session showing up on the roster under the short id the CLI printed. */
  appear(): Promise<void>;
  /** That session ending, which is what makes the board go and find out what came of it. */
  finish(): Promise<void>;
  /** What the run wrote about itself, at the path the prompt was handed. */
  report(body: unknown): void;
  cardAction(): Snapshot['lanes'][number]['cards'][number]['action'];
  key(): string;
  cardCheckout(): Snapshot['lanes'][number]['cards'][number]['checkout'];
}

/** Live session and checkout used for dispatched-run tests. */
function sessionOn(over: Partial<Session> = {}): Session {
  return fakeSession({ sessionId: 'a1b2c3d4-0000-4000-8000-000000000000', cwd: CHECKOUT, issueNumber: 17198, ...over });
}

/** Set sessions before constructing the hub because configuration immediately triggers the first roster read. */
function harness(
  over: Partial<HubConfig['actions']> = {},
  cards: IssueCard[] = [issue()],
  sessions: Session[] = [],
  rosterFailure: ReadFailure | null = null,
): Control {
  const clock = fakeClock();
  const agent = reportingAgent('claude');
  agent.sessions = sessions;
  agent.failure = rosterFailure;

  const control: Control = {
    hub: undefined as unknown as Hub,
    clock,
    agent,
    cards,
    history: [
      {
        agent: 'claude',
        sessionId: 'old00000-0000-4000-8000-000000000001',
        title: 'Fix the paging',
        cwd: CHECKOUT,
        branch: '17198-channel-mapping',
        issueNumber: 17198,
        repository: 'github.com/example-org/example-repo',
        updatedAt: 1_788_000_000_000,
      },
    ],
    pr: {},
    classified: { action: 'merge-upstream', detail: 'Behind master.' },
    reads: [],
    readThrows: false,
    contextHolding: null,
    permissions: ['manual', 'acceptEdits', 'auto', 'dontAsk', 'plan', 'bypassPermissions'],
    storeBroken: false,
    stopFails: false,
    dispatched: [],
    dispatch: { shortId: '46af2ac8' },
    stopped: [],
    notices: [],
    snapshot: () => control.hub.snapshot(),
    settle: async () => {
      for (let i = 0; i < 12; i++) {
        await Promise.resolve();
      }
    },
    // Advance beyond source throttling but within the action retry interval; use PAST_GATE to expire it. Complete pending reads first so refresh observes the updated fixture.
    pass: async (advance = 400_000) => {
      await control.settle();
      control.clock.advance(advance);
      await control.hub.refresh('asked');
      await control.settle();
    },
    appear: async () => {
      control.agent.sessions = [sessionOn({ sessionId: '46af2ac8-f232-4406-8e8f-2579df5eb08f' })];
      await control.pass();
    },
    finish: async () => {
      control.agent.sessions = [];
      await control.pass();
    },
    report: (body: unknown) => {
      const path = actionReportPathOf(home, control.key());
      mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
      writeFileSync(path, JSON.stringify(body));
    },
    cardAction: () => control.snapshot().lanes.flatMap((lane) => lane.cards)[0]?.action,
    key: () => control.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key,
    cardCheckout: () => control.snapshot().lanes.flatMap((lane) => lane.cards)[0]?.checkout,
  };

  const source: WorkSource = {
    id: 'github',
    displayName: 'GitHub',
    configure: () => null,
    read: async (): Promise<SourceReading> => ({
      items: {
        cards: control.cards,
        owners: ['dev-1'],
        matched: control.cards.length,
        totalAssigned: control.cards.length,
        notOnProject: 0,
        truncated: false,
        fetchedAt: '2026-09-03T12:00:00Z',
      },
      failure: null,
      needs: null,
    }),
    readContext: async (card): Promise<ContextReading> => {
      control.reads.push(card.number);
      if (control.contextHolding) await control.contextHolding;

      // Throw only on action context reads; triage must succeed to make the card eligible.
      if (control.readThrows && control.reads.length > 1) {
        throw new Error('the seam threw rather than answering');
      }

      const context: TriageContext = {
        issueNumber: card.number,
        title: card.title,
        body: '',
        status: card.status,
        stateEvents: [],
        comments: [],
        pullRequest: control.pr === null ? null : pullRequest(control.pr),
        logins: ['dev-1'],
        repository: 'example-org/example-repo',
        defaultBranch: 'master',
      };

      return { context, failure: null };
    },
  };

  const dispatching: AgentAdapter = {
    ...agent.adapter,
    // The reading is what asks for a merge, so it is the harness knob for a card the board may act on at all.
    classify: async () => ({ value: control.classified }),
    // Saved session metadata supplies the checkout without the active session that would block dispatch.
    listHistory: async () => ({ sessions: control.history, failure: null }),
    dispatch: async (input: DispatchInput): Promise<DispatchResult> => {
      control.dispatched.push(input);

      return control.dispatch;
    },
    dispatchPermissions: control.permissions,
    stopDispatch: async (_path: string, shortId: string): Promise<ReadFailure | null> => {
      control.stopped.push(shortId);

      return control.stopFails
        ? { subject: 'claude', kind: 'stop-failed', message: `no job matching ${shortId}`, remedy: 'r' }
        : null;
    },
  };

  const logging = captureLog();
  const store = makeActionStore(home);

  control.hub = new Hub({
    clock: clock.clock,
    watch: () => ({ dispose: () => undefined }),
    home,
    registries: { agents: [dispatching], hosts: [], sources: [source] },
    lanes: makeLaneStore(home),
    marks: makeMarkStore(home),
    triage: makeTriageStore(home),
    checkouts: makeCheckoutStore(home),
    // Reads still work; only the write fails, which is the shape a locked or full disk actually takes.
    actions: { read: () => store.read(), write: (state) => (control.storeBroken ? false : store.write(state)) },
    issues: makeIssueStore(home),
    status: makeStatusStore(home),
    settings: { read: () => null, write: () => undefined },
    log: logging.log,
    syncActivity: (_r, wanted) => ({ wanted, plan: 'up-to-date', added: 0, failure: null }),
  });

  control.hub.configure(config(over));

  return control;
}

function config(actions: Partial<HubConfig['actions']> = {}): HubConfig {
  return {
    agents: [{ id: 'claude', path: 'claude-cli' }],
    branchIssuePattern: '^(\\d+)-',
    hosts: {},
    logLevel: 'info',
    sources: { github: { repo: 'example-org/example-repo', logins: ['dev-1'] } },
    boardStatuses: ['⚒️ Dev'],
    statusLanes: {},
    refreshIntervalMs: 300_000,
    sessionIntervalMs: 30_000,
    newSession: { prompt: '' },
    installActivity: false,
    triage: { enabled: true, concurrency: 2, timeoutMs: 60_000, names: {} },
    actions: {
      permissionMode: 'manual',
      concurrency: 1,
      dailyLimit: 10,
      // Keep the registration timeout beyond normal test clock advances; timeout tests override it.
      resultTimeoutMs: 14_400_000,
      actions: { 'merge-upstream': { enabled: true, prompt: '/or-merge {base} {branch} {issue} --single' } },
      ...actions,
    },
  };
}

function watch(control: Control, watching = true): void {
  control.hub.connect({ id: 'board-1', hostId: null, workspaceRoot: null, residentRoutes: [], watching }, (message) => {
    if (message.type === 'notice') {
      control.notices.push(message.message);
    }
  });
}

describe('dispatching a card action', () => {
  /** An active session prevents unattended dispatch into the same checkout. */
  it('dispatches the configured prompt, checkout, and permission mode', async () => {
    const control = harness({}, [issue()], [sessionOn()]);
    watch(control);
    await control.pass();

    expect(control.dispatched).toHaveLength(0);

    // Take the running session away and the card is the board's to act on.
    control.agent.sessions = [];
    await control.pass();

    expect(control.dispatched).toHaveLength(1);
    expect(control.dispatched[0]).toMatchObject({
      path: 'claude-cli',
      prompt: '/or-merge master 17198-channel-mapping 17198 --single',
      cwd: CHECKOUT,
      permissionMode: 'manual',
    });
  });

  it('does not dispatch disabled actions', async () => {
    const control = harness({ actions: { 'merge-upstream': { enabled: false, prompt: '/or-merge' } } });
    watch(control);
    await control.pass();

    expect(control.dispatched).toEqual([]);
    // Only triage reads context; disabled actions make no additional request.
    expect(control.reads).toEqual([17198]);
  });

  it('does not dispatch automatic actions while unwatched', async () => {
    const control = harness();
    watch(control, false);
    await control.pass();

    expect(control.dispatched).toEqual([]);
  });

  /** Source reads can finish before the initial roster read. Do not treat that initial empty roster as proof of inactivity. */
  it('does not dispatch after roster read failure', async () => {
    const control = harness({}, [issue()], [], {
      subject: 'claude',
      kind: 'agent-missing',
      message: 'no claude',
      remedy: 'r',
    });
    watch(control);
    await control.pass();

    expect(control.dispatched).toEqual([]);

    control.agent.failure = null;
    await control.pass();

    expect(control.dispatched).toHaveLength(1);
  });

  /** The action store enforces concurrency, retries, and daily limits. Persistence failure must disable dispatch to prevent unrecorded repeat runs. */
  it('disables dispatch and reports persistence failure', async () => {
    const control = harness();
    control.storeBroken = true;
    watch(control);
    await control.pass();

    expect(control.dispatched).toEqual([]);
    expect(control.snapshot().failures.map((failure) => failure.kind)).toContain('action-stalled');

    // Every later pass, whatever the clock does. A loop is what this is here to make impossible.
    await control.pass(PAST_GATE);
    await control.pass(PAST_GATE);

    expect(control.dispatched).toEqual([]);

    // Persistence failure also blocks manual requests and reports its cause.
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    expect(control.dispatched).toEqual([]);
    expect(control.notices.some((notice) => notice.includes('Could not save action state'))).toBe(true);
  });

  /** The same breaker, tripped by a file that goes unwritable after a run has already been started. */
  it('disables dispatch after a persistence failure during a run', async () => {
    const control = harness();
    watch(control);
    await control.pass();

    expect(control.dispatched).toHaveLength(1);

    control.storeBroken = true;
    await control.pass(PAST_GATE);
    await control.pass(PAST_GATE);

    expect(control.dispatched).toHaveLength(1);
    expect(control.snapshot().failures.map((failure) => failure.kind)).toContain('action-stalled');
  });

  /** Turning an action on is the consent; the first run that actually starts is the moment worth naming (R32). */
  it('announces the first successful dispatch', async () => {
    const control = harness({}, [issue({ number: 17198 }), issue({ number: 17199 })]);
    watch(control);
    await control.pass();

    const said = control.notices.filter((notice) => notice.includes('Started merge-upstream for'));

    expect(said).toHaveLength(1);
    expect(said[0]).toContain('may edit and push');
    expect(said[0]).toContain('groundControl.actions');

    await control.pass(PAST_GATE);

    expect(control.notices.filter((notice) => notice.includes('Started merge-upstream for'))).toHaveLength(1);
  });

  /** Failed dispatches must not consume the first-run notice. */
  it('does not announce failed dispatches', async () => {
    const control = harness();
    control.dispatch = {
      failure: { subject: 'claude', kind: 'dispatch-missing', message: 'Claude Code was not found.', remedy: 'r' },
    };
    watch(control);
    await control.pass();

    expect(control.notices.filter((notice) => notice.includes('Started merge-upstream for'))).toEqual([]);
  });

  /** The one rule that keeps a merge that halted from being started over on every pass. */
  it('never dispatches twice against the same state of the card', async () => {
    const control = harness();
    watch(control);
    await control.pass();
    await control.appear();
    await control.finish();

    expect(control.dispatched).toHaveLength(1);
    expect(control.cardAction()).toMatchObject({ state: 'done' });

    // Expire the retry interval and verify a fresh context read before checking evidence-based refusal.
    const before = control.reads.length;
    await control.pass(PAST_GATE);

    expect(control.reads.length).toBeGreaterThan(before);
    expect(control.dispatched).toHaveLength(1);

    // And once the branch moves under it, the same card is dispatched for again.
    control.pr = { headOid: 'ffffffffffffffffffffffffffffffffffffffff' };
    await control.pass(PAST_GATE);

    expect(control.dispatched).toHaveLength(2);
  });

  /** A successful merge changes its own head commit. Completed runs must block automatic repeats even after that change. */
  it('never dispatches again once a run landed, however far the branch has moved since', async () => {
    const control = harness();
    watch(control);
    await control.pass();
    await control.appear();
    control.report({ outcome: 'pushed', detail: 'Merged master.' });
    await control.finish();

    expect(control.dispatched).toHaveLength(1);
    expect(control.cardAction()).toMatchObject({ outcome: 'landed' });

    // Simulate the merge push, then advance through two retry intervals.
    control.pr = { headOid: 'ffffffffffffffffffffffffffffffffffffffff' };
    await control.pass(PAST_GATE);
    control.pr = { headOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    await control.pass(PAST_GATE);

    expect(control.dispatched).toHaveLength(1);

    // Manual requests permit retry.
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    expect(control.dispatched).toHaveLength(2);
  });

  /** Enabled actions require fresh GitHub context, but repeated hub updates must respect the retry interval. */
  it('waits for the retry interval before rereading', async () => {
    const control = harness();
    control.pr = { baseRefName: '17000-parent-feature' };
    watch(control);
    await control.pass();

    // Triage read it once, and the runner read it once more before refusing.
    expect(control.reads).toEqual([17198, 17198]);

    await control.pass();

    expect(control.reads).toEqual([17198, 17198]);

    await control.pass(PAST_GATE);

    expect(control.reads).toEqual([17198, 17198, 17198]);
  });

  it('enforces the daily dispatch limit', async () => {
    const control = harness({ dailyLimit: 0 });
    watch(control);
    await control.pass();

    expect(control.dispatched).toEqual([]);
  });
});

describe('what the board refuses to act on', () => {
  it('reports refusal for PRs targeting non-default branches', async () => {
    const control = harness();
    control.pr = { baseRefName: '17000-parent-feature' };
    watch(control);
    await control.pass();

    expect(control.dispatched).toEqual([]);
    expect(control.cardAction()).toMatchObject({
      state: 'refused',
      reason: '#4021 targets 17000-parent-feature. Merge-upstream requires the default branch, master.',
    });
  });

  /** Never guessed from a branch name — the rule R37's changes fold already holds the board to. */
  /** Require a requested merge on the server; a client can submit arbitrary card keys (R39). */
  it('refuses a card whose reading is not asking for a merge', async () => {
    const control = harness();
    control.classified = { action: 'fix-checks', detail: 'The build is red.' };
    watch(control);
    await control.pass();

    expect(control.dispatched).toEqual([]);
    expect(control.cardAction()).toBeUndefined();

    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    expect(control.dispatched).toEqual([]);
    expect(control.notices).toContain('This card has no merge-upstream action.');
  });

  it('refuses a card with no checkout, without spending a read to find that out', async () => {
    const control = harness();
    control.history = [];
    watch(control);
    await control.pass();

    expect(control.dispatched).toEqual([]);
    // Only triage reads context; action validation makes no request.
    expect(control.reads).toEqual([17198]);
    expect(control.cardAction()).toEqual({
      state: 'refused',
      action: 'merge-upstream',
      reason: 'No checkout from a previous session is available for this card.',
    });
  });

  /** Manual checkout selection permits opening and manual starts (R41, R42). Unattended actions require a checkout from session history (R39). */
  it('refuses a card whose only checkout is a folder the developer picked, never having run there', async () => {
    const control = harness();
    control.history = [];
    watch(control);
    await control.pass();

    // Create a checkout matching the card repository after its key is available, for setCheckout and checkoutFor validation.
    const picked = join(home, 'picked-by-hand');
    mkdirSync(join(picked, '.git'), { recursive: true });
    writeFileSync(join(picked, '.git', 'config'), '[remote "origin"]\n url = https://github.com/example-org/example-repo.git');
    makeCheckoutStore(home).write(control.key(), picked.replace(/\\/g, '/'));

    control.dispatched.length = 0;
    await control.pass();

    // Named, so this cannot pass by the pick never having reached the card at all.
    expect(control.cardCheckout()).toEqual({ root: picked.replace(/\\/g, '/'), source: 'remembered', only: true });

    expect(control.dispatched).toEqual([]);
    expect(control.cardAction()).toEqual({
      state: 'refused',
      action: 'merge-upstream',
      reason: 'No checkout from a previous session is available for this card.',
    });
  });

  it('disables actions without configured prompts', async () => {
    const control = harness({ actions: {} });
    watch(control);
    await control.pass();

    expect(control.cardAction()).toMatchObject({
      state: 'refused',
      action: 'merge-upstream',
      reason: 'No prompt is set for merge-upstream. Set its prompt in groundControl.actions.',
    });
  });
});

describe('following a run to its end', () => {
  it('shows running state until the session ends', async () => {
    const control = harness();
    watch(control);
    await control.pass();

    expect(control.cardAction()).toMatchObject({ state: 'running', action: 'merge-upstream' });

    // The dispatched session appears on the roster under the short id the CLI printed (`mechanics.md` M33).
    await control.appear();

    expect(control.cardAction()).toMatchObject({ state: 'running' });

    control.report({ outcome: 'pushed', detail: 'Merged master, tests green.' });
    await control.finish();

    expect(control.cardAction()).toMatchObject({
      state: 'done',
      outcome: 'landed',
      detail: 'Merged master, tests green.',
    });
  });

  /** Finished background sessions remain listed (M33). Outcome detection must use finished state, not presence alone. */
  it('settles a run whose session is still listed once the agent calls it finished', async () => {
    const control = harness();
    watch(control);
    await control.pass();
    await control.appear();

    control.report({ outcome: 'pushed', detail: 'Merged master, tests green.' });
    control.agent.sessions = [sessionOn({ sessionId: '46af2ac8-f232-4406-8e8f-2579df5eb08f', finished: true })];
    await control.pass();

    expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'landed' });
  });

  /** Use the session report to resolve the run; later repository changes do not establish its outcome. */
  it('settles from what the run wrote, without reading the pull request again', async () => {
    const control = harness();
    watch(control);
    await control.pass();
    await control.appear();

    const before = control.reads.length;
    control.report({ outcome: 'halted', detail: 'Low-confidence conflicts in Booking.cs.' });
    await control.finish();

    expect(control.cardAction()).toMatchObject({
      state: 'done',
      outcome: 'halted',
      detail: 'Low-confidence conflicts in Booking.cs.',
    });
    // Exclude independent triage reads when counting outcome checks.
    expect(control.reads.length).toBe(before);
  });

  /** Clear the previous report so a silent retry cannot reuse an earlier pushed result. */
  it('does not let the last run report stand as the next run outcome', async () => {
    const control = harness();
    watch(control);
    await control.pass();
    await control.appear();
    control.report({ outcome: 'pushed', detail: 'Merged master.' });
    await control.finish();

    expect(control.cardAction()).toMatchObject({ outcome: 'landed', detail: 'Merged master.' });

    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    await control.appear();
    await control.finish();

    expect(control.cardAction()).toMatchObject({
      outcome: 'halted',
      detail: 'The run ended without a readable result.',
    });
  });

  /** A directory where the report belongs is the shape of a path the board cannot clear: an ACL, a locked file. */
  it('refuses dispatch when the previous report cannot be removed', async () => {
    const control = harness();
    mkdirSync(actionReportPathOf(home, 'issue:17198'), { recursive: true });
    watch(control);
    await control.pass();

    expect(control.dispatched).toEqual([]);
    expect(control.cardAction()).toMatchObject({
      state: 'refused',
      reason: expect.stringContaining('Could not clear the previous result'),
    });
  });

  it('marks runs without readable results as halted', async () => {
    const control = harness();
    watch(control);
    await control.pass();
    await control.appear();
    await control.finish();

    expect(control.cardAction()).toMatchObject({
      state: 'done',
      outcome: 'halted',
      detail: 'The run ended without a readable result.',
    });
  });

  /** `--bg` returns before its session registers, so a run with no session yet is open rather than lost (M33). */
  it('waits for session registration until the result timeout', async () => {
    const control = harness({ resultTimeoutMs: 60_000 });
    watch(control);
    await control.pass(10_000);

    expect(control.cardAction()).toMatchObject({ state: 'running' });

    // Exceed registration timeout but stay within the retry interval to isolate missing-session handling.
    await control.pass(100_000);

    expect(control.cardAction()).toMatchObject({
      state: 'done',
      outcome: 'failed',
      detail: 'The dispatched session was not found before the timeout.',
    });
  });

  /** Retry failed starts after the context-read interval, never immediately (R21). */
  it('records dispatch failures and delays retries', async () => {
    const control = harness();
    control.dispatch = {
      failure: { subject: 'claude', kind: 'dispatch-missing', message: 'Claude Code was not found.', remedy: 'r' },
    };
    watch(control);
    await control.pass();

    expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'failed' });
    expect(control.snapshot().failures.map((failure) => failure.kind)).toContain('action-failed');
    expect(control.dispatched).toHaveLength(1);

    await control.pass();

    expect(control.dispatched).toHaveLength(1);

    await control.pass(PAST_GATE);

    expect(control.dispatched).toHaveLength(2);
  });
});

describe('the developer asking by hand', () => {
  it('keeps excluded live sessions in automatic and manual duplicate checks', async () => {
    const control = harness({}, [issue()], [sessionOn({ checkoutRoot: CHECKOUT })]);
    control.hub.configure({ ...config(), sessionScope: { ...DEFAULT_SESSION_SCOPE, excludeDirectories: [CHECKOUT] } });
    watch(control);
    await control.pass();
    expect(control.snapshot().lanes.flatMap((lane) => lane.cards).flatMap((card) => card.sessions)).toEqual([]);
    expect(control.dispatched).toEqual([]);
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    expect(control.dispatched).toEqual([]);
    expect(control.notices).toContain('This card has an active session.');
    control.hub.dispose();
  });

  it('rechecks checkout scope after a held manual context read', async () => {
    const control = harness({ actions: {} });
    watch(control);
    await control.pass();
    let release!: () => void;
    control.contextHolding = new Promise<void>((resolve) => { release = resolve; });
    const reads = control.reads.length;
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    expect(control.reads).toHaveLength(reads + 1);
    control.hub.configure({ ...config({ actions: {} }), sessionScope: { ...DEFAULT_SESSION_SCOPE, excludeDirectories: [CHECKOUT] } });
    release();
    await control.settle();
    expect(control.dispatched).toEqual([]);
    expect(control.notices).toContain('No checkout from a previous session is available for this card.');
    control.hub.dispose();
  });

  it('rechecks a newly active session after a held manual context read', async () => {
    const control = harness({ actions: {} });
    watch(control);
    await control.pass();
    let release!: () => void;
    control.contextHolding = new Promise<void>((resolve) => { release = resolve; });
    const reads = control.reads.length;
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    expect(control.reads).toHaveLength(reads + 1);
    control.agent.sessions = [sessionOn({ checkoutRoot: CHECKOUT })];
    await control.hub.roster();
    release();
    await control.settle();
    expect(control.dispatched).toEqual([]);
    expect(control.notices).toContain('This card has an active session.');
    control.hub.dispose();
  });

  it('preserves a useful unsupported-permission refusal for an in-scope card', async () => {
    const control = harness({ actions: {} });
    control.permissions.splice(0, control.permissions.length, 'manual');
    control.hub.configure({ ...config({ actions: {}, permissionMode: 'auto' }), sessionScope: { ...DEFAULT_SESSION_SCOPE, includeDirectories: [home] } });
    watch(control);
    await control.pass();
    const reads = control.reads.length;
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    expect(control.dispatched).toEqual([]);
    expect(control.reads).toHaveLength(reads);
    expect(control.notices).toContain('claude cannot use "auto" for card actions. Set groundControl.actions.permissionMode to a supported mode (manual) or change groundControl.actions.agent.');
    control.hub.dispose();
  });
  it('runs a card whose action is turned off, because the click is the opt-in', async () => {
    const control = harness({ actions: { 'merge-upstream': { enabled: false, prompt: '/or-merge {issue}' } } });
    watch(control);
    await control.pass();

    expect(control.dispatched).toEqual([]);

    const key = control.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key;
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key });
    await control.settle();

    expect(control.dispatched).toHaveLength(1);
    expect(control.dispatched[0]?.prompt).toBe('/or-merge 17198');
  });

  it('runs a card the board has already spent a run on, because the click is not held to that rule', async () => {
    const control = harness();
    watch(control);
    await control.pass();
    await control.appear();
    await control.finish();

    expect(control.dispatched).toHaveLength(1);

    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    expect(control.dispatched).toHaveLength(2);
  });

  it('refuses a card already being worked on', async () => {
    const control = harness();
    watch(control);
    await control.pass();

    expect(control.dispatched).toHaveLength(1);

    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    expect(control.dispatched).toHaveLength(1);
    expect(control.notices).toContain('A card action is already running.');
  });

  /** Report asynchronous manual refusals without storing a refusal that would delay the next request (R25). */
  it('reports manual refusals without applying retry gates', async () => {
    const control = harness({ actions: {} });
    control.pr = { baseRefName: '17000-parent-feature' };
    watch(control);
    await control.pass();

    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    expect(control.notices).toContain(
      '#4021 targets 17000-parent-feature. Merge-upstream requires the default branch, master.',
    );
    expect(control.dispatched).toEqual([]);

    // An immediate manual retry performs another read.
    const before = control.reads.length;
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    expect(control.reads.length).toBeGreaterThan(before);
  });

  /** A throw that escaped would leave the card with no run and no refusal, which reads as never having been tried. */
  it('records adapter exceptions and delays retries', async () => {
    const control = harness();
    control.readThrows = true;
    watch(control);
    await control.pass();

    expect(control.dispatched).toEqual([]);
    expect(control.cardAction()).toMatchObject({ state: 'refused' });

    control.readThrows = false;
    await control.pass();

    expect(control.dispatched).toEqual([]);
  });

  it('stops a run in flight by the short id the CLI printed', async () => {
    const control = harness();
    watch(control);
    await control.pass();

    control.hub.receive({ id: 'board-1' }, { type: 'stopAction', key: control.key() });
    await control.settle();

    expect(control.stopped).toEqual(['46af2ac8']);
    expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'stopped', detail: 'Stopped by you.' });
  });

  /** Keep failed stops running and stoppable; do not falsely report Stopped (R24). */
  it('does not claim a stop it did not achieve', async () => {
    const control = harness();
    control.stopFails = true;
    watch(control);
    await control.pass();

    control.hub.receive({ id: 'board-1' }, { type: 'stopAction', key: control.key() });
    await control.settle();

    expect(control.stopped).toEqual(['46af2ac8']);
    expect(control.cardAction()).toMatchObject({ state: 'running' });
    expect(control.notices.some((notice) => notice.includes('no job matching'))).toBe(true);
  });
});
