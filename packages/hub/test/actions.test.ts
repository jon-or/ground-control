import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { DEFAULT_SESSION_SCOPE } from '@ground-control/core';
import { LINK_GRACE_MS } from '@ground-control/automation';
import { bootstrapDirOf } from '@ground-control/core';
import type {
  ActionHistoryView,
  ActionRow,
  AgentAdapter,
  BranchPullRequestReading,
  BranchTipReading,
  ContainsReading,
  ContextReading,
  DispatchInput,
  DispatchResult,
  HistoricalSession,
  HubConfig,
  HubMessage,
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
import { makeActionHistoryStore, makeActionStore } from '../src/actionStore.js';
import { makeIssueStore } from '../src/issueStore.js';
import { makeStatusStore } from '../src/statusStore.js';
import { actionReportPathOf, bundlePathOf } from '../src/paths.js';
import { REPORT_FILE_LIMIT } from '../src/report.js';
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

/** The card's merge on a pull request based on another branch: from that base (R39). */
const STACKED: ActionRow = { action: 'merge', qualifier: 'stacked', prompt: '/or-merge {base}', automatic: true };

/** The merge of the default branch into that base, in the base's worktree, as the base's pull request. */
const BASE_ROW: ActionRow = { action: 'merge', qualifier: 'base', prompt: '/or-merge {base} {branch} {issue}', automatic: false };

const PARENT = '17000-parent-feature';
const BASE_KEY = `merge:example-org/example-repo#${PARENT}`;
const MASTER_TIP = 'd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0';
const PARENT_TIP = 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';

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
  /** Per-issue changes to `pr`, for boards with more than one card. */
  prs: Record<number, Partial<TriagePullRequest>>;
  /** The issue comments the fresh read answers. */
  comments: TriageContext['comments'];
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
  /** Set to make lane writes fail, as a locked lanes.json does. */
  lanesBroken: boolean;
  /** Source reads of the assigned issues so far. */
  issueReads: number;
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
  /** The default branch's tip the fresh read gives; null gives none, so a merge settles on its report alone. */
  defaultOid: string | null;
  /** What GitHub answers for the open pull requests whose head is a branch (R39). */
  branchPulls: (branch: string) => BranchPullRequestReading;
  /** Whether GitHub shows `branch` containing `sha`: how a merge's push is checked (R39). */
  contains: (sha: string, branch: string) => ContainsReading;
  /** Each containment check asked, as `sha...branch`. */
  compared: string[];
  tips: Record<string, string>;
  /** What a run wrote about itself, at the path of run `key`. */
  reportAt(key: string, body: unknown): void;
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

  it('settles on a QA reading where the table has a row for it', () => {
    const failure = { state: 'done', action: 'qa-failure', qualifier: null, target: null, detail: 'Step 3 failed on Test-C.', at: 7, stale: false } as const;
    const question = { state: 'done', action: 'qa-question', qualifier: null, target: null, detail: 'What does "as before" mean?', at: 7, stale: false } as const;
    const qaTable = [{ action: 'qa-failure', qualifier: null, prompt: '/address-qa {issue}', automatic: false }] as const;

    expect(readingOf(card({ triage: failure }), qaTable)).toEqual({ action: 'qa-failure', qualifier: null, settled: true, at: 7 });
    expect(readingOf(card({ triage: question }), qaTable)).toEqual({ action: null, qualifier: null, settled: true, at: 7 });
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
    prs: {},
    comments: [],
    classified: { action: 'merge', detail: 'Behind master.', target: null },
    reads: [],
    readThrows: false,
    contextHolding: null,
    permissions: ['manual', 'acceptEdits', 'auto', 'dontAsk', 'plan', 'bypassPermissions'],
    storeBroken: false,
    lanesBroken: false,
    issueReads: 0,
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
    report: (body: unknown) => control.reportAt(control.key(), body),
    reportAt: (key: string, body: unknown) => {
      const path = actionReportPathOf(stateDir, key);
      mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
      writeFileSync(path, JSON.stringify(body));
    },
    defaultOid: null,
    branchPulls: () => ({ pullRequests: [], failure: null }),
    contains: () => ({ contained: true, failure: null }),
    compared: [],
    tips: {},
    cardAction: () => control.snapshot().lanes.flatMap((lane) => lane.cards)[0]?.action,
    key: () => control.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key,
    cardCheckout: () => control.snapshot().lanes.flatMap((lane) => lane.cards)[0]?.checkout,
  };

  const source: WorkSource = {
    id: 'github',
    displayName: 'GitHub',
    configure: () => null,
    read: async (): Promise<SourceReading> => {
      control.issueReads += 1;

      return {
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
      };
    },
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
        comments: control.comments,
        pullRequest: control.pr === null ? null : pullRequest({ ...control.pr, ...control.prs[card.number] }),
        assignees: card.assignees,
        logins: ['dev-1'],
        repository: 'example-org/example-repo',
        defaultBranch: 'master',
        ...(control.defaultOid === null ? {} : { defaultOid: control.defaultOid }),
      };

      return { context, failure: null };
    },
    readBranchPullRequests: async (_repository, branch) => control.branchPulls(branch),
    readBranchTip: async (_repository, branch): Promise<BranchTipReading> => {
      const sha = control.tips[branch];

      return sha === undefined
        ? { sha: null, failure: { subject: 'github', kind: 'query-failed', message: `no tip for ${branch}`, remedy: 'r' } }
        : { sha, failure: null };
    },
    contains: async (_repository, sha, branch) => {
      control.compared.push(`${sha}...${branch}`);

      return control.contains(sha, branch);
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
  const lanes = makeLaneStore(stateDir);

  control.hub = new Hub({
    clock: clock.clock,
    watch: () => ({ dispose: () => undefined }),
    home,
    stateDir,
    registries: { agents: [dispatching], hosts: [], sources: [source] },
    lanes: { read: (statuses) => lanes.read(statuses), write: (memory) => (control.lanesBroken ? false : lanes.write(memory)) },
    marks: makeMarkStore(stateDir),
    triage: makeTriageStore(stateDir),
    checkouts: makeCheckoutStore(stateDir), worktrees: makeWorktreeStore(stateDir),
    // Reads still work; only the write fails, which is the shape a locked or full disk actually takes.
    actions: { read: () => store.read(), write: (state) => (control.storeBroken ? false : store.write(state)) },
    actionHistory: makeActionHistoryStore(stateDir),
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
    debrief: { enabled: false, directory: '', promptPath: '', codexScript: '' },
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

/**
 * A card whose pull request is based on another open pull request of the developer's, #4000 on `17000-parent-feature`,
 * which a worktree beside the card's has checked out. GitHub shows the base lacking master until a test says otherwise.
 */
function stackedHarness(
  over: Partial<HubConfig['actions']> = { table: [STACKED, BASE_ROW] },
  cards: IssueCard[] = [issue()],
  sessions: (baseWorktree: string) => Session[] = () => [],
): Control & { baseWorktree: string } {
  const baseWorktree = worktreeAt(CHECKOUT, join(home, PARENT).replace(/\\/g, '/'), PARENT);
  const control = harness(over, cards, sessions(baseWorktree));

  // Configured, as a developer's clone is: the card's worktree is then found without a session's history to lead to it.
  control.hub.configure({ ...config(over), repositoryRoots: [CHECKOUT] });
  control.pr = { baseRefName: PARENT };
  control.defaultOid = MASTER_TIP;
  control.tips = { [PARENT]: PARENT_TIP };
  control.branchPulls = (branch) => ({
    pullRequests: branch === PARENT
      ? [{ number: 4000, author: 'dev-1', isDraft: false, baseRefName: 'master', headRefName: PARENT, headOid: PARENT_TIP, issueNumber: null, crossRepository: false }]
      : [],
    failure: null,
  });
  control.contains = () => ({ contained: false, failure: null });

  return Object.assign(control, { baseWorktree });
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
    // A prompt that never names the result file still reports, or every unattended run settles as blocked.
    expect(control.dispatched[0]?.prompt).toContain(
      `node '${bundlePathOf(home).replace(/\\/g, '/')}' result <outcome> --to '${actionReportPathOf(stateDir, control.key())}'`,
    );
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

  /** The one rule that keeps a merge that blocked from being started over on every pass. */
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

  /** A tester's new comment changes no commit, yet it is new input for a QA run that did not complete (R39). */
  it('runs a blocked QA action again after a tester comments, and not after the developer does', async () => {
    const control = harness({ table: [{ action: 'qa-failure', qualifier: null, prompt: '/address-qa {issue} result:{resultPath}', automatic: true }] });
    control.classified = { action: 'qa-failure', detail: 'Step 3 failed on Test-C.', target: null };
    const at = (offset: number) => new Date(control.clock.clock.now() + offset).toISOString();
    control.comments = [{ author: 'tester-1', authorName: null, authorAssociation: null, body: 'Step 3 fails.', createdAt: at(-60_000) }];
    watch(control);
    await control.pass();
    await control.appear();
    control.report({ outcome: 'blocked', detail: 'Which step 3 result is expected?' });
    await control.finish();

    expect(control.dispatched).toHaveLength(1);

    control.comments = [...control.comments, { author: 'dev-1', authorName: null, authorAssociation: null, body: 'Looking.', createdAt: at(0) }];
    await control.pass(PAST_GATE);

    expect(control.dispatched).toHaveLength(1);

    // GitHub's clock two hours ahead of the hub's: the comment reopens the run once, not on every pass.
    control.comments = [...control.comments, { author: 'tester-1', authorName: null, authorAssociation: null, body: 'It should save.', createdAt: at(7_200_000) }];
    await control.pass(PAST_GATE);

    expect(control.dispatched).toHaveLength(2);

    await control.appear();
    control.report({ outcome: 'blocked', detail: 'Still unclear.' });
    await control.finish();
    control.comments = [...control.comments, { author: 'github-project-automation[bot]', authorName: null, authorAssociation: null, body: 'Moved.', createdAt: at(7_300_000) }];
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

    expect(control.cardAction()).toMatchObject({ state: 'done', action: 'merge', qualifier: 'upstream', outcome: 'blocked' });

    control.classified = { action: 'fix-checks', detail: 'The build is red.', target: null };
    control.hub.receive({ id: 'board-1' }, { type: 'retriage', key: control.key() });
    await control.settle();

    expect(control.cardAction()).toBeUndefined();
  });

  /**
   * A successful merge changes its own head commit. Completed runs must block automatic repeats even after that
   * change, until the card is read again after the run.
   */
  it('never dispatches again once a run completed, however far the branch has moved, until the card’s status changes', async () => {
    // The harness issue's status change is dated after the fake clock; this one moved before the run.
    const control = harness({}, [issue({ statusChangedAt: '2026-08-01T09:00:00Z' })]);
    watch(control);
    await control.pass();
    await control.appear();
    control.report({ outcome: 'completed', detail: 'Merged master.' });
    await control.finish();

    expect(control.dispatched).toHaveLength(1);
    expect(control.cardAction()).toMatchObject({ outcome: 'completed' });

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
    control.report({ outcome: 'completed', detail: 'Merged master again.' });
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
    expect(control.dispatched[0]?.prompt).toContain('The outcome is completed once the work is complete');
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
    const control = stackedHarness();
    control.contains = () => ({ contained: true, failure: null });
    watch(control);
    await control.pass();

    expect(control.dispatched).toHaveLength(1);
    expect(control.dispatched[0]).toMatchObject({ name: 'ground-control · merge stacked · #17198', cwd: CHECKOUT });
    expect(control.dispatched[0]?.prompt).toMatch(/^\/or-merge 17000-parent-feature\n\n/);
  });

  /** A row for any merge would merge into the base with the card's prompt; only a row naming the base merge may. */
  it('refuses a merge based on another branch where no Merge · base row is set', async () => {
    const control = stackedHarness({ table: [STACKED] });
    watch(control);
    await control.pass();

    expect(control.dispatched).toHaveLength(0);
    expect(control.cardAction()).toMatchObject({
      state: 'refused',
      reason: '17198-channel-mapping is based on 17000-parent-feature. Set a Merge · base prompt in the action table; it merges master into 17000-parent-feature before this card\'s merge.',
    });
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

/** A run awaiting approval names the prompt that performs the step; an editor click runs it (R39). */
describe('approving a run awaiting approval', () => {
  const APPROVE = '/or-push 17198';

  /** The run settles awaiting approval and its session ends, so nothing on the card is working. */
  async function awaiting(over: Record<string, unknown> = {}): Promise<Control> {
    const control = harness();
    watch(control);
    await control.pass();
    await control.appear();
    control.report({ outcome: 'awaiting-approval', detail: 'Merged locally; the push waits for you.', approve: APPROVE, ...over });
    await control.finish();
    control.dispatch = { shortId: '5c5c5c5c' };

    return control;
  }

  function approve(control: Control, editor = true): Promise<void> {
    control.hub.connect({ id: 'page-1', hostId: editor ? 'vscode' : null, workspaceRoot: null, residentRoutes: [], watching: true }, (message) => {
      if (message.type === 'notice') control.notices.push(message.message);
    });
    control.hub.receive({ id: 'page-1' }, { type: 'approveAction', key: control.key() });

    return control.settle();
  }

  it('offers the approval, runs the named prompt in the worktree, and reads its outcome as the approval', async () => {
    const control = await awaiting();
    const evidence = makeActionStore(stateDir).read().runs[control.key()]?.evidence;
    const counted = makeActionStore(stateDir).read().dispatches.length;

    expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'awaiting-approval', approvable: true });

    await approve(control);

    expect(control.dispatched).toHaveLength(2);
    // A click is not an automatic attempt, so the daily limit does not count it (R39).
    expect(makeActionStore(stateDir).read().dispatches).toHaveLength(counted);
    expect(control.dispatched[1]).toMatchObject({ cwd: CHECKOUT, name: 'ground-control · merge upstream · #17198' });
    expect(control.dispatched[1]?.prompt).toMatch(/^\/or-push 17198\n\nThis run is unattended\./);
    expect(control.cardAction()).toMatchObject({ state: 'running', action: 'merge', qualifier: 'upstream', approval: true });

    control.agent.sessions = [sessionOn({ sessionId: '5c5c5c5c-0000-4000-8000-000000000000' })];
    await control.pass();
    control.report({ outcome: 'completed', detail: 'Pushed 3 commits.' });
    await control.finish();

    expect(control.cardAction()).toEqual(expect.objectContaining({ state: 'done', outcome: 'completed', detail: 'Pushed 3 commits.', approval: true }));
    expect(control.cardAction()).not.toHaveProperty('approvable');
    expect(makeActionStore(stateDir).read().runs[control.key()]).toMatchObject({ approval: true, evidence });
  });

  /** A page script can click the overlay's control, so only the editor's click approves, as only it ships (R49). */
  it('dispatches once for two clicks that arrive together', async () => {
    const control = await awaiting();

    control.hub.connect({ id: 'page-1', hostId: 'vscode', workspaceRoot: null, residentRoutes: [], watching: true }, (message) => {
      if (message.type === 'notice') control.notices.push(message.message);
    });
    control.hub.receive({ id: 'page-1' }, { type: 'approveAction', key: control.key() });
    control.hub.receive({ id: 'page-1' }, { type: 'approveAction', key: control.key() });
    await control.settle();

    expect(control.dispatched).toHaveLength(2);
    expect(control.notices.at(-1)).toBe('A card action is already running.');
  });

  /** The failed record keeps the prompt, or the developer would have to run the whole action again to approve. */
  it('offers the approval again after its dispatch failed, and approves on the next click', async () => {
    const control = await awaiting();

    control.dispatch = { failure: { subject: 'claude', kind: 'dispatch-failed', message: 'claude exited.', remedy: 'r' } };
    await approve(control);

    expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'failed', approval: true, approvable: true });

    control.dispatch = { shortId: '5c5c5c5c' };
    await approve(control);

    expect(control.dispatched).toHaveLength(3);
    expect(control.cardAction()).toMatchObject({ state: 'running', approval: true });
  });

  it('refuses an approval from the GitHub page', async () => {
    const control = await awaiting();

    await approve(control, false);

    expect(control.dispatched).toHaveLength(1);
    expect(control.notices.at(-1)).toBe('Approve from the editor board: approving is your decision, which the GitHub page cannot make.');
  });

  it('offers and runs nothing where the result named no prompt', async () => {
    const control = await awaiting({ approve: undefined });

    expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'awaiting-approval' });
    expect(control.cardAction()).not.toHaveProperty('approvable');

    await approve(control);

    expect(control.dispatched).toHaveLength(1);
    expect(control.notices.at(-1)).toBe('This card has no run awaiting approval that names how to approve it.');
  });

  /** An idle session is where the developer read what they approve; one working could race the step. */
  it('refuses while a session on the card is working, and not while one is idle', async () => {
    const control = await awaiting();
    const ID = '7e7e7e7e-0000-4000-8000-000000000000';

    control.agent.sessions = [sessionOn({ agent: 'claude', sessionId: ID, attachId: '7e7e7e7e' })];
    control.agent.phases.set(ID, { phase: 'running', since: 1, at: 1, event: 'UserPromptSubmit' });
    await control.pass();
    await approve(control);

    expect(control.dispatched).toHaveLength(1);
    expect(control.notices.at(-1)).toBe('A session on this card is still working or waiting.');

    // A session waiting on a question has not finished what the developer would approve.
    control.agent.phases.set(ID, { phase: 'waiting', since: 2, at: 2, event: 'Notification' });
    await control.pass();
    await approve(control);

    expect(control.dispatched).toHaveLength(1);

    control.agent.phases.set(ID, { phase: 'idle', since: 2, at: 2, event: 'Stop' });
    await control.pass();
    await approve(control);

    expect(control.dispatched).toHaveLength(2);
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

    control.report({ outcome: 'completed', detail: 'Merged master, tests green.' });
    await control.finish();

    expect(control.cardAction()).toMatchObject({
      state: 'done',
      outcome: 'completed',
      detail: 'Merged master, tests green.',
    });
  });

  /** Finished background sessions remain listed (M33). Outcome detection must use finished state, not presence alone. */
  it('settles a run whose session is still listed once the agent calls it finished', async () => {
    const control = harness();
    watch(control);
    await control.pass();
    await control.appear();

    control.report({ outcome: 'completed', detail: 'Merged master, tests green.' });
    control.agent.sessions = [sessionOn({ sessionId: '46af2ac8-f232-4406-8e8f-2579df5eb08f', finished: true })];
    await control.pass();

    expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'completed' });
  });

  /** A run ending on a question stays listed as blocked, not finished (M33); the result it wrote settles it. */
  it('settles a run whose session is still live once it writes its result', async () => {
    const control = harness();
    watch(control);
    await control.pass();
    await control.appear();
    await control.pass();

    expect(control.cardAction()).toMatchObject({ state: 'running' });

    control.report({ outcome: 'awaiting-approval', detail: 'Review written; not posted.' });
    await control.pass();

    expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'awaiting-approval', detail: 'Review written; not posted.' });
  });

  /** A background process keeps its session from resuming in an editor until it exits (M33). */
  describe('stopping the background process a settled run leaves', () => {
    const ID = '46af2ac8-f232-4406-8e8f-2579df5eb08f';

    /** The hub reads each session's phase from its agent's markers, not from the roster. */
    function on(control: Control, phase: 'running' | 'waiting' | 'idle' | null, over: Partial<Session> = {}): void {
      control.agent.sessions = [sessionOn({ agent: 'claude', sessionId: ID, attachId: '46af2ac8', ...over })];

      if (phase === null) control.agent.phases.delete(ID);
      else control.agent.phases.set(ID, { phase, since: 1, at: 1, event: 'Stop' });
    }

    async function dispatched(): Promise<Control> {
      const control = harness();
      watch(control);
      await control.pass();
      on(control, 'running');
      await control.pass();
      await control.pass();

      return control;
    }

    it('stops a run waiting on a question once its result is written, and only once', async () => {
      const control = await dispatched();
      on(control, 'waiting');
      await control.pass();

      expect(control.stopped).toEqual([]);

      control.report({ outcome: 'blocked', detail: 'Which base should the merge use?' });
      await control.pass();
      await control.pass();

      expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'blocked' });
      expect(control.stopped).toEqual(['46af2ac8']);
    });

    /** The developer approves in the session, which cannot resume in an editor while its process holds it. */
    it('stops a run awaiting approval once its turn ends', async () => {
      const control = await dispatched();
      control.report({ outcome: 'awaiting-approval', detail: 'Reply drafted; publish waits for you.' });
      on(control, 'idle');
      await control.pass();
      await control.pass();

      expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'awaiting-approval' });
      expect(control.stopped).toEqual(['46af2ac8']);
    });

    it('waits for the turn that wrote the result to end', async () => {
      const control = await dispatched();
      control.report({ outcome: 'completed', detail: 'Merged master.' });
      await control.pass();

      expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'completed' });
      expect(control.stopped).toEqual([]);

      on(control, 'idle');
      await control.pass();

      expect(control.stopped).toEqual(['46af2ac8']);
    });

    it('stops a finished run whose process is still listed', async () => {
      const control = await dispatched();
      control.report({ outcome: 'completed', detail: 'Merged master.' });
      on(control, null, { finished: true });
      await control.pass();

      expect(control.stopped).toEqual(['46af2ac8']);
    });

    it('leaves a session with no background process alone', async () => {
      const control = await dispatched();
      control.report({ outcome: 'completed', detail: 'Merged master.' });
      on(control, 'idle', { finished: true, attachId: null });
      await control.pass();

      expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'completed' });
      expect(control.stopped).toEqual([]);
    });

    it('does not repeat a stop that failed', async () => {
      const control = await dispatched();
      control.stopFails = true;
      control.report({ outcome: 'completed', detail: 'Merged master.' });
      on(control, 'idle');
      await control.pass();
      await control.pass();

      expect(control.stopped).toEqual(['46af2ac8']);
      expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'completed' });
    });
  });

  /** Use the session report to resolve the run; later repository changes do not establish its outcome. */
  it('settles from what the run wrote, without reading the pull request again', async () => {
    const control = harness();
    watch(control);
    await control.pass();
    await control.appear();

    const before = control.reads.length;
    control.report({ outcome: 'blocked', detail: 'Low-confidence conflicts in Booking.cs.' });
    await control.finish();

    expect(control.cardAction()).toMatchObject({
      state: 'done',
      outcome: 'blocked',
      detail: 'Low-confidence conflicts in Booking.cs.',
    });
    // Exclude independent triage reads when counting outcome checks.
    expect(control.reads.length).toBe(before);
  });

  /** Clear the previous report so a silent retry cannot reuse an earlier result. */
  it('does not let the last run report stand as the next run outcome', async () => {
    const control = harness();
    watch(control);
    await control.pass();
    await control.appear();
    control.report({ outcome: 'completed', detail: 'Merged master.' });
    await control.finish();

    expect(control.cardAction()).toMatchObject({ outcome: 'completed', detail: 'Merged master.' });

    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    await control.appear();
    await control.finish();

    expect(control.cardAction()).toMatchObject({
      outcome: 'blocked',
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

  it('marks runs without readable results as blocked', async () => {
    const control = harness();
    watch(control);
    await control.pass();
    await control.appear();
    await control.finish();

    expect(control.cardAction()).toMatchObject({
      state: 'done',
      outcome: 'blocked',
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
  it('keeps an excluded live session on its issue card and in automatic and manual duplicate checks', async () => {
    const control = harness({}, [issue()], [sessionOn({ checkoutRoot: CHECKOUT })]);
    control.hub.configure({ ...config(), sessionScope: { ...DEFAULT_SESSION_SCOPE, excludeDirectories: [CHECKOUT] } });
    watch(control);
    await control.pass();
    expect(control.snapshot().lanes.flatMap((lane) => lane.cards).flatMap((card) => card.sessions).map((session) => session.sessionId)).toEqual([sessionOn().sessionId]);
    expect(control.dispatched).toEqual([]);
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    expect(control.dispatched).toEqual([]);
    expect(control.notices).toContain('This card has an active session.');
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

  /** The action after a worktree run carries the click that started the chain (R50). */
  it('records the worktree run and the action after it in the history, both as the editor click that started them', async () => {
    const control = bare();
    await control.pass();
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    const run = fakeSession({ agent: 'claude', sessionId: '46af2ac8-f232-4406-8e8f-2579df5eb08f', cwd: CLONE, checkoutRoot: CLONE, branch: 'master', issueNumber: null, attachId: '46af2ac8' });
    control.agent.sessions = [run];
    await control.pass();
    control.dispatch = { shortId: '9c0d1e2f' };
    control.report({ outcome: 'completed', detail: 'Built.', worktree: made() });
    await control.pass();
    await control.settle();

    const answers: HubMessage[] = [];
    control.hub.connect({ id: 'history-1', hostId: 'vscode', workspaceRoot: null, residentRoutes: [], watching: true }, (message) => answers.push(message));
    control.hub.receive({ id: 'history-1' }, { type: 'readActionHistory' });
    const history = answers.find((message) => message.type === 'actionHistory');

    expect(control.dispatched).toHaveLength(2);
    expect(history?.type === 'actionHistory' && history.entries.map((entry) => [entry.action, entry.next ?? null, entry.trigger, entry.outcome, entry.title]))
      .toEqual([
        ['merge', null, 'editor', 'running', 'Channel mapping drops rows past the first page'],
        ['create-worktree', 'merge', 'editor', 'completed', 'Channel mapping drops rows past the first page'],
      ]);
  });

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

    expect(prompt).toContain(`result <outcome> --to '${actionReportPathOf(stateDir, control.key())}'`);
    expect(prompt).toContain("completed, with --worktree '<absolute path of the worktree>'");
  });

  it('records the worktree the run reports, then starts the action in it as the same attempt', async () => {
    const control = bare();
    await control.pass();
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    await control.appear();

    const worktree = made();
    control.report({ outcome: 'completed', detail: 'Built.', worktree });
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
    control.report({ outcome: 'completed', detail: 'Built.', worktree });
    // Claude keeps a finished background session listed (M33); it is not active work that blocks the action.
    control.agent.sessions = [{ ...run, finished: true }];
    await control.pass();
    await control.settle();

    expect(cards()[0]?.sessions.map((s) => s.sessionId)).toEqual([run.sessionId]);
    expect(control.dispatched).toHaveLength(2);
    expect(control.dispatched[1]).toMatchObject({ cwd: worktree });
  });

  /** A worktree run can report before its turn ends; its session is not other work, and the action's record replaces its own (M33). */
  it('starts the action while the worktree run’s session is still listed, then stops that session’s process', async () => {
    const control = bare();
    await control.pass();
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    const run = fakeSession({ agent: 'claude', sessionId: '46af2ac8-f232-4406-8e8f-2579df5eb08f', cwd: CLONE, checkoutRoot: CLONE, branch: 'master', issueNumber: null, attachId: '46af2ac8' });
    control.agent.sessions = [run];
    control.agent.phases.set(run.sessionId, { phase: 'running', since: 1, at: 1, event: 'PreToolUse' });
    await control.pass();

    control.dispatch = { shortId: '9c0d1e2f' };
    control.report({ outcome: 'completed', detail: 'Built.', worktree: made() });
    await control.pass();
    await control.settle();

    expect(control.dispatched).toHaveLength(2);
    expect(control.stopped).toEqual([]);

    control.agent.phases.set(run.sessionId, { phase: 'idle', since: 2, at: 2, event: 'Stop' });
    await control.pass();

    expect(control.stopped).toEqual(['46af2ac8']);
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

    control.report({ outcome: 'completed', detail: 'Built.', worktree: made() });
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

  it('blocks, and starts no action, where the run reports a directory git does not register', async () => {
    const control = bare();
    await control.pass();
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    await control.appear();

    const stray = join(home, 'elsewhere').replace(/\\/g, '/');
    mkdirSync(stray);
    control.report({ outcome: 'completed', detail: 'Built.', worktree: stray });
    await control.finish();
    await control.settle();

    expect(control.dispatched).toHaveLength(1);
    expect(card(control).worktree).toBeUndefined();
    expect(control.cardAction()).toMatchObject({ state: 'done', action: 'merge', qualifier: 'upstream', outcome: 'blocked', detail: `The run reported ${stray}, which git does not register as a working tree.` });
    expect(card(control).creation).toMatchObject({ state: 'done', outcome: 'blocked' });
  });

  it('blocks where the run ends without reporting a worktree', async () => {
    const control = bare();
    await control.pass();
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    await control.appear();
    await control.finish();

    expect(control.dispatched).toHaveLength(1);
    expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'blocked', detail: 'The run ended without reporting a worktree.' });
  });

  it('refuses a worktree of another repository, however the run got there', async () => {
    const control = bare();
    await control.pass();
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    await control.appear();

    const other = cloneAt(join(home, 'other').replace(/\\/g, '/'), '17198-channel-mapping', 'https://github.com/example-org/other.git');
    control.report({ outcome: 'completed', detail: 'Built.', worktree: other });
    await control.finish();

    expect(control.dispatched).toHaveLength(1);
    expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'blocked', detail: `The run reported ${other}, which is not a working tree of example-org/example-repo.` });
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
    control.report({ outcome: 'completed', detail: 'Built.', worktree });
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
    control.report({ outcome: 'completed', detail: 'Built.', worktree: made() });
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

  // A completed worktree run must not read as the action having run, or the automatic path would never start it.
  it('starts the automatic action after a worktree made on its own, as a new attempt', async () => {
    const control = bare();
    await control.pass();
    control.hub.receive({ id: 'board-1' }, { type: 'createWorktree', key: control.key() });
    await control.settle();
    await control.appear();
    const worktree = made();
    control.report({ outcome: 'completed', detail: 'Built.', worktree });
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
    control.report({ outcome: 'completed', detail: 'Built.', worktree });
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
    control.report({ outcome: 'completed', detail: 'Built.', worktree: made() });
    await control.finish();
    await control.settle();

    expect(control.dispatched).toHaveLength(2);
    expect(makeActionStore(stateDir).read().dispatches).toHaveLength(1);
  });
});

/** A merge on a pull request based on another branch merges the default branch into that base first, in its worktree (R39). */
describe('a merge based on another branch', () => {
  const BASE_SESSION = '46af2ac8-f232-4406-8e8f-2579df5eb08f';

  /** The base merge's session, in the base's worktree, appears. */
  function baseAppears(control: Control & { baseWorktree: string }): Promise<void> {
    control.agent.sessions = [
      sessionOn({ agent: 'claude', sessionId: BASE_SESSION, cwd: control.baseWorktree, checkoutRoot: control.baseWorktree, branch: PARENT, issueNumber: 17000 }),
    ];

    return control.pass();
  }

  /** The base merge's session appears, reports, and ends. */
  async function baseMerged(control: Control & { baseWorktree: string }, detail = 'Merged master into 17000.'): Promise<void> {
    await baseAppears(control);
    control.reportAt(BASE_KEY, { outcome: 'completed', detail });
    control.dispatch = { shortId: '5c5c5c5c' };
    await control.finish();
    await control.pass();
  }

  it('merges master into the base in its worktree first, as the base pull request', async () => {
    const control = stackedHarness();
    watch(control);
    await control.pass();

    expect(control.dispatched).toHaveLength(1);
    expect(control.dispatched[0]).toMatchObject({ name: 'ground-control · merge base · #17000', cwd: control.baseWorktree });
    expect(control.dispatched[0]?.prompt).toMatch(/^\/or-merge master 17000-parent-feature 17000\n\n/);
    expect(control.cardAction()).toMatchObject({
      state: 'running',
      action: 'merge',
      qualifier: 'stacked',
      stage: 'base',
      detail: 'Merging master into 17000-parent-feature first.',
    });
  });

  it('runs the card\'s merge from the base once GitHub shows master in it', async () => {
    const control = stackedHarness();
    watch(control);
    await control.pass();
    control.contains = () => ({ contained: true, failure: null });
    await baseMerged(control);

    expect(control.compared).toContain(`${MASTER_TIP}...${PARENT}`);
    expect(control.dispatched).toHaveLength(2);
    expect(control.dispatched[1]).toMatchObject({ name: 'ground-control · merge stacked · #17198', cwd: CHECKOUT });
    expect(control.dispatched[1]?.prompt).toMatch(/^\/or-merge 17000-parent-feature\n\n/);
    expect(control.cardAction()).toMatchObject({ state: 'running', qualifier: 'stacked' });
    expect(control.cardAction()).not.toHaveProperty('stage');
  });

  it('blocks, and runs nothing after, where the base run reports completion but GitHub shows no push', async () => {
    const control = stackedHarness();
    watch(control);
    await control.pass();
    await baseMerged(control);

    expect(control.dispatched).toHaveLength(1);
    expect(control.cardAction()).toMatchObject({
      state: 'done',
      outcome: 'blocked',
      detail: '17000-parent-feature: The run reported completion, but 17000-parent-feature does not contain master at d0d0d0d.',
    });
  });

  /** Every card on the base would otherwise start the same merge while the first waits for the developer (R39). */
  it('does not merge into the base again on its own while the last merge of its tips awaits approval', async () => {
    const control = stackedHarness();
    watch(control);
    await control.pass();
    await baseAppears(control);
    control.reportAt(BASE_KEY, { outcome: 'awaiting-approval', detail: 'Merged locally; the push waits for you.' });
    await control.finish();

    expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'awaiting-approval', detail: '17000-parent-feature: Merged locally; the push waits for you.' });

    await control.pass(PAST_GATE);

    expect(control.dispatched).toHaveLength(1);
    expect(Object.values(makeActionStore(stateDir).read().refusals)).toEqual([expect.objectContaining({
      kind: 'base-blocked',
      message: 'Merging master into 17000-parent-feature is awaiting approval: Merged locally; the push waits for you. It is not retried automatically until either branch changes.',
    })]);
  });

  it('runs only the card\'s merge where the base already has master', async () => {
    const control = stackedHarness();
    control.contains = () => ({ contained: true, failure: null });
    watch(control);
    await control.pass();

    expect(control.dispatched).toHaveLength(1);
    expect(control.dispatched[0]).toMatchObject({ name: 'ground-control · merge stacked · #17198', cwd: CHECKOUT });
  });

  it('merges into a base once for two cards based on it, then runs each card\'s merge', async () => {
    const other = issue({ number: 17199, title: 'Second card', url: 'https://github.com/example-org/example-repo/issues/17199' });
    const control = stackedHarness({ table: [STACKED, BASE_ROW], concurrency: 3 }, [issue(), other]);
    const second = cloneAt(join(home, '17199-second').replace(/\\/g, '/'), '17199-second');

    control.history.push({ ...control.history[0]!, sessionId: 'old00000-0000-4000-8000-000000000002', cwd: second, branch: '17199-second', issueNumber: 17199 });
    control.prs = { 17199: { number: 4022, headRefName: '17199-second' } };
    watch(control);
    await control.pass();
    await control.pass();

    const bases = () => control.dispatched.filter((input) => input.name.includes('merge base'));
    const waiting = control.snapshot().lanes.flatMap((lane) => lane.cards).find((card) => card.issueNumber === 17199);

    expect(bases()).toHaveLength(1);
    expect(waiting?.action).toMatchObject({ state: 'refused', reason: expect.stringMatching(/into 17000-parent-feature.* This card is read again when it finishes\.$/) });

    control.contains = () => ({ contained: true, failure: null });
    await baseMerged(control);
    await control.pass();

    expect(bases()).toHaveLength(1);
    expect(control.dispatched.map((input) => input.name).sort()).toEqual([
      'ground-control · merge base · #17000',
      'ground-control · merge stacked · #17198',
      'ground-control · merge stacked · #17199',
    ]);
  });

  /** The base merge's session runs in the base worktree; a card arriving then waits on the merge, not on the session. */
  it('holds a second card on a base being merged, and reads it again once that merge ends', async () => {
    const other = issue({ number: 17199, title: 'Second card', url: 'https://github.com/example-org/example-repo/issues/17199' });
    const control = stackedHarness({ table: [STACKED, BASE_ROW], concurrency: 3 }, [issue()]);
    const second = cloneAt(join(home, '17199-second').replace(/\\/g, '/'), '17199-second');

    control.history.push({ ...control.history[0]!, sessionId: 'old00000-0000-4000-8000-000000000002', cwd: second, branch: '17199-second', issueNumber: 17199 });
    control.prs = { 17199: { number: 4022, headRefName: '17199-second' } };
    watch(control);
    await control.pass();
    await baseAppears(control);

    control.cards = [issue(), other];
    await control.pass();

    const waiting = () => control.snapshot().lanes.flatMap((lane) => lane.cards).find((card) => card.issueNumber === 17199)?.action;

    expect(control.dispatched).toHaveLength(1);
    expect(waiting()).toMatchObject({ state: 'refused', reason: 'Merging master into 17000-parent-feature for #17198. This card is read again when it finishes.' });

    control.contains = () => ({ contained: true, failure: null });
    control.reportAt(BASE_KEY, { outcome: 'completed', detail: 'Merged.' });
    control.dispatch = { shortId: '5c5c5c5c' };
    await control.finish();
    await control.pass();
    await control.pass();

    expect(control.dispatched.map((input) => input.name).sort()).toEqual([
      'ground-control · merge base · #17000',
      'ground-control · merge stacked · #17198',
      'ground-control · merge stacked · #17199',
    ]);
  });

  it('reads a card held back by a merge that failed to start again, and then waits out its gate', async () => {
    const other = issue({ number: 17199, title: 'Second card', url: 'https://github.com/example-org/example-repo/issues/17199' });
    const control = stackedHarness({ table: [STACKED, BASE_ROW], concurrency: 3 }, [issue(), other]);
    const second = cloneAt(join(home, '17199-second').replace(/\\/g, '/'), '17199-second');

    control.history.push({ ...control.history[0]!, sessionId: 'old00000-0000-4000-8000-000000000002', cwd: second, branch: '17199-second', issueNumber: 17199 });
    control.prs = { 17199: { number: 4022, headRefName: '17199-second' } };
    control.dispatch = { failure: { subject: 'claude', kind: 'dispatch-failed', message: 'claude exited.', remedy: 'r' } };
    watch(control);
    await control.pass();

    // The first card's start failed and freed the base; the second, held back, was read again and tried it.
    expect(control.dispatched.map((input) => input.name)).toEqual(['ground-control · merge base · #17000', 'ground-control · merge base · #17000']);

    await control.pass();

    expect(control.dispatched).toHaveLength(2);
  });

  /** The base merge completed against the tip it started from; what master gained since comes with the next request. */
  it('runs the card\'s merge from the base where master moved while the base merge ran', async () => {
    const control = stackedHarness();
    watch(control);
    await control.pass();
    control.defaultOid = 'e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2';
    control.contains = (sha) => ({ contained: sha !== 'e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2', failure: null });
    control.tips = { [PARENT]: 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3' };
    await baseMerged(control);

    expect(control.dispatched.map((input) => input.name)).toEqual(['ground-control · merge base · #17000', 'ground-control · merge stacked · #17198']);
    expect(makeActionStore(stateDir).read().runs['issue:17198']?.merge).toMatchObject({ source: PARENT, sourceSha: 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3' });
  });

  it('runs a test merge on a stacked pull request after its base merge, and checks the test branch', async () => {
    const control = stackedHarness({ table: [{ ...STACKED, qualifier: 'test' }, BASE_ROW] });
    control.classified = { action: 'merge', detail: 'Merge into test.', target: 'Test-B-may-1' };
    control.tips = { [PARENT]: PARENT_TIP, '17198-channel-mapping': '9ab0cde1111111111111111111111111111111ff' };
    watch(control);
    await control.pass();
    control.contains = () => ({ contained: true, failure: null });
    await baseMerged(control);

    expect(control.dispatched).toHaveLength(2);
    expect(control.dispatched[1]).toMatchObject({ name: 'ground-control · merge test · #17198', cwd: CHECKOUT });

    control.agent.sessions = [sessionOn({ sessionId: '5c5c5c5c-0000-4000-8000-000000000000' })];
    await control.pass();
    control.report({ outcome: 'completed', detail: 'Merged into test.' });
    await control.finish();
    await control.settle();

    expect(control.compared.slice(-2)).toEqual([`${PARENT_TIP}...17198-channel-mapping`, '9ab0cde1111111111111111111111111111111ff...Test-B-may-1']);
    expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'completed', detail: 'Merged into test.' });
  });
  it('does not retry a blocked base merge automatically on the same tips, but does on a click', async () => {
    const control = stackedHarness();
    watch(control);
    await control.pass();
    await baseMerged(control);
    await control.pass(PAST_GATE);
    await control.pass(PAST_GATE);

    expect(control.dispatched).toHaveLength(1);

    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();
    await control.settle();

    expect(control.dispatched).toHaveLength(2);
    expect(control.dispatched[1]).toMatchObject({ name: 'ground-control · merge base · #17000' });
  });

  it('does not merge into the base while the base\'s own card is merging into it', async () => {
    const parent = issue({ number: 17000, title: 'Parent', url: 'https://github.com/example-org/example-repo/issues/17000' });
    const control = stackedHarness({ table: [UPSTREAM, STACKED, BASE_ROW], concurrency: 3 }, [parent]);

    control.history.push({ ...control.history[0]!, sessionId: 'old00000-0000-4000-8000-000000000003', cwd: control.baseWorktree, branch: PARENT, issueNumber: 17000 });
    control.prs = { 17000: { number: 4000, baseRefName: 'master', headRefName: PARENT } };
    watch(control);
    await control.pass();

    expect(control.dispatched).toHaveLength(1);
    expect(control.dispatched[0]).toMatchObject({ name: 'ground-control · merge upstream · #17000' });

    control.cards = [parent, issue()];
    await control.pass();
    await control.pass();

    const stacked = control.snapshot().lanes.flatMap((lane) => lane.cards).find((card) => card.issueNumber === 17198);

    expect(control.dispatched).toHaveLength(1);
    expect(stacked?.action).toMatchObject({
      state: 'refused',
      reason: 'Merging master into 17000-parent-feature for #17000. This card is read again when it finishes.',
    });
  });

  it.each([
    ['the base pull request is not the developer\'s', { author: 'someone-else' }, '17000-parent-feature belongs to pull request #4000, which is not yours.'],
    ['the base pull request is a draft', { isDraft: true }, '17000-parent-feature belongs to pull request #4000, which is a draft.'],
    ['the base is itself stacked', { baseRefName: '16000-grandparent' }, '17000-parent-feature is itself based on 16000-grandparent; merge that chain by hand.'],
  ])('refuses where %s', async (_name, change, reason) => {
    const control = stackedHarness();
    const found = control.branchPulls(PARENT);

    control.branchPulls = () => ({ pullRequests: found.pullRequests!.map((pr) => ({ ...pr, ...change })), failure: null });
    watch(control);
    await control.pass();

    expect(control.dispatched).toHaveLength(0);
    expect(control.cardAction()).toMatchObject({ state: 'refused', reason });
  });

  it('refuses where the base has no open pull request', async () => {
    const control = stackedHarness();
    control.branchPulls = () => ({ pullRequests: [], failure: null });
    watch(control);
    await control.pass();

    expect(control.dispatched).toHaveLength(0);
    expect(control.cardAction()).toMatchObject({ state: 'refused', reason: '17000-parent-feature has no open pull request, so the board cannot merge master into it.' });
  });

  it('refuses where GitHub cannot say whether the base has master', async () => {
    const control = stackedHarness();
    control.contains = () => ({ contained: null, failure: { subject: 'github', kind: 'offline', message: 'GitHub could not be reached.', remedy: 'r' }, missing: false });
    watch(control);
    await control.pass();

    expect(control.dispatched).toHaveLength(0);
    expect(control.cardAction()).toMatchObject({ state: 'refused', reason: 'Could not check 17000-parent-feature on GitHub: GitHub could not be reached.' });
  });

  it('refuses where no worktree has the base checked out', async () => {
    const control = stackedHarness();
    rmSync(join(CHECKOUT, '.git', 'worktrees'), { recursive: true, force: true });
    watch(control);
    await control.pass();

    expect(control.dispatched).toHaveLength(0);
    expect(control.cardAction()).toMatchObject({ state: 'refused', reason: 'No worktree has 17000-parent-feature checked out. Create one, then run this again.' });
  });

  it('refuses where a session is running in the base worktree', async () => {
    const control = stackedHarness(undefined, undefined, (root) => [
      sessionOn({ sessionId: 'c3c3c3c3-0000-4000-8000-000000000000', cwd: root, checkoutRoot: root, branch: PARENT, issueNumber: 17000 }),
    ]);
    watch(control);
    await control.pass();

    expect(control.dispatched).toHaveLength(0);
    const card = control.snapshot().lanes.flatMap((lane) => lane.cards).find((candidate) => candidate.key === 'issue:17198');

    expect(card?.action).toMatchObject({ state: 'refused', reason: `A session is running in the 17000-parent-feature worktree at ${control.baseWorktree}.` });
  });

  it('stops the base merge from the card it was started for', async () => {
    const control = stackedHarness();
    watch(control);
    await control.pass();
    await baseAppears(control);

    control.hub.receive({ id: 'board-1' }, { type: 'stopAction', key: 'issue:17198' });
    await control.settle();

    const card = control.snapshot().lanes.flatMap((lane) => lane.cards).find((candidate) => candidate.key === 'issue:17198');

    expect(control.stopped).toEqual(['46af2ac8']);
    expect(card?.action).toMatchObject({ state: 'done', outcome: 'stopped' });
  });

  it('shows the base merge\'s session on the card it was started for', async () => {
    const control = stackedHarness();
    watch(control);
    await control.pass();
    await baseAppears(control);

    const card = control.snapshot().lanes.flatMap((lane) => lane.cards).find((candidate) => candidate.key === 'issue:17198');

    expect(card?.sessions.map((session) => session.sessionId)).toContain(BASE_SESSION);
    expect(card?.checkout?.root).toBe(CHECKOUT);
  });

  it('runs none of the base card\'s actions in its worktree while the base merge runs there', async () => {
    const parent = issue({ number: 17000, title: 'Parent', url: 'https://github.com/example-org/example-repo/issues/17000' });
    const control = stackedHarness({ table: [STACKED, BASE_ROW, { action: 'address-review', qualifier: null, prompt: '/address-pr-review pr:{pr}', automatic: true }], concurrency: 3 }, [issue()]);

    control.history.push({ ...control.history[0]!, sessionId: 'old00000-0000-4000-8000-000000000003', cwd: control.baseWorktree, branch: PARENT, issueNumber: 17000 });
    control.prs = { 17000: { number: 4000, baseRefName: 'master', headRefName: PARENT } };
    watch(control);
    await control.pass();
    await baseAppears(control);

    control.cards = [parent, issue()];
    control.classified = { action: 'address-review', detail: 'Changes requested.', target: null };
    await control.pass();
    await control.pass();

    const base = control.snapshot().lanes.flatMap((lane) => lane.cards).find((card) => card.issueNumber === 17000);

    expect(control.dispatched).toHaveLength(1);
    expect(base?.action).toMatchObject({
      state: 'refused',
      reason: 'Merging master into 17000-parent-feature for #17198. This card is read again when it finishes.',
    });
  });
});

/** A merge completes once GitHub shows its push, not on the run's word alone (R39). */
describe('checking a merge\'s push', () => {
  it('completes a reported merge whose destination contains master\'s tip', async () => {
    const control = harness();
    control.defaultOid = MASTER_TIP;
    watch(control);
    await control.pass();
    await control.appear();
    control.report({ outcome: 'completed', detail: 'Merged master.' });
    await control.finish();
    await control.settle();

    expect(control.compared).toEqual([`${MASTER_TIP}...17198-channel-mapping`]);
    expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'completed', detail: 'Merged master.' });
  });

  it('blocks a reported merge whose destination lacks master\'s tip', async () => {
    const control = harness();
    control.defaultOid = MASTER_TIP;
    control.contains = () => ({ contained: false, failure: null });
    watch(control);
    await control.pass();
    await control.appear();
    control.report({ outcome: 'completed', detail: 'Merged master.' });
    await control.finish();
    await control.settle();

    expect(control.cardAction()).toMatchObject({
      state: 'done',
      outcome: 'blocked',
      detail: 'The run reported completion, but 17198-channel-mapping does not contain master at d0d0d0d.',
    });
  });

  it('keeps checking after a failed read, showing the check, and completes once GitHub answers', async () => {
    const control = harness();
    control.defaultOid = MASTER_TIP;
    control.contains = () => ({ contained: null, failure: { subject: 'github', kind: 'offline', message: 'GitHub could not be reached.', remedy: 'r' }, missing: false });
    watch(control);
    await control.pass();
    await control.appear();
    control.report({ outcome: 'completed', detail: 'Merged master.' });
    await control.finish();
    await control.settle();

    expect(control.cardAction()).toMatchObject({ state: 'running', stage: 'verifying' });

    control.contains = () => ({ contained: true, failure: null });
    await control.pass();
    await control.settle();

    expect(control.compared).toHaveLength(2);
    expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'completed' });
  });

  it('blocks once reads have failed past the result timeout counted from the report', async () => {
    const control = harness({ resultTimeoutMs: 600_000 });
    control.defaultOid = MASTER_TIP;
    control.contains = () => ({ contained: null, failure: { subject: 'github', kind: 'offline', message: 'GitHub could not be reached.', remedy: 'r' }, missing: false });
    watch(control);
    await control.pass();
    await control.appear();
    control.report({ outcome: 'completed', detail: 'Merged master.' });
    await control.finish();

    for (let i = 0; i < 4; i++) await control.pass();
    await control.settle();

    expect(control.cardAction()).toMatchObject({
      state: 'done',
      outcome: 'blocked',
      detail: 'The run reported completion, but GitHub could not be checked for its push: GitHub could not be reached.',
    });
  });

  it('blocks at once where GitHub has no such branch', async () => {
    const control = harness();
    control.defaultOid = MASTER_TIP;
    control.contains = () => ({ contained: null, failure: { subject: 'github', kind: 'not-found', message: 'GitHub has no branch 17198-channel-mapping, or no commit d0d0d0d.', remedy: 'r' }, missing: true });
    watch(control);
    await control.pass();
    await control.appear();
    control.report({ outcome: 'completed', detail: 'Merged master.' });
    await control.finish();
    await control.settle();

    expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'blocked', detail: 'GitHub has no branch 17198-channel-mapping, or no commit d0d0d0d.' });
  });

  it('checks that a named test branch contains the merged head', async () => {
    const control = harness({ table: [{ ...UPSTREAM, qualifier: 'test', prompt: '/or-merge' }] });
    control.classified = { action: 'merge', detail: 'Merge into test.', target: 'Test-B-may-1' };
    control.defaultOid = MASTER_TIP;
    control.tips = { '17198-channel-mapping': PARENT_TIP };
    control.contains = (_sha, branch) => ({ contained: branch !== 'Test-B-may-1', failure: null });
    watch(control);
    await control.pass();
    await control.appear();
    control.report({ outcome: 'completed', detail: 'Merged into test.' });
    await control.finish();
    await control.settle();

    expect(control.compared).toEqual([`${MASTER_TIP}...17198-channel-mapping`, `${PARENT_TIP}...Test-B-may-1`]);
    expect(control.cardAction()).toMatchObject({
      state: 'done',
      outcome: 'blocked',
      detail: 'The run reported completion, but Test-B-may-1 does not contain 17198-channel-mapping at b1b1b1b.',
    });
  });

  it('settles on the report alone where the default branch\'s tip was not read', async () => {
    const control = harness();
    control.contains = () => ({ contained: false, failure: null });
    watch(control);
    await control.pass();
    await control.appear();
    control.report({ outcome: 'completed', detail: 'Merged master.' });
    await control.finish();

    expect(control.compared).toEqual([]);
    expect(control.cardAction()).toMatchObject({ state: 'done', outcome: 'completed' });
  });
});

