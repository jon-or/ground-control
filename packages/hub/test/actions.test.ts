import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { DEFAULT_SESSION_SCOPE } from '@ground-control/core';
import { LINK_GRACE_MS } from '@ground-control/automation';
import { bootstrapDirOf } from '@ground-control/core';
import type {
  ActionRow,
  AgentAdapter,
  ContextReading,
  DispatchInput,
  DispatchResult,
  HistoricalSession,
  HubConfig,
  IssueCard,
  LanedCard,
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
import { readingOf } from '../src/actions.js';
import { makeLaneStore } from '../src/lanes.js';
import { makeMarkStore } from '../src/marks.js';
import { makeTriageStore } from '../src/triageStore.js';
import { makeCheckoutStore, makeWorktreeStore } from '../src/checkoutStore.js';
import { makeActionStore } from '../src/actionStore.js';
import { makeIssueStore } from '../src/issueStore.js';
import { makeStatusStore } from '../src/statusStore.js';
import { actionReportPathOf } from '../src/paths.js';
import { captureLog, cloneAt, fakeClock, fakeSession, reportingAgent, tempHome, worktreeAt } from './helpers.js';

let home: string;
let stateDir: string;
let dispose: () => void;
/** A clone on the issue's branch: the worktree an action works in, which a session or saved session names (R46). */
let CHECKOUT: string;

beforeEach(() => {
  ({ home, dispose } = tempHome());
  stateDir = bootstrapDirOf(home);
  CHECKOUT = cloneAt(join(home, '17198-channel-mapping').replace(/\\/g, '/'), '17198-channel-mapping');
});

afterEach(() => dispose());

/** A step past the 30-minute read gate, for the tests that are about a card becoming due again. */
const PAST_GATE = 2_000_000;

/** The row the harness PR reads as: based on the default branch, so an upstream merge. */
const UPSTREAM: ActionRow = { action: 'merge', qualifier: 'upstream', prompt: '/or-merge {base} {branch} {issue} --single', automatic: true };

/** The row left to the developer's click. */
const MANUAL_ROW: ActionRow = { ...UPSTREAM, automatic: false };

/** A row with nothing to run, so nothing starts on its own and a click reaches the checks before the prompt one. */
const NO_PROMPT: Partial<HubConfig['actions']> = { table: [{ ...UPSTREAM, prompt: '' }] };

function issue(over: Partial<IssueCard> = {}): IssueCard {
  return {
    number: 17198,
    title: 'Channel mapping drops rows past the first page',
    repository: 'example-org/example-repo',
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
  classified: { action: TriageAction; detail: string; target: string | null };
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

/** What the card carries decides whether a finished run's outcome still stands (R39). */
describe('the reading a card carries', () => {
  const card = (over: Partial<LanedCard> = {}): LanedCard => ({
    key: 'issue:17198',
    issue: issue(),
    issueNumber: 17198,
    sessions: [],
    lane: 'review',
    returned: false,
    attention: null,
    reason: '',
    ...over,
  });

  const table = [UPSTREAM];

  it('settles on the action a completed reading names, at the time it was read', () => {
    const triage = { state: 'done', action: 'merge', qualifier: 'upstream', target: null, detail: 'Behind master.', at: 1_788_000_000_000, stale: false } as const;

    expect(readingOf(card({ triage }), table)).toEqual({ action: 'merge', qualifier: 'upstream', settled: true, at: 1_788_000_000_000 });
  });

  it('settles on no action where the completed reading names one the action table has no row for', () => {
    const review = { state: 'done', action: 'address-review', qualifier: 'initial', target: null, detail: 'Comments to answer.', at: 5, stale: false } as const;
    const stacked = { state: 'done', action: 'merge', qualifier: 'stacked', target: null, detail: 'Behind its parent.', at: 5, stale: false } as const;
    const checks = { state: 'done', action: 'fix-checks', qualifier: null, target: null, detail: 'The build is red.', at: 5, stale: false } as const;

    expect(readingOf(card({ triage: review }), table)).toEqual({ action: null, qualifier: null, settled: true, at: 5 });
    expect(readingOf(card({ triage: stacked }), table)).toEqual({ action: null, qualifier: null, settled: true, at: 5 });
    expect(readingOf(card({ triage: checks }), table)).toEqual({ action: null, qualifier: null, settled: true, at: 5 });
  });

  it('is unsettled while the card is being read, or after its read failed', () => {
    expect(readingOf(card({ triage: { state: 'running' } }), table)).toEqual({ action: null, qualifier: null, settled: false, at: null });
    expect(readingOf(card({ triage: { state: 'failed', attempts: 2, exhausted: false } }), table)).toEqual({ action: null, qualifier: null, settled: false, at: null });
  });

  /** Never read is not the same as never readable: one is still coming, the other never will. */
  it('is unsettled for a card not read yet, and settled for one the board does not read', () => {
    expect(readingOf(card(), table)).toEqual({ action: null, qualifier: null, settled: false, at: null });
    expect(readingOf(card({ key: 'session:abc', issue: null, issueNumber: null }), table)).toEqual({ action: null, qualifier: null, settled: true, at: null });
    expect(readingOf(card({ unassigned: true }), table)).toEqual({ action: null, qualifier: null, settled: true, at: null });
  });
});

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
    classified: { action: 'merge', detail: 'Behind master.', target: null },
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
      const path = actionReportPathOf(stateDir, control.key());
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
        fieldProblem: null,
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
  const store = makeActionStore(stateDir);

  control.hub = new Hub({
    clock: clock.clock,
    watch: () => ({ dispose: () => undefined }),
    home,
    stateDir,
    registries: { agents: [dispatching], hosts: [], sources: [source] },
    lanes: makeLaneStore(stateDir),
    marks: makeMarkStore(stateDir),
    triage: makeTriageStore(stateDir),
    checkouts: makeCheckoutStore(stateDir), worktrees: makeWorktreeStore(stateDir),
    // Reads still work; only the write fails, which is the shape a locked or full disk actually takes.
    actions: { read: () => store.read(), write: (state) => (control.storeBroken ? false : store.write(state)) },
    issues: makeIssueStore(stateDir),
    status: makeStatusStore(stateDir),
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
    repositoryRoots: [],
    worktree: { prompt: '' },
    hosts: {},
    logLevel: 'info',
    sources: { github: { repo: 'example-org/example-repo', logins: ['dev-1'] } },
    boardStatuses: ['⚒️ Dev'],
    statusLanes: {},
    refreshIntervalMs: 300_000,
    sessionIntervalMs: 30_000,
    idleExitMs: 1_800_000,
    logs: { rotateBytes: 1_000_000, kept: 2, dispatchRetentionMs: 604_800_000 },
    avatar: { review: 'pull-request-author', offReview: 'assignee' },
    newSession: { prompt: '' },
    custody: { stages: [], bots: [] },
    installActivity: false,
    triage: { enabled: true, concurrency: 2, timeoutMs: 60_000 },
    actions: {
      permissionMode: 'manual',
      concurrency: 1,
      dailyLimit: 10,
      fromBrowser: false,
      // Keep the registration timeout beyond normal test clock advances; timeout tests override it.
      resultTimeoutMs: 14_400_000,
      table: [UPSTREAM],
      testBranchPattern: '^Test-',
      ...actions,
    },
  };
}

function watch(control: Control, watching = true, hostId: string | null = 'vscode'): void {
  control.hub.connect({ id: 'board-1', hostId, workspaceRoot: null, residentRoutes: [], watching }, (message) => {
    if (message.type === 'notice') {
      control.notices.push(message.message);
    }
  });
}

/** Hold the fresh read, and keep the card each broadcast carried, so a missing broadcast shows. */
function held(control: Control): { release(): void; sent(): LanedCard | undefined; all(): LanedCard[] } {
  let release!: () => void;
  const sent: LanedCard[] = [];

  control.contextHolding = new Promise<void>((resolve) => { release = resolve; });
  control.hub.connect({ id: 'board-2', hostId: 'vscode', workspaceRoot: null, residentRoutes: [], watching: true }, (message) => {
    const card = message.type === 'snapshot' || message.type === 'changed' ? message.snapshot.lanes.flatMap((lane) => lane.cards)[0] : undefined;
    if (card !== undefined) sent.push(card);
  });

  return { release, sent: () => sent.at(-1), all: () => sent };
}

/** A page may ask, but the developer decides through `fromBrowser` and the row's automatic setting (R32, R39). */
describe('a card action asked for from the browser', () => {
  const SCOPED = 'This session or checkout is not available under the current session settings.';

  /**
   * Let the board spend its own automatic run and settle it first. `alreadyRun` then holds automatic
   * dispatch, so a second dispatch can only have come from the browser message.
   */
  async function primed(over: Partial<HubConfig['actions']> = {}, watching = true): Promise<Control> {
    const control = harness({}, [issue()]);

    control.hub.configure(config(over));
    watch(control, true, null);
    await control.pass();
    await control.appear();
    await control.finish();

    expect(control.dispatched).toHaveLength(1);

    if (!watching) {
      watch(control, false, null);
    }

    return control;
  }

  function ask(control: Control, type: 'runAction' | 'stopAction' = 'runAction', key = control.key()) {
    control.hub.receive({ id: 'board-1' }, { type, key });

    return control.settle();
  }

  it('starts one where the developer turned browser starts on', async () => {
    const control = await primed({ fromBrowser: true });

    await ask(control);

    expect(control.dispatched).toHaveLength(2);
  });

  it('refuses a start from a tab that is not watching', async () => {
    const control = await primed({ fromBrowser: true }, false);

    await ask(control);

    expect(control.dispatched).toHaveLength(1);
    expect(control.notices.at(-1)).toBe('Open this project tab to run a card action from the browser.');
  });

  /** A page script can click the overlay's controls, so the developer turns browser starts on deliberately. */
  it('refuses a start the developer has not turned on', async () => {
    const control = await primed({ fromBrowser: false });

    await ask(control);

    expect(control.dispatched).toHaveLength(1);
    expect(control.notices.at(-1)).toBe(
      'Turn on groundControl.actions.fromBrowser to run a card action from the browser.',
    );
  });

  /** Zero turns automatic starts off; the daily limit does not bound a manual start from either client (R39). */
  it('starts one with a daily limit of zero', async () => {
    const control = harness({}, [issue()]);

    control.hub.configure(config({ fromBrowser: true, dailyLimit: 0 }));
    watch(control, true, null);
    await control.pass();

    expect(control.dispatched).toHaveLength(0);

    await ask(control);

    expect(control.dispatched).toHaveLength(1);
  });

  it('starts one past the daily limit the board spent, without counting it', async () => {
    const control = await primed({ fromBrowser: true, dailyLimit: 1 });

    await ask(control);

    expect(control.dispatched).toHaveLength(2);
    expect(makeActionStore(stateDir).read().dispatches).toHaveLength(1);
  });

  /** An editor click is itself the opt-in for a disabled action; a page's click is not (R32). */
  it('refuses a start for an action turned off in Settings', async () => {
    const control = harness({}, [issue()]);

    control.hub.configure(config({ fromBrowser: true, table: [{ ...MANUAL_ROW, prompt: '/or-merge' }] }));
    watch(control, true, null);
    await control.pass();

    expect(control.dispatched).toHaveLength(0);

    await ask(control);

    expect(control.dispatched).toHaveLength(0);
    expect(control.notices.at(-1)).toBe('That card action is not automatic in the action table.');
  });

  /** A card with no action to start is not a setting the developer can change, so it must not name one. */
  it('tells a page asking on a card that reads as nothing that there is no action, not that one is turned off', async () => {
    const control = harness({}, [issue()]);

    control.classified = { action: 'fix-checks', detail: 'The build is red.', target: null };
    control.hub.configure(config({ fromBrowser: true }));
    watch(control, true, null);
    await control.pass();

    await ask(control);

    expect(control.dispatched).toHaveLength(0);
    expect(control.notices.at(-1)).toBe('That card has no action to start.');
  });

  it('stops a run without the start gates, because refusing a stop could strand it', async () => {
    const control = await primed({ fromBrowser: false });

    await ask(control, 'stopAction');

    expect(control.notices.at(-1)).not.toContain('fromBrowser');
  });

  /** A hidden tab is not a developer asking, and interrupting a run leaves the checkout part-merged (R39). */
  it('refuses a stop from a tab that is not watching', async () => {
    const control = await primed({ fromBrowser: true }, false);

    await ask(control, 'stopAction');

    expect(control.notices.at(-1)).toBe('Open this project tab to stop a card action from the browser.');
  });

  /**
   * Scope the page's stop so an out-of-scope card cannot be probed by key. The editor's stop stays
   * unconditional: a card the session scope hides could otherwise be left running with no way to stop it.
   */
  it('scope-refuses an unknown key from the page but not from the editor', async () => {
    const control = await primed({ fromBrowser: true });

    await ask(control, 'stopAction', 'issue:absent');

    expect(control.notices.at(-1)).toBe(SCOPED);

    watch(control, true, 'vscode');
    await ask(control, 'stopAction', 'issue:absent');

    expect(control.notices.at(-1)).not.toBe(SCOPED);
  });
});

/** Reading the card and dispatching take seconds; a click is shown as starting at once, in every client (R39). */
describe('a request that is still starting', () => {
  it('broadcasts a click as starting before the card is read, then as running once dispatched', async () => {
    const control = harness({ table: [MANUAL_ROW] });
    watch(control);
    await control.pass();
    const hold = held(control);

    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });

    expect(hold.sent()?.action).toEqual({ state: 'running', action: 'merge', qualifier: 'upstream', since: control.clock.clock.now(), stage: 'starting' });

    hold.release();
    await control.settle();

    expect(control.dispatched).toHaveLength(1);
    expect(hold.sent()?.action).toEqual({ state: 'running', action: 'merge', qualifier: 'upstream', since: control.clock.clock.now() });
  });

  it('goes back to the offer, with the notice, when the fresh read refuses the click', async () => {
    const control = harness({ table: [MANUAL_ROW] });
    watch(control);
    await control.pass();
    const hold = held(control);
    control.pr = { isDraft: true };

    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });

    expect(hold.sent()?.action).toMatchObject({ state: 'running', stage: 'starting' });

    hold.release();
    await control.settle();

    expect(control.notices).toContain('Pull request #4021 is a draft.');
    expect(hold.sent()?.action).toEqual({ state: 'available', action: 'merge', qualifier: 'upstream' });
  });

  /** The automatic check refuses most of the time; showing it as starting would flash every eligible card. */
  it('does not show an automatic check as starting', async () => {
    const control = harness({ table: [MANUAL_ROW] });
    watch(control);
    await control.pass();
    const hold = held(control);
    const reads = control.reads.length;

    control.hub.configure(config());
    await control.pass();

    expect(control.reads).toHaveLength(reads + 1);
    expect(hold.sent()?.action).toEqual({ state: 'available', action: 'merge', qualifier: 'upstream' });

    hold.release();
    await control.settle();

    expect(control.dispatched).toHaveLength(1);
  });
});

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
      cwd: CHECKOUT,
      permissionMode: 'manual',
      name: 'ground-control · merge upstream · #17198',
    });
    expect(control.dispatched[0]?.prompt).toMatch(/^\/or-merge master 17198-channel-mapping 17198 --single\n\n/);
    // A prompt that never names the result file still reports, or every unattended run settles as stopped short.
    expect(control.dispatched[0]?.prompt).toContain(`write JSON to ${actionReportPathOf(stateDir, control.key())}`);
  });

  it('does not dispatch disabled actions', async () => {
    const control = harness({ table: [{ ...MANUAL_ROW, prompt: '/or-merge' }] });
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

    const said = control.notices.filter((notice) => notice.includes('Started Merge · upstream for'));

    expect(said).toHaveLength(1);
    expect(said[0]).toContain('may edit and push');
    expect(said[0]).toContain('Turn off automatic runs in the action table.');

    await control.pass(PAST_GATE);

    expect(control.notices.filter((notice) => notice.includes('Started Merge · upstream for'))).toHaveLength(1);
  });

  /** Failed dispatches must not consume the first-run notice. */
  /**
   * The hub serves Chrome with no editor open, so a browser-only run would otherwise spend the one R32
   * warning on nobody. Hold it instead: it is the warning that says an agent may edit and push.
   */
  it('holds the first-dispatch warning until an editor can show it', async () => {
    const control = harness({}, [issue()]);
    const overlay: string[] = [];

    control.hub.connect({ id: 'overlay', hostId: null, workspaceRoot: null, residentRoutes: [], watching: true }, (message) => {
      if (message.type === 'notice') overlay.push(message.message);
    });
    await control.pass();

    expect(control.dispatched).toHaveLength(1);
    expect(overlay.filter((notice) => notice.includes('Started Merge · upstream for'))).toEqual([]);

    watch(control);

    const said = control.notices.filter((notice) => notice.includes('Started Merge · upstream for'));

    expect(said).toHaveLength(1);
    expect(said[0]).toContain('may edit and push');
  });

  it('does not announce failed dispatches', async () => {
    const control = harness();
    control.dispatch = {
      failure: { subject: 'claude', kind: 'dispatch-missing', message: 'Claude Code was not found.', remedy: 'r' },
    };
    watch(control);
    await control.pass();

    expect(control.notices.filter((notice) => notice.includes('Started Merge · upstream for'))).toEqual([]);
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

  /** The card shows what it reads as now: a reading taken after the run replaces the run's own verdict (R39). */
  it('clears a finished run once the card has been read again', async () => {
    const control = harness();
    watch(control);
    await control.pass();
    await control.appear();
    await control.finish();

    expect(control.cardAction()).toMatchObject({ state: 'done', action: 'merge', qualifier: 'upstream', outcome: 'halted' });

    control.classified = { action: 'fix-checks', detail: 'The build is red.', target: null };
    control.hub.receive({ id: 'board-1' }, { type: 'retriage', key: control.key() });
    await control.settle();

    expect(control.cardAction()).toBeUndefined();
  });

  /**
   * A successful merge changes its own head commit. Completed runs must block automatic repeats even after that
   * change, until the card is read again after the run.
   */
  it('never dispatches again once a run landed, however far the branch has moved, until the card’s status changes', async () => {
    // The harness issue's status change is dated after the fake clock; this one moved before the run.
    const control = harness({}, [issue({ statusChangedAt: '2026-08-01T09:00:00Z' })]);
    watch(control);
    await control.pass();
    await control.appear();
    control.report({ outcome: 'done', detail: 'Merged master.' });
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

    await control.appear();
    control.report({ outcome: 'done', detail: 'Merged master again.' });
    await control.finish();
    await control.pass(PAST_GATE);

    expect(control.dispatched).toHaveLength(2);

    // Reading the same conversation again is not a new request.
    control.hub.receive({ id: 'board-1' }, { type: 'retriage', key: control.key() });
    await control.settle();
    await control.pass(PAST_GATE);

    expect(control.dispatched).toHaveLength(2);

    // A status change after the run is; the card is read again and may start one.
    control.cards = [issue({ statusChangedAt: new Date(control.clock.clock.now() + 1000).toISOString() })];
    await control.pass(PAST_GATE);
    await control.pass(PAST_GATE);

    expect(control.dispatched).toHaveLength(3);
  });

  /** Enabled actions require fresh GitHub context, but repeated hub updates must respect the retry interval. */
  it('waits for the retry interval before rereading', async () => {
    const control = harness();
    control.pr = { isDraft: true };
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

  it('starts a manual request past the daily limit, and does not count it', async () => {
    const control = harness({ dailyLimit: 1 });
    watch(control);
    await control.pass();
    await control.appear();
    await control.finish();

    expect(control.dispatched).toHaveLength(1);

    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    expect(control.dispatched).toHaveLength(2);
    expect(control.notices).not.toContain('Card action limit reached for the last 24 hours.');
    expect(makeActionStore(stateDir).read().dispatches).toHaveLength(1);
  });

  /** A recorded refusal may no longer hold; a click reads the card afresh without waiting out the retry gate. */
  it('keeps the run control pressable over an automatic refusal, and starts once the cause has cleared', async () => {
    const control = harness();
    control.pr = { isDraft: true };
    watch(control);
    await control.pass();

    expect(control.dispatched).toEqual([]);
    expect(control.cardAction()).toEqual({ state: 'refused', action: 'merge', qualifier: 'upstream', reason: 'Pull request #4021 is a draft.', retryable: true });

    control.pr = { isDraft: false };
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    expect(control.dispatched).toHaveLength(1);
  });
});

describe('the action table', () => {
  const REVIEW: ActionRow = { action: 'review-others', qualifier: 'initial', prompt: '/review-pr {pr} {branch}', automatic: true };

  it('reviews someone else’s pull request with the review row, as the reviewer', async () => {
    const control = harness({ table: [UPSTREAM, REVIEW] });
    control.pr = { author: 'dev-2' };
    control.classified = { action: 'review-others', detail: 'Mayur asked you to review.', target: null };
    watch(control);
    await control.pass();

    expect(control.dispatched).toHaveLength(1);
    expect(control.dispatched[0]).toMatchObject({ cwd: CHECKOUT, name: 'ground-control · review-others initial · #17198' });
    expect(control.dispatched[0]?.prompt).toMatch(/^\/review-pr 4021 17198-channel-mapping\n\n/);
    expect(control.dispatched[0]?.prompt).toContain('"outcome":"done"');
    expect(control.cardAction()).toMatchObject({ state: 'running', action: 'review-others', qualifier: 'initial' });
  });

  it('offers nothing on a card whose reading has no row, and starts nothing', async () => {
    const control = harness({ table: [REVIEW] });
    watch(control);
    await control.pass();

    expect(control.snapshot().lanes.flatMap((lane) => lane.cards)[0]?.triage).toMatchObject({ action: 'merge', qualifier: 'upstream' });
    expect(control.cardAction()).toBeUndefined();
    expect(control.dispatched).toEqual([]);
  });

  it('runs the row naming the reading’s qualifier over the one naming none, wherever it sits', async () => {
    const control = harness({ table: [{ ...UPSTREAM, qualifier: null, prompt: '/any-merge' }, { ...UPSTREAM, prompt: '/upstream-merge' }] });
    watch(control);
    await control.pass();

    expect(control.dispatched[0]?.prompt).toMatch(/^\/upstream-merge\n\n/);
  });

  it('runs a row naming no qualifier for any reading of its action', async () => {
    const control = harness({ table: [{ ...UPSTREAM, qualifier: null, prompt: '/any-merge {default}' }] });
    watch(control);
    await control.pass();

    expect(control.dispatched[0]?.prompt).toMatch(/^\/any-merge master\n\n/);
  });

  // Claude keeps a finished background session listed (M33); it is not work the run would collide with.
  it('starts, and offers, the action on a card whose only session has finished', async () => {
    const control = harness({ table: [MANUAL_ROW] }, [issue()], [sessionOn({ finished: true })]);
    watch(control);
    await control.pass();

    expect(control.cardAction()).toEqual({ state: 'available', action: 'merge', qualifier: 'upstream' });

    control.hub.configure(config());
    await control.pass(PAST_GATE);

    expect(control.dispatched).toHaveLength(1);
  });

  it('says why a merge it could not type cannot run, rather than offering nothing', async () => {
    const control = harness({ table: [{ ...UPSTREAM, automatic: false }, { ...UPSTREAM, qualifier: 'test', automatic: false }] });
    control.classified = { action: 'merge', detail: 'Rich asked for a merge into release-9.', target: 'release-9' };
    watch(control);
    await control.pass();

    expect(control.cardAction()).toEqual({
      state: 'refused',
      action: 'merge',
      qualifier: null,
      reason: 'The request names release-9, which is neither this pull request\'s branch, its base, nor a test branch. Read the card again.',
    });
  });

  it('still refuses a card whose session is running', async () => {
    const control = harness({ table: [MANUAL_ROW] }, [issue()], [sessionOn()]);
    watch(control);
    await control.pass();

    expect(control.cardAction()).toEqual({ state: 'refused', action: 'merge', qualifier: 'upstream', reason: 'This card has an active session.' });
  });
});

describe('what the board refuses to act on', () => {
  /** A base other than the default branch makes the merge stacked, which runs its own row (R39). */
  it('runs a pull request based on another branch as a stacked merge, under the stacked row', async () => {
    const control = harness({ table: [{ ...UPSTREAM, qualifier: 'stacked', prompt: '/or-merge {default} {base} {branch}' }] });
    control.pr = { baseRefName: '17000-parent-feature' };
    watch(control);
    await control.pass();

    expect(control.dispatched).toHaveLength(1);
    expect(control.dispatched[0]).toMatchObject({ name: 'ground-control · merge stacked · #17198' });
    expect(control.dispatched[0]?.prompt).toMatch(/^\/or-merge master 17000-parent-feature 17198-channel-mapping\n\n/);
  });

  /** The row was chosen for the type the card was read as; a base that moved since would run the wrong legs. */
  it('reports refusal for a PR restacked onto another branch since it was read as an upstream merge', async () => {
    const control = harness({ table: [MANUAL_ROW] });
    watch(control);
    await control.pass();

    expect(control.cardAction()).toEqual({ state: 'available', action: 'merge', qualifier: 'upstream' });

    control.pr = { baseRefName: '17000-parent-feature' };
    control.hub.configure(config());
    await control.pass(PAST_GATE);

    expect(control.dispatched).toEqual([]);
    expect(control.cardAction()).toMatchObject({
      state: 'refused',
      reason: 'This is now a stacked merge, not the upstream merge the card was read as. Read the card again.',
    });
  });

  /** Never guessed from a branch name — the rule R37's changes fold already holds the board to. */
  /** Require a requested merge on the server; a client can submit arbitrary card keys (R39). */
  it('refuses a card whose reading is not asking for a merge', async () => {
    const control = harness();
    control.classified = { action: 'fix-checks', detail: 'The build is red.', target: null };
    watch(control);
    await control.pass();

    expect(control.dispatched).toEqual([]);
    expect(control.cardAction()).toBeUndefined();

    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    expect(control.dispatched).toEqual([]);
    expect(control.notices).toContain('This card has no action to run.');
  });

  // An action works in the card's worktree; with none and no prompt to make one there is nothing to start (R46).
  it('refuses a card with no worktree and no prompt to make one, without spending a read to find that out', async () => {
    const control = harness();
    control.history = [];
    watch(control);
    await control.pass();

    expect(control.dispatched).toEqual([]);
    // Only triage reads context; action validation makes no request.
    expect(control.reads).toEqual([17198]);
    expect(control.cardAction()).toEqual({
      state: 'refused',
      action: 'merge',
      qualifier: 'upstream',
      reason: 'No worktree for this issue. Set groundControl.worktree.prompt so one can be created.',
    });
  });

  /** A pick permits opening and manual starts (R41, R42). An action needs the issue's worktree, which a clone on another branch is not (R46). */
  it('refuses a card whose only checkout is a folder the developer picked that is not the issue’s worktree', async () => {
    const control = harness();
    control.history = [];
    watch(control);
    await control.pass();

    // Create a checkout matching the card repository after its key is available, for setCheckout and checkoutFor validation.
    const picked = join(home, 'picked-by-hand');
    mkdirSync(join(picked, '.git'), { recursive: true });
    writeFileSync(join(picked, '.git', 'config'), '[remote "origin"]\n url = https://github.com/example-org/example-repo.git');
    makeCheckoutStore(stateDir).write(control.key(), picked.replace(/\\/g, '/'));

    control.dispatched.length = 0;
    await control.pass();

    // Named, so this cannot pass by the pick never having reached the card at all.
    expect(control.cardCheckout()).toEqual({ root: picked.replace(/\\/g, '/'), source: 'remembered', only: true });

    expect(control.dispatched).toEqual([]);
    expect(control.cardAction()).toEqual({
      state: 'refused',
      action: 'merge',
      qualifier: 'upstream',
      reason: 'No worktree for this issue. Set groundControl.worktree.prompt so one can be created.',
    });
  });

  it('disables actions without configured prompts', async () => {
    const control = harness(NO_PROMPT);
    watch(control);
    await control.pass();

    expect(control.dispatched).toEqual([]);
    expect(control.cardAction()).toMatchObject({
      state: 'refused',
      action: 'merge',
      qualifier: 'upstream',
      reason: 'No prompt is set for Merge · upstream. Set it in the action table.',
    });
  });
});

describe('following a run to its end', () => {
  it('shows running state until the session ends', async () => {
    const control = harness();
    watch(control);
    await control.pass();

    expect(control.cardAction()).toMatchObject({ state: 'running', action: 'merge', qualifier: 'upstream' });

    // The dispatched session appears on the roster under the short id the CLI printed (`mechanics.md` M33).
    await control.appear();

    expect(control.cardAction()).toMatchObject({ state: 'running' });

    control.report({ outcome: 'done', detail: 'Merged master, tests green.' });
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
    mkdirSync(actionReportPathOf(stateDir, 'issue:17198'), { recursive: true });
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
    const control = harness(NO_PROMPT);
    watch(control);
    await control.pass();
    let release!: () => void;
    control.contextHolding = new Promise<void>((resolve) => { release = resolve; });
    const reads = control.reads.length;
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    expect(control.reads).toHaveLength(reads + 1);
    control.hub.configure({ ...config(NO_PROMPT), sessionScope: { ...DEFAULT_SESSION_SCOPE, excludeDirectories: [CHECKOUT] } });
    release();
    await control.settle();
    expect(control.dispatched).toEqual([]);
    expect(control.notices).toContain('No worktree for this issue. Set groundControl.worktree.prompt so one can be created.');
    control.hub.dispose();
  });

  it('rechecks a newly active session after a held manual context read', async () => {
    const control = harness(NO_PROMPT);
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
    const control = harness(NO_PROMPT);
    control.permissions.splice(0, control.permissions.length, 'manual');
    control.hub.configure({ ...config({ ...NO_PROMPT, permissionMode: 'auto' }), sessionScope: { ...DEFAULT_SESSION_SCOPE, includeDirectories: [home] } });
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
    const control = harness({ table: [{ ...MANUAL_ROW, prompt: '/or-merge {issue}' }] });
    watch(control);
    await control.pass();

    expect(control.dispatched).toEqual([]);

    const key = control.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key;
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key });
    await control.settle();

    expect(control.dispatched).toHaveLength(1);
    expect(control.dispatched[0]?.prompt).toMatch(/^\/or-merge 17198\n\n/);
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
    const control = harness(NO_PROMPT);
    control.pr = { isDraft: true };
    watch(control);
    await control.pass();

    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    expect(control.notices).toContain('Pull request #4021 is a draft.');
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

/**
 * An action works in the card's worktree. Where the card has none, the worktree prompt runs first from the
 * card's clone, reports where it made one, and the action follows in it (R46).
 */
describe('making the worktree an action needs', () => {
  const PROMPT = 'Make a worktree for #{issue} ({title}) from {clone}, then write {resultPath}';
  let CLONE: string;

  beforeEach(() => {
    CLONE = cloneAt(join(home, 'repo').replace(/\\/g, '/'), 'master');
  });

  /**
   * A card with no worktree: no saved session names one, and the clone is on another branch. The action is
   * left to the developer's click unless a test is about the automatic path.
   */
  function bare(over: Partial<HubConfig['actions']> = { table: [MANUAL_ROW] }, prompt = PROMPT): Control {
    const control = harness(over);
    control.history = [];
    control.hub.configure({ ...config(over), repositoryRoots: [CLONE], worktree: { prompt } });
    watch(control);

    return control;
  }

  const MANUAL: Partial<HubConfig['actions']> = { table: [MANUAL_ROW] };

  const card = (control: Control) => control.snapshot().lanes.flatMap((lane) => lane.cards)[0]!;

  /** What the worktree run made: registered in the clone under a name that says nothing about the issue. */
  function made(): string {
    return worktreeAt(CLONE, join(home, 'repo.worktrees', 'refund').replace(/\\/g, '/'), 'refund-window');
  }

  it('offers to make a worktree on a card that has none, and says why it cannot where the prompt is unset', async () => {
    const control = bare(MANUAL, '');
    await control.pass();

    expect(card(control).worktree).toBeUndefined();
    expect(card(control).creation).toEqual({ state: 'refused', reason: 'No worktree for this issue. Set groundControl.worktree.prompt so one can be created.' });

    control.hub.configure({ ...config(MANUAL), repositoryRoots: [CLONE], worktree: { prompt: PROMPT } });
    await control.pass();

    expect(card(control).creation).toEqual({ state: 'available' });
    expect(card(control).action).toEqual({ state: 'available', action: 'merge', qualifier: 'upstream' });
  });

  it('offers nothing where the card already has its worktree', async () => {
    const control = harness();
    control.hub.configure({ ...config(), worktree: { prompt: PROMPT } });
    watch(control);
    await control.pass();

    expect(card(control).worktree).toEqual({ root: CHECKOUT, branch: '17198-channel-mapping', only: true });
    expect(card(control).creation).toBeUndefined();
  });

  it('runs the worktree prompt from the clone before the action, with the card’s facts filled in', async () => {
    const control = bare();
    await control.pass();

    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    expect(control.dispatched).toHaveLength(1);
    expect(control.dispatched[0]).toMatchObject({
      cwd: CLONE,
      name: 'ground-control · create-worktree · #17198',
      prompt: `Make a worktree for #17198 (Channel mapping drops rows past the first page) from ${CLONE}, then write ${actionReportPathOf(stateDir, control.key())}`,
    });
    expect(control.cardAction()).toEqual({ state: 'running', action: 'merge', qualifier: 'upstream', since: control.clock.clock.now(), stage: 'worktree' });
    expect(card(control).creation).toEqual({ state: 'running', since: control.clock.clock.now() });
  });

  it('tells the worktree run the card’s pull request, its head, and whose it is', async () => {
    const control = bare(MANUAL, 'Worktree for {pr} on {branch} as {role}, report to {resultPath}');
    await control.pass();

    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    expect(control.dispatched[0]?.prompt).toBe(`Worktree for 4021 on 17198-channel-mapping as author, report to ${actionReportPathOf(stateDir, control.key())}`);
  });

  // A reviewer's worktree checks out the head rather than branching, so a run asked for alone reads the PR first.
  it('reads the pull request for a worktree asked for alone, and names a reviewer as one', async () => {
    const control = bare(MANUAL, 'Worktree for {pr} on {branch} as {role}');
    control.pr = { author: 'dev-2', headRefName: '17198-their-branch' };
    await control.pass();
    const reads = control.reads.length;

    control.hub.receive({ id: 'board-1' }, { type: 'createWorktree', key: control.key() });
    await control.settle();

    expect(control.reads.length).toBe(reads + 1);
    expect(control.dispatched[0]?.prompt).toMatch(/^Worktree for 4021 on 17198-their-branch as reviewer\n\n/);
  });

  it('leaves the pull request placeholders empty on a card with none, without reading it', async () => {
    const control = bare(MANUAL, 'Worktree [{pr}] [{branch}] [{role}]');
    control.cards = [issue({ pullRequest: null })];
    await control.pass();
    const reads = control.reads.length;

    control.hub.receive({ id: 'board-1' }, { type: 'createWorktree', key: control.key() });
    await control.settle();

    expect(control.reads.length).toBe(reads);
    expect(control.dispatched[0]?.prompt).toMatch(/^Worktree \[\] \[\] \[\]\n\n/);
  });

  it('leaves the placeholders empty where the fresh read finds the pull request gone', async () => {
    const control = bare(MANUAL, 'Worktree for [{pr}]');
    await control.pass();
    control.pr = null;

    control.hub.receive({ id: 'board-1' }, { type: 'createWorktree', key: control.key() });
    await control.settle();

    expect(control.dispatched[0]?.prompt).toMatch(/^Worktree for \[\]\n\n/);
  });

  it('starts no worktree where the pull request cannot be read, and says why', async () => {
    const control = bare(MANUAL, 'Worktree for {pr}');
    control.readThrows = true;
    await control.pass();

    control.hub.receive({ id: 'board-1' }, { type: 'createWorktree', key: control.key() });
    await control.settle();

    expect(control.dispatched).toEqual([]);
    expect(control.notices).toContain('the seam threw rather than answering');
  });

  it('tells a worktree prompt that never names the result file to report ready and the path', async () => {
    const control = bare(undefined, 'Make a worktree for #{issue} from {clone}');
    await control.pass();

    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    const prompt = control.dispatched[0]?.prompt ?? '';

    expect(prompt).toContain(`write JSON to ${actionReportPathOf(stateDir, control.key())}`);
    expect(prompt).toContain('"outcome":"ready"');
  });

  it('records the worktree the run reports, then starts the action in it as the same attempt', async () => {
    const control = bare();
    await control.pass();
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    await control.appear();

    const worktree = made();
    control.report({ outcome: 'ready', detail: 'Built.', worktree });
    await control.finish();
    await control.settle();

    expect(card(control).worktree).toEqual({ root: worktree, branch: 'refund-window', only: true });
    expect(makeWorktreeStore(stateDir).read()).toEqual({ [control.key()]: worktree });
    expect(control.dispatched).toHaveLength(2);
    expect(control.dispatched[1]).toMatchObject({ cwd: worktree });
    expect(control.dispatched[1]?.prompt).toMatch(/^\/or-merge master 17198-channel-mapping 17198 --single\n\n/);
    expect(control.cardAction()).toMatchObject({ state: 'running', action: 'merge', qualifier: 'upstream' });
    expect(control.cardAction()).not.toHaveProperty('stage');
    // A manual request spends no daily allowance, for the worktree run or the action after it.
    expect(makeActionStore(stateDir).read().dispatches).toEqual([]);
  });

  it('shows the worktree run on the issue card though it runs in the clone, and starts the action once it has finished', async () => {
    const control = bare();
    await control.pass();
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    // The clone's branch names no issue, so only the dispatch record puts this session on the card (R3).
    const run = fakeSession({ agent: 'claude', sessionId: '46af2ac8-f232-4406-8e8f-2579df5eb08f', cwd: CLONE, checkoutRoot: CLONE, branch: 'master', issueNumber: null });
    control.agent.sessions = [run];
    await control.pass();

    const cards = () => control.snapshot().lanes.flatMap((lane) => lane.cards);

    expect(cards().map((c) => c.key)).toEqual(['issue:17198']);
    expect(cards()[0]?.sessions.map((s) => s.sessionId)).toEqual([run.sessionId]);
    // The clone is where the run started, not the card's checkout.
    expect(cards()[0]?.checkout).toBeUndefined();

    const worktree = made();
    control.report({ outcome: 'ready', detail: 'Built.', worktree });
    // Claude keeps a finished background session listed (M33); it is not active work that blocks the action.
    control.agent.sessions = [{ ...run, finished: true }];
    await control.pass();
    await control.settle();

    expect(cards()[0]?.sessions.map((s) => s.sessionId)).toEqual([run.sessionId]);
    expect(control.dispatched).toHaveLength(2);
    expect(control.dispatched[1]).toMatchObject({ cwd: worktree });
  });

  it('keeps a worktree run on the issue card once only its saved transcript remains, until it is gone for a day', async () => {
    const control = bare();
    await control.pass();
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    const run = fakeSession({ agent: 'claude', sessionId: '46af2ac8-f232-4406-8e8f-2579df5eb08f', cwd: CLONE, checkoutRoot: CLONE, branch: 'master', issueNumber: null });
    control.agent.sessions = [run];
    await control.pass();

    control.agent.sessions = [];
    control.history = [{ agent: 'claude', sessionId: run.sessionId, title: 'Worktree', cwd: CLONE, branch: 'master', issueNumber: null, repository: 'github.com/example-org/example-repo', updatedAt: control.clock.clock.now() }];
    await control.pass();

    const cards = () => control.snapshot().lanes.flatMap((lane) => lane.cards);

    expect(cards().map((c) => c.key)).toEqual(['issue:17198']);
    expect(cards()[0]?.lastSession).toMatchObject({ sessionId: run.sessionId, linked: true });
    expect(Object.keys(makeActionStore(stateDir).read().links)).toEqual([`claude:${run.sessionId}`]);

    // Gone from the roster and history: kept through the grace period, then forgotten.
    control.history = [];
    await control.pass();

    expect(Object.keys(makeActionStore(stateDir).read().links)).toHaveLength(1);

    await control.pass(LINK_GRACE_MS);

    expect(makeActionStore(stateDir).read().links).toEqual({});
  });

  // With the agent turned off its sessions are not read, so their absence proves nothing.
  it('keeps the links of an agent that was not read', async () => {
    const control = bare();
    await control.pass();
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    control.agent.sessions = [fakeSession({ agent: 'claude', sessionId: '46af2ac8-f232-4406-8e8f-2579df5eb08f', cwd: CLONE, checkoutRoot: CLONE, branch: 'master', issueNumber: null })];
    await control.pass();

    control.hub.configure({ ...config(MANUAL), agents: [], repositoryRoots: [CLONE], worktree: { prompt: PROMPT } });
    control.agent.sessions = [];
    await control.pass(LINK_GRACE_MS);
    await control.pass();

    expect(Object.keys(makeActionStore(stateDir).read().links)).toEqual(['claude:46af2ac8-f232-4406-8e8f-2579df5eb08f']);
  });

  // The click, or the automatic row, consented to the row the worktree was made for.
  it('starts nothing after the worktree where the card has since been read as another row', async () => {
    const stacked: ActionRow = { ...MANUAL_ROW, qualifier: 'stacked', automatic: true };
    const control = bare({ table: [MANUAL_ROW, stacked] });
    await control.pass();
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    await control.appear();

    // Restacked while the worktree run works, and read again: now the automatic stacked row.
    control.pr = { baseRefName: '17000-parent-feature' };
    control.hub.receive({ id: 'board-1' }, { type: 'retriage', key: control.key() });
    await control.settle();
    await control.pass();

    control.report({ outcome: 'ready', detail: 'Built.', worktree: made() });
    await control.finish();
    await control.settle();

    expect(control.dispatched).toHaveLength(1);
    expect(control.cardAction()).toMatchObject({
      state: 'refused',
      action: 'merge',
      qualifier: 'stacked',
      reason: 'The card now reads as Merge · stacked, not the Merge · upstream its worktree was made for. Nothing was started.',
    });
  });

  it('halts, and starts no action, where the run reports a directory git does not register', async () => {
    const control = bare();
    await control.pass();
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    await control.appear();

    const stray = join(home, 'elsewhere').replace(/\\/g, '/');
    mkdirSync(stray);
    control.report({ outcome: 'ready', detail: 'Built.', worktree: stray });
    await control.finish();
    await control.settle();

    expect(control.dispatched).toHaveLength(1);
    expect(card(control).worktree).toBeUndefined();
    expect(control.cardAction()).toMatchObject({ state: 'done', action: 'merge', qualifier: 'upstream', outcome: 'halted', detail: `The run reported ${stray}, which git does not register as a working tree.` });
    expect(card(control).creation).toMatchObject({ state: 'done', outcome: 'halted' });
  });

  it('halts where the run ends without reporting a worktree', async () => {
    const control = bare();
    await control.pass();
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    await control.appear();
    await control.finish();

    expect(control.dispatched).toHaveLength(1);
    expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'halted', detail: 'The run ended without reporting a worktree.' });
  });

  it('refuses a worktree of another repository, however the run got there', async () => {
    const control = bare();
    await control.pass();
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    await control.appear();

    const other = cloneAt(join(home, 'other').replace(/\\/g, '/'), '17198-channel-mapping', 'https://github.com/example-org/other.git');
    control.report({ outcome: 'ready', detail: 'Built.', worktree: other });
    await control.finish();

    expect(control.dispatched).toHaveLength(1);
    expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'halted', detail: `The run reported ${other}, which is not a working tree of example-org/example-repo.` });
  });

  it('makes the worktree alone when asked, and starts no action after it', async () => {
    const control = bare();
    await control.pass();

    control.hub.receive({ id: 'board-1' }, { type: 'createWorktree', key: control.key() });
    await control.settle();

    expect(control.dispatched).toHaveLength(1);
    expect(control.dispatched[0]).toMatchObject({ cwd: CLONE, name: 'ground-control · create-worktree · #17198' });
    // The action stays offerable: the worktree run is not the action, and the run control must not say it is.
    expect(control.cardAction()).toEqual({ state: 'available', action: 'merge', qualifier: 'upstream' });
    expect(card(control).creation).toEqual({ state: 'running', since: control.clock.clock.now() });

    await control.appear();
    const worktree = made();
    control.report({ outcome: 'ready', detail: 'Built.', worktree });
    await control.finish();
    await control.settle();

    expect(control.dispatched).toHaveLength(1);
    expect(card(control).worktree?.root).toBe(worktree);
    expect(card(control).creation).toBeUndefined();
    expect(card(control).checkout).toEqual({ root: worktree, source: 'worktree', only: true });
  });

  it('shows a worktree click as starting until its run is dispatched', async () => {
    const control = bare();
    await control.pass();
    const hold = held(control);

    control.hub.receive({ id: 'board-1' }, { type: 'createWorktree', key: control.key() });

    expect(hold.sent()?.creation).toEqual({ state: 'running', since: control.clock.clock.now(), stage: 'starting' });
    expect(hold.sent()?.action).toEqual({ state: 'available', action: 'merge', qualifier: 'upstream' });

    hold.release();
    await control.settle();

    expect(hold.sent()?.creation).toEqual({ state: 'running', since: control.clock.clock.now() });
  });

  it('shows both controls starting when an action is clicked on a card with no worktree', async () => {
    const control = bare();
    await control.pass();
    const hold = held(control);

    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });

    expect(hold.sent()?.action).toMatchObject({ state: 'running', stage: 'starting' });
    expect(hold.sent()?.creation).toEqual({ state: 'running', since: control.clock.clock.now(), stage: 'starting' });

    hold.release();
    await control.settle();

    expect(hold.sent()?.creation).toEqual({ state: 'running', since: control.clock.clock.now() });
  });

  it('shows the action after its worktree run as starting, not offered, while it is read', async () => {
    const control = bare();
    await control.pass();
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    await control.appear();
    control.report({ outcome: 'ready', detail: 'Built.', worktree: made() });
    const hold = held(control);

    const before = hold.all().length;

    // A roster poll settles the worktree run; the broadcasts it makes must never offer the action meanwhile.
    control.agent.sessions = [];
    await control.hub.roster();
    await control.settle();

    expect(hold.all().slice(before).map((card) => card.action?.state)).not.toContain('available');
    expect(hold.sent()?.action).toMatchObject({ state: 'running', action: 'merge', stage: 'starting' });

    hold.release();
    await control.settle();

    expect(control.dispatched).toHaveLength(2);
    expect(hold.sent()?.action).toMatchObject({ state: 'running', action: 'merge' });
    expect(hold.sent()?.action).not.toHaveProperty('stage');
  });

  // A landed worktree run must not read as the action having run, or the automatic path would never start it.
  it('starts the automatic action after a worktree made on its own, as a new attempt', async () => {
    const control = bare();
    await control.pass();
    control.hub.receive({ id: 'board-1' }, { type: 'createWorktree', key: control.key() });
    await control.settle();
    await control.appear();
    const worktree = made();
    control.report({ outcome: 'ready', detail: 'Built.', worktree });
    await control.finish();
    await control.settle();

    expect(control.dispatched).toHaveLength(1);

    control.hub.configure({ ...config(), repositoryRoots: [CLONE], worktree: { prompt: PROMPT } });
    await control.pass(PAST_GATE);

    expect(control.dispatched).toHaveLength(2);
    expect(control.dispatched[1]).toMatchObject({ cwd: worktree });
    expect(control.dispatched[1]?.prompt).toMatch(/^\/or-merge master 17198-channel-mapping 17198 --single\n\n/);
    // The worktree was asked for by hand; only the automatic action counts.
    expect(makeActionStore(stateDir).read().dispatches).toHaveLength(1);
  });

  it('shows the refusal, not the action as done, where the action after a linked run is refused', async () => {
    const control = bare();
    await control.pass();
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    await control.appear();
    const worktree = made();
    control.report({ outcome: 'ready', detail: 'Built.', worktree });
    // The PR went draft while the worktree was being made, so the fresh read refuses the action.
    control.pr = { isDraft: true };
    await control.finish();
    await control.settle();

    expect(control.dispatched).toHaveLength(1);
    expect(card(control).worktree?.root).toBe(worktree);
    // The draft may be undone before the next automatic check, so the click stays available.
    expect(control.cardAction()).toEqual({ state: 'refused', action: 'merge', qualifier: 'upstream', reason: 'Pull request #4021 is a draft.', retryable: true });
  });

  it('refuses to make a worktree where the hub knows no clone of the repository', async () => {
    const control = bare();
    control.hub.configure({ ...config(MANUAL), repositoryRoots: [], worktree: { prompt: PROMPT } });
    await control.pass();

    expect(card(control).creation).toEqual({
      state: 'refused',
      reason: 'Ground Control has no clone of example-org/example-repo. Open one in an editor window, or add it to groundControl.repositoryRoots.',
    });

    control.hub.receive({ id: 'board-1' }, { type: 'createWorktree', key: control.key() });
    await control.settle();

    expect(control.dispatched).toEqual([]);
    expect(control.notices).toContain('Ground Control has no clone of example-org/example-repo. Open one in an editor window, or add it to groundControl.repositoryRoots.');
  });

  it('refuses to choose between two clones of the repository', async () => {
    const control = bare();
    const second = cloneAt(join(home, 'repo-2').replace(/\\/g, '/'), 'master');
    control.hub.configure({ ...config(), repositoryRoots: [CLONE, second], worktree: { prompt: PROMPT } });
    await control.pass();

    expect(card(control).creation).toEqual({
      state: 'refused',
      reason: 'Ground Control knows 2 clones of example-org/example-repo and cannot choose between them. Narrow groundControl.repositoryRoots.',
    });
  });

  it('stops the worktree run like any run, and the action it preceded does not start', async () => {
    const control = bare();
    await control.pass();
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    control.hub.receive({ id: 'board-1' }, { type: 'stopAction', key: control.key() });
    await control.settle();

    expect(control.stopped).toEqual(['46af2ac8']);
    expect(control.cardAction()).toMatchObject({ state: 'done', action: 'merge', qualifier: 'upstream', outcome: 'stopped' });
    expect(card(control).creation).toMatchObject({ state: 'done', outcome: 'stopped' });

    await control.pass();
    expect(control.dispatched).toHaveLength(1);
  });

  /** A page's request is a dispatch, so it is bounded like a page-asked action (R32, R39). */
  it('refuses a page’s request to make a worktree without the browser opt-in', async () => {
    const control = bare();
    await control.pass();
    watch(control, true, null);

    control.hub.receive({ id: 'board-1' }, { type: 'createWorktree', key: control.key() });
    await control.settle();

    expect(control.dispatched).toEqual([]);
    expect(control.notices).toContain('Turn on groundControl.actions.fromBrowser to run a card action from the browser.');
  });

  it('runs the worktree prompt before an automatic action too', async () => {
    const control = bare({});
    await control.pass();
    await control.pass(PAST_GATE);

    expect(control.dispatched).toHaveLength(1);
    expect(control.dispatched[0]).toMatchObject({ cwd: CLONE, name: 'ground-control · create-worktree · #17198' });
  });

  it('counts an automatic worktree run and the action after it as one attempt', async () => {
    const control = bare({});
    await control.pass();
    await control.pass(PAST_GATE);
    await control.appear();
    control.report({ outcome: 'ready', detail: 'Built.', worktree: made() });
    await control.finish();
    await control.settle();

    expect(control.dispatched).toHaveLength(2);
    expect(makeActionStore(stateDir).read().dispatches).toHaveLength(1);
  });
});