/** A base merge's key holds a repository and a branch, whose sanitized forms can collide (R39). */
describe('where a run writes its result', () => {
  it('keeps a card\'s file named by its key, and gives base merges whose names would collide separate files', () => {
    expect(actionReportPathOf('/state', 'issue:17198')).toBe('/state/runs/issue-17198.json');
    expect(actionReportPathOf('/state', 'merge:a/b#c-d')).toMatch(/^\/state\/runs\/merge-[0-9a-f]{16}\.json$/);
    expect(actionReportPathOf('/state', 'merge:a/b#c-d')).not.toBe(actionReportPathOf('/state', 'merge:a/b-c#d'));
    expect(actionReportPathOf('/state', 'merge:a/b#c-d')).toBe(actionReportPathOf('/state', 'merge:a/b#c-d'));
  });
});

/** A skill reports its card's stage; Review offers shipping, and entering it needs every row of evidence (R23, R49). */
describe('workflow stages', () => {
  const DEVELOP: ActionRow = { action: 'develop', qualifier: null, prompt: '/gc-plan {issue} result:{resultPath}', automatic: false };
  const SHIP: ActionRow = { action: 'ship', qualifier: null, prompt: '/gc-ship {issue} result:{resultPath}', automatic: false };
  /** The status last changed before the harness clock's first reading, so a report made now holds. */
  const CLAIMED = (): IssueCard => issue({ statusChangedAt: '2026-08-01T09:00:00Z' });
  const FILLED = '| Criterion | Evidence |\n|---|---|\n| Rows past page one | `ChannelMapping_SecondPage_KeepsRows` |\n';

  function ledger(text: string): void {
    mkdirSync(join(CHECKOUT, '.wip', '17198'), { recursive: true });
    writeFileSync(join(CHECKOUT, '.wip', '17198', 'evidence.md'), text);
  }

  function staged(control: Control): LanedCard {
    return control.snapshot().lanes.flatMap((lane) => lane.cards).find((card) => card.key === 'issue:17198')!;
  }

  it('reads a staged card as its stage’s row, whatever triage said, and as nothing where the table has no row', () => {
    const card = (stage: 'plan' | 'build' | 'review'): LanedCard => ({
      key: 'issue:17198', issue: issue(), issueNumber: 17198, sessions: [], lane: stage, returned: false, attention: null, reason: '',
      stage: { stage, note: '', at: 9, changedAt: 9, since: 9, history: [] },
      triage: { state: 'done', action: 'merge', qualifier: 'upstream', target: null, detail: '', at: 5, stale: false },
    });

    expect(readingOf(card('review'), [UPSTREAM, DEVELOP, SHIP])).toEqual({ action: 'ship', qualifier: null, settled: true, at: 9 });
    expect(readingOf(card('build'), [UPSTREAM, DEVELOP, SHIP])).toEqual({ action: 'develop', qualifier: null, settled: true, at: 9 });
    expect(readingOf(card('review'), [UPSTREAM])).toEqual({ action: null, qualifier: null, settled: true, at: 9 });
  });

  it('refuses Review until the worktree’s ledger gives every row evidence, and leaves the card where it was', async () => {
    const control = harness({ table: [MANUAL_ROW, SHIP] }, [CLAIMED()]);
    await control.pass();
    control.hub.stage({ issue: 17198, stage: 'build', note: 'self-review round 2' });

    expect(control.hub.stage({ issue: 17198, stage: 'review', note: '' })).toEqual({
      ok: false,
      reason: `No evidence ledger at ${CHECKOUT}/.wip/17198/evidence.md.`,
    });

    ledger('| Criterion | Evidence |\n|---|---|\n| Rows past page one | |\n');

    expect(control.hub.stage({ issue: 17198, stage: 'review', note: '' })).toEqual({
      ok: false,
      reason: `${CHECKOUT}/.wip/17198/evidence.md: 1 of 1 rows have no evidence: Rows past page one.`,
    });
    expect(staged(control)).toMatchObject({ lane: 'build', stage: { stage: 'build', note: 'self-review round 2' } });
  });

  it('puts an evidenced card in Review with its note, and offers shipping there', async () => {
    const control = harness({ table: [MANUAL_ROW, SHIP] }, [CLAIMED()]);
    await control.pass();
    ledger(FILLED);

    expect(control.hub.stage({ issue: 17198, stage: 'review', note: 'ready for your review' })).toEqual({
      ok: true, lane: 'review', note: 'ready for your review', pending: false,
    });
    expect(staged(control)).toMatchObject({
      lane: 'review',
      stage: { stage: 'review', note: 'ready for your review' },
      action: { state: 'available', action: 'ship', qualifier: null },
    });
  });

  it('ships only on a click, even from a row saved as automatic, with the issue and result path in the prompt', async () => {
    const control = harness({ table: [{ ...SHIP, automatic: true }] }, [CLAIMED()]);
    watch(control);
    await control.pass();
    ledger(FILLED);
    control.hub.stage({ issue: 17198, stage: 'review', note: '' });
    await control.pass(PAST_GATE);

    expect(control.dispatched).toEqual([]);

    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: 'issue:17198' });
    await control.settle();

    expect(control.dispatched).toHaveLength(1);
    expect(control.dispatched[0]!.prompt).toBe(`/gc-ship 17198 result:${actionReportPathOf(stateDir, 'issue:17198')}`);
    expect(control.dispatched[0]!.cwd).toBe(CHECKOUT);
  });

  it('lets the developer ship beside the idle session they reviewed in, but not beside one still working', async () => {
    const idle = sessionOn({ agent: 'claude' });
    const control = harness({ table: [SHIP] }, [CLAIMED()], [idle]);
    control.agent.phases.set(idle.sessionId, { phase: 'idle', since: 1, at: 1, event: 'Stop' });
    await control.pass();
    ledger(FILLED);
    control.hub.stage({ issue: 17198, stage: 'review', note: '' });

    expect(staged(control).action).toEqual({ state: 'available', action: 'ship', qualifier: null });

    control.agent.phases.set(idle.sessionId, { phase: 'running', since: 1, at: 1, event: 'PreToolUse' });
    await control.pass();

    expect(staged(control).action).toEqual({
      state: 'refused', action: 'ship', qualifier: null, reason: 'A session on this card is still working or waiting.',
    });
  });

  it('refuses a report GitHub status has already moved past, and one it could not save', async () => {
    const control = harness({ table: [DEVELOP] }, [issue({ statusChangedAt: '2026-09-30T00:00:00Z' })]);
    await control.pass();

    expect(control.hub.stage({ issue: 17198, stage: 'build', note: '' })).toEqual({
      ok: false,
      reason: 'GitHub recorded a status change for issue 17198 after this report; the card follows its status (⚒️ Dev).',
    });

    control.lanesBroken = true;

    expect(control.hub.stage({ issue: 17198, stage: 'done', note: '' })).toEqual({
      ok: false, reason: 'Ground Control could not save lanes.json, so the stage was not recorded.',
    });
  });

  it('starts nothing on its own from a stage, even where the Develop row is automatic', async () => {
    const control = harness({ table: [{ ...DEVELOP, automatic: true }] }, [CLAIMED()]);
    control.classified = { action: 'other', detail: 'Waiting.', target: null };
    await control.pass();
    control.hub.stage({ issue: 17198, stage: 'build', note: '' });
    await control.pass(PAST_GATE);

    expect(staged(control).action).toEqual({ state: 'available', action: 'develop', qualifier: null });
    expect(control.dispatched).toEqual([]);
  });

  it('records a stage for an issue no card has yet, and asks the source for it', async () => {
    const control = harness({ table: [DEVELOP] }, [CLAIMED()]);
    await control.pass();
    const read = control.issueReads;
    control.clock.advance(400_000);

    // Self-assigned on GitHub, and not read yet.
    control.cards = [CLAIMED(), issue({ number: 18000, url: 'https://github.com/example-org/example-repo/issues/18000', statusChangedAt: '2026-08-01T09:00:00Z' })];

    expect(control.hub.stage({ issue: 18000, stage: 'plan', note: 'setup' })).toEqual({ ok: true, lane: null, note: 'setup', pending: true });

    await control.settle();
    await control.settle();

    expect(control.issueReads).toBe(read + 1);
    expect(control.snapshot().lanes.flatMap((lane) => lane.cards).find((card) => card.key === 'issue:18000'))
      .toMatchObject({ lane: 'plan', stage: { stage: 'plan', note: 'setup' } });
  });
});

describe('the action history', () => {
  it('records a run the board started on its own as automatic, with how it ended', async () => {
    const control = harness();
    watch(control);
    await control.pass();

    expect(control.dispatched).toHaveLength(1);

    control.report({ outcome: 'completed', detail: 'Merged master.' });
    await control.appear();
    await control.finish();

    const answers: HubMessage[] = [];
    control.hub.connect({ id: 'history-1', hostId: 'vscode', workspaceRoot: null, residentRoutes: [], watching: true }, (message) => answers.push(message));
    control.hub.receive({ id: 'history-1' }, { type: 'readActionHistory' });
    const history = answers.find((message) => message.type === 'actionHistory');

    expect(history?.type === 'actionHistory' && history.entries.map((entry) => [entry.action, entry.qualifier, entry.trigger, entry.outcome, entry.detail]))
      .toEqual([['merge', 'upstream', 'automatic', 'completed', 'Merged master.']]);
  });

  function historyOf(control: Control): ActionHistoryView[] {
    const answers: HubMessage[] = [];
    control.hub.connect({ id: 'history-1', hostId: 'vscode', workspaceRoot: null, residentRoutes: [], watching: true }, (message) => answers.push(message));
    control.hub.receive({ id: 'history-1' }, { type: 'readActionHistory' });
    const history = answers.find((message) => message.type === 'actionHistory');

    return history?.type === 'actionHistory' ? history.entries : [];
  }

  it('records a page’s click as the browser’s', async () => {
    const control = harness({ fromBrowser: true, dailyLimit: 0 });
    watch(control, true, null);
    await control.pass();

    expect(control.dispatched).toEqual([]);

    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    expect(control.dispatched).toHaveLength(1);
    expect(historyOf(control).map((entry) => [entry.action, entry.trigger])).toEqual([['merge', 'browser']]);
  });

  it('keeps what a run reported under a restricted session scope while scope shows its card', async () => {
    const control = harness();
    watch(control);
    await control.pass();
    control.hub.configure({ ...config(), sessionScope: { ...DEFAULT_SESSION_SCOPE, excludeRepositories: ['github.com/example-org/elsewhere'] } });

    expect(historyOf(control).map((entry) => [entry.outcome, entry.detail])).toEqual([['running', `Working in ${CHECKOUT}.`]]);
  });

  it('leaves a history file it cannot read as it is, rather than replacing it with what it can see', async () => {
    const path = join(stateDir, 'action-history.json');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path, '{ not json');
    const control = harness();
    watch(control);
    await control.pass();

    expect(control.dispatched).toHaveLength(1);
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
    expect(historyOf(control)).toEqual([]);
  });
});

describe('run reports (R51)', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

  function reportIn(markdown: string): string {
    const round = join(CHECKOUT, '.wip', 'review-pr', 'round-1');
    mkdirSync(join(round, 'screenshots'), { recursive: true });
    writeFileSync(join(round, 'screenshots', 'one.png'), PNG);
    writeFileSync(join(round, 'review.md'), markdown);

    return join(round, 'review.md');
  }

  async function completedWith(control: Control, auditPath: string): Promise<void> {
    watch(control);
    await control.pass();
    control.report({ outcome: 'completed', detail: 'Merged master.', auditPath });
    await control.appear();
    await control.finish();
  }

  function read(control: Control, id: string, hostId: string | null): HubMessage | undefined {
    const answers: HubMessage[] = [];
    control.hub.connect({ id: 'reader', hostId, workspaceRoot: null, residentRoutes: [], watching: true }, (message) => answers.push(message));
    control.hub.receive({ id: 'reader' }, { type: 'readReport', id, request: 7 });

    return answers.find((message) => message.type === 'report');
  }

  async function answered(control: Control, id: string, hostId: string | null): Promise<HubMessage | undefined> {
    const answers: HubMessage[] = [];
    control.hub.connect({ id: `reader-${String(hostId)}`, hostId, workspaceRoot: null, residentRoutes: [], watching: true }, (message) => answers.push(message));
    control.hub.receive({ id: `reader-${String(hostId)}` }, { type: 'readReport', id, request: 7 });
    await new Promise((settle) => setTimeout(settle, 50));

    return answers.find((message) => message.type === 'report');
  }

  function historyOf(control: Control): ActionHistoryView[] {
    const answers: HubMessage[] = [];
    control.hub.connect({ id: 'history-1', hostId: 'vscode', workspaceRoot: null, residentRoutes: [], watching: true }, (message) => answers.push(message));
    control.hub.receive({ id: 'history-1' }, { type: 'readActionHistory' });
    const history = answers.find((message) => message.type === 'actionHistory');

    return history?.type === 'actionHistory' ? history.entries : [];
  }

  it('offers the report a completed run named, on its card and in the history, without sending its path', async () => {
    const control = harness();
    const path = reportIn('# Round 1\n\n![shot](screenshots/one.png)');
    await completedWith(control, path);

    const action = control.cardAction();
    const entry = historyOf(control)[0]!;

    expect(action?.state === 'done' && action.reportId).toBe(entry.id);
    expect(entry.reportId).toBe(entry.id);
    expect(Object.keys(entry)).not.toContain('auditPath');
    expect(JSON.stringify(control.snapshot())).not.toContain('review.md');
  });

  it('renders the report for an editor with its path, and for the browser without it', async () => {
    const control = harness();
    const path = reportIn('# Round 1\n\n![shot](screenshots/one.png)');
    await completedWith(control, path);
    const id = historyOf(control)[0]!.id;

    const editor = await answered(control, id, 'vscode');
    const browser = await answered(control, id, null);

    expect(editor).toMatchObject({ type: 'report', id, request: 7, title: 'Merge · #17198', name: 'review.md', failure: null, path });
    expect(editor?.type === 'report' && editor.failure === null && editor.html).toContain('<h1>Round 1</h1>');
    expect(editor?.type === 'report' && editor.failure === null && editor.html).toContain('src="data:image/png;base64,');
    expect(browser).toMatchObject({ type: 'report', id, name: 'review.md', failure: null });
    expect(browser).not.toHaveProperty('path');
  });

  it('gives an editor the path of a report too large to show', async () => {
    const control = harness();
    const path = reportIn('x'.repeat(REPORT_FILE_LIMIT + 1));
    await completedWith(control, path);

    expect(await answered(control, historyOf(control)[0]!.id, 'vscode')).toMatchObject({ failure: expect.stringMatching(/^The report is \d+ kB/), path });
  });

  it('gives an editor no path for a report it cannot read', async () => {
    const control = harness();
    await completedWith(control, join(CHECKOUT, '.wip', 'gone.md'));
    const refused = await answered(control, historyOf(control)[0]!.id, 'vscode');

    expect(refused).toMatchObject({ failure: 'The report file is missing or cannot be read.' });
    expect(refused).not.toHaveProperty('path');
  });

  it('refuses an id no run recorded a report under', async () => {
    const control = harness();
    await completedWith(control, reportIn('# Round 1'));

    expect(await answered(control, 'issue:1@1', 'vscode')).toMatchObject({ type: 'report', id: 'issue:1@1', failure: 'That run has no report.' });
  });

  it('keeps no report a result named by a relative path, which has nothing to resolve against', async () => {
    const control = harness();
    await completedWith(control, '.wip/review-pr/round-1/review.md');

    const action = control.cardAction();

    expect(action?.state === 'done' && action.reportId).toBeUndefined();
    expect(historyOf(control)[0]!.reportId).toBeNull();
  });

  it('offers and reads a report under a restricted session scope while it shows the card, and refuses once it does not', async () => {
    const control = harness();
    const path = reportIn('# Round 1');
    await completedWith(control, path);
    const id = historyOf(control)[0]!.id;

    control.hub.configure({ ...config(), sessionScope: { ...DEFAULT_SESSION_SCOPE, excludeRepositories: ['github.com/example-org/elsewhere'] } });

    const action = control.cardAction();

    expect(action).toMatchObject({ state: 'done', reportId: id, detail: expect.not.stringContaining('hidden by session scope') });
    expect(historyOf(control)[0]!.reportId).toBe(id);
    expect(await answered(control, id, 'vscode')).toMatchObject({ type: 'report', id, failure: null, path });

    control.cards = [];
    await control.pass();

    expect(historyOf(control)[0]).toMatchObject({ reportId: null, detail: 'Session details are hidden by session scope.' });
    // Open in editor asks the hub each time, so an editor gets no path to open once scope hides the report.
    const refused = read(control, id, 'vscode');

    expect(refused).toMatchObject({ type: 'report', failure: 'Reports are hidden by session scope.' });
    expect(refused).not.toHaveProperty('path');
  });

  it('refuses a report whose card the session scope stopped showing while it was rendered', async () => {
    const control = harness();
    await completedWith(control, reportIn('# Round 1'));
    const id = historyOf(control)[0]!.id;
    const answers: HubMessage[] = [];
    control.hub.connect({ id: 'reader', hostId: 'vscode', workspaceRoot: null, residentRoutes: [], watching: true }, (message) => answers.push(message));
    control.cards = [];

    control.hub.receive({ id: 'reader' }, { type: 'readReport', id, request: 3 });
    control.hub.configure({ ...config(), sessionScope: { ...DEFAULT_SESSION_SCOPE, excludeRepositories: ['github.com/example-org/elsewhere'] } });
    await control.pass();
    await new Promise((settle) => setTimeout(settle, 50));

    expect(answers.filter((message) => message.type === 'report')).toEqual([
      { type: 'report', id, request: 3, title: null, name: null, failure: 'Reports are hidden by session scope.' },
    ]);
  });
});

describe('a run waiting for the developer', () => {
  it('shows the run as waiting while its session waits, and as running again once it works', async () => {
    const control = harness();
    watch(control);
    await control.pass();

    const id = '46af2ac8-f232-4406-8e8f-2579df5eb08f';
    control.agent.sessions = [sessionOn({ agent: 'claude', sessionId: id, attachId: '46af2ac8' })];
    control.agent.phases.set(id, { phase: 'waiting', since: 1, at: 1, event: 'Notification' });
    await control.pass();

    expect(control.cardAction()).toMatchObject({ state: 'running', action: 'merge', stage: 'waiting' });

    control.agent.phases.set(id, { phase: 'running', since: 2, at: 2, event: 'PostToolBatch' });
    await control.pass();

    expect(control.cardAction()).toEqual({ state: 'running', action: 'merge', qualifier: 'upstream', since: expect.any(Number) });
  });

  it('does not take another session’s question on the card for the run’s', async () => {
    const control = harness();
    watch(control);
    await control.pass();

    const other = 'b7777777-0000-4000-8000-000000000000';
    control.agent.sessions = [
      sessionOn({ agent: 'claude', sessionId: '46af2ac8-f232-4406-8e8f-2579df5eb08f', attachId: '46af2ac8' }),
      sessionOn({ agent: 'claude', sessionId: other }),
    ];
    control.agent.phases.set(other, { phase: 'waiting', since: 1, at: 1, event: 'Notification' });
    await control.pass();

    expect(control.cardAction()).toEqual({ state: 'running', action: 'merge', qualifier: 'upstream', since: expect.any(Number) });
  });
});
