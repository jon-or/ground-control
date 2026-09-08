import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { makeActionStore } from '../src/actionStore.js';
import { makeIssueStore } from '../src/issueStore.js';
import { makeStatusStore } from '../src/statusStore.js';
import { actionReportPathOf } from '../src/paths.js';
import { captureLog, fakeClock, fakeSession, reportingAgent, tempHome } from './helpers.js';

let home: string;
let dispose: () => void;

beforeEach(() => {
  ({ home, dispose } = tempHome());
});

afterEach(() => dispose());

const CHECKOUT = 'd:/work/repo.worktrees/17198-channel-mapping';

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
  /** The saved sessions on the card. What gives the board a checkout when nothing is running on it. */
  history: HistoricalSession[];
  /** What the fresh read answers. A test changes this to move the card under the runner. */
  pr: Partial<TriagePullRequest> | null;
  /** What the classifier answers, which is the only thing that says a card is asking for a merge (R39). */
  classified: { action: TriageAction; detail: string };
  /** Every context read the runner made, so a gate that should have stopped one is visible. */
  reads: number[];
  /** Set to make the source seam throw rather than answer. Both seams are public and either may. */
  readThrows: boolean;
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
}

/** A session on the card, which is what a dispatched run becomes and what `checkoutOf` reads the directory from. */
function sessionOn(over: Partial<Session> = {}): Session {
  return fakeSession({ sessionId: 'a1b2c3d4-0000-4000-8000-000000000000', cwd: CHECKOUT, issueNumber: 17198, ...over });
}

/**
 * `sessions` is seeded before the hub is built rather than assigned afterwards. The hub reads the roster the moment
 * it takes a configuration, and that first read is a good one — so a session added after it would be a session the
 * board legitimately did not know about, which is a different thing from the one these tests are about.
 */
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
    // Past the source floor and inside the action read gate, so an ordinary pass re-reads the world without making
    // every card the board has answered for due again. A test that wants the gate to lapse advances `PAST_GATE`,
    // which is the only way to tell a gate that holds from one that does not.
    //
    // The settle first is what makes a pass read what the test just set up: a read already in flight is what a
    // second ask is handed, so without it the roster the board acts on is the one taken before the test spoke.
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

      // Only the runner's own read throws: triage shares this seam, and a card with no reading is a card the runner
      // never considers, which would make the test about the wrong thing.
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
    // A card the developer has worked on here before. That saved session is the only thing that gives the board a
    // checkout once nothing is running: a live one would refuse the card under R18, so the two never coincide.
    listHistory: async () => ({ sessions: control.history, failure: null }),
    dispatch: async (input: DispatchInput): Promise<DispatchResult> => {
      control.dispatched.push(input);

      return control.dispatch;
    },
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
    installActivity: false,
    triage: { enabled: true, concurrency: 2, timeoutMs: 60_000, names: {} },
    actions: {
      permissionMode: 'manual',
      concurrency: 1,
      dailyLimit: 10,
      // Longer than the step a pass takes, so a run is not called lost purely because the test clock jumped past the
      // gate. The test about a session that never appears sets its own.
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
  /** R18: never a second agent on one piece of work, and the card's own checkout is where the work happens. */
  it('runs the configured prompt in the card own checkout, under the configured permission mode', async () => {
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

  it('starts nothing at all when the action is turned off', async () => {
    const control = harness({ actions: { 'merge-upstream': { enabled: false, prompt: '/or-merge' } } });
    watch(control);
    await control.pass();

    expect(control.dispatched).toEqual([]);
    // And it never even asked GitHub: a card the board will not act on costs no read of its own. The one read is
    // triage's, which shares the seam.
    expect(control.reads).toEqual([17198]);
  });

  it('starts nothing while no board is watching, however much is due', async () => {
    const control = harness();
    watch(control, false);
    await control.pass();

    expect(control.dispatched).toEqual([]);
  });

  /**
   * The roster and the sources are read independently, so a hub's first source read lands while the roster is still
   * empty — and every card then looks like a card nothing is working on, which is the state R18 exists to refuse.
   */
  it('starts nothing on a roster it could not read', async () => {
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

  /**
   * The ceilings all live in one file: the run record saying a card is being worked on, the read gate, and the
   * ledger the daily limit counts. A board that could not write it and carried on would have none of them, and the
   * next broadcast would find the card due again with nothing spent — a dispatch loop bounded by nothing.
   */
  it('stops starting work when it cannot record what it has run, and says so', async () => {
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

    // And the developer's own press is refused too, with the reason rather than in silence.
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    expect(control.dispatched).toEqual([]);
    expect(control.notices.some((notice) => notice.includes('could not record'))).toBe(true);
  });

  /** The same breaker, tripped by a file that goes unwritable after a run has already been started. */
  it('stands down when the store fails under a run already in flight', async () => {
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
  it('says once that it has started work on the developer own code, and never again', async () => {
    const control = harness({}, [issue({ number: 17198 }), issue({ number: 17199 })]);
    watch(control);
    await control.pass();

    const said = control.notices.filter((notice) => notice.includes('starting work on'));

    expect(said).toHaveLength(1);
    expect(said[0]).toContain('may push');
    expect(said[0]).toContain('groundControl.actions');

    await control.pass(PAST_GATE);

    expect(control.notices.filter((notice) => notice.includes('starting work on'))).toHaveLength(1);
  });

  /** A notice spent on a run that never happened is the one notice the developer ever gets, spent on nothing. */
  it('says nothing when the dispatch did not start', async () => {
    const control = harness();
    control.dispatch = {
      failure: { subject: 'claude', kind: 'dispatch-missing', message: 'Claude Code was not found.', remedy: 'r' },
    };
    watch(control);
    await control.pass();

    expect(control.notices.filter((notice) => notice.includes('starting work on'))).toEqual([]);
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

    // Past the gate, so the card is due, read afresh, and refused on the evidence rather than never looked at. The
    // second read is what proves it got that far: a card the gate stopped would have cost no read at all.
    const before = control.reads.length;
    await control.pass(PAST_GATE);

    expect(control.reads.length).toBeGreaterThan(before);
    expect(control.dispatched).toHaveLength(1);

    // And once the branch moves under it, the same card is dispatched for again.
    control.pr = { headOid: 'ffffffffffffffffffffffffffffffffffffffff' };
    await control.pass(PAST_GATE);

    expect(control.dispatched).toHaveLength(2);
  });

  /**
   * The loop the head commit alone would not catch: a merge that works pushes, and that push is what moves the head.
   * So a landed run blocks the next one whatever the evidence says, or a base branch that keeps moving would have
   * the board merging every time its gate lifted, for a request somebody made once.
   */
  it('never dispatches again once a run landed, however far the branch has moved since', async () => {
    const control = harness();
    watch(control);
    await control.pass();
    await control.appear();
    control.report({ outcome: 'pushed', detail: 'Merged master.' });
    await control.finish();

    expect(control.dispatched).toHaveLength(1);
    expect(control.cardAction()).toMatchObject({ outcome: 'landed' });

    // The merge's own push, then two more gate windows on top of it.
    control.pr = { headOid: 'ffffffffffffffffffffffffffffffffffffffff' };
    await control.pass(PAST_GATE);
    control.pr = { headOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    await control.pass(PAST_GATE);

    expect(control.dispatched).toHaveLength(1);

    // The developer's own press is what asks again.
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    expect(control.dispatched).toHaveLength(2);
  });

  /**
   * Deciding whether to act needs a fresh read of GitHub, so a card the board has just answered for must not be
   * asked about again on the next loop. Built with the action on, so the runner really does the reading.
   */
  it('does not read the same card again until its gate lifts', async () => {
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

  it('holds the daily ceiling', async () => {
    const control = harness({ dailyLimit: 0 });
    watch(control);
    await control.pass();

    expect(control.dispatched).toEqual([]);
  });
});

describe('what the board refuses to act on', () => {
  it('refuses a pull request based on anything but the default branch, and says so on the card', async () => {
    const control = harness();
    control.pr = { baseRefName: '17000-parent-feature' };
    watch(control);
    await control.pass();

    expect(control.dispatched).toEqual([]);
    expect(control.cardAction()).toMatchObject({
      state: 'refused',
      reason: '#4021 merges into 17000-parent-feature, not master, so keeping it current is a chain.',
    });
  });

  /** Never guessed from a branch name — the rule R37's changes fold already holds the board to. */
  /**
   * R39: the board derives no merge, so a card carries one only because its reading asked for it. A client may post
   * any key, which is why the action is established here and not only in the control the developer presses.
   */
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
    expect(control.notices).toContain('This card is not asking for a merge.');
  });

  it('refuses a card with no checkout, without spending a read to find that out', async () => {
    const control = harness();
    control.history = [];
    watch(control);
    await control.pass();

    expect(control.dispatched).toEqual([]);
    // One read, which is triage's. The action runner shares the seam and made none of its own.
    expect(control.reads).toEqual([17198]);
    expect(control.cardAction()).toEqual({
      state: 'refused',
      action: 'merge-upstream',
      reason: 'The board has no checkout for this card, because nothing has worked on it here.',
    });
  });

  it('says an action with no prompt cannot run, rather than offering a control that could only refuse', async () => {
    const control = harness({ actions: {} });
    watch(control);
    await control.pass();

    expect(control.cardAction()).toMatchObject({
      state: 'refused',
      action: 'merge-upstream',
      reason: 'No prompt is set for merge-upstream. Set groundControl.actions to say what should run.',
    });
  });
});

describe('following a run to its end', () => {
  it('says the card is working while the session is alive, and settles it once the session goes', async () => {
    const control = harness();
    watch(control);
    await control.pass();

    expect(control.cardAction()).toMatchObject({ state: 'running', action: 'merge-upstream' });

    // The dispatched session appears on the roster under the short id the CLI printed (`mechanics.md` §33).
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

  /**
   * The run is the verdict, and GitHub is not asked. The base branch moves within minutes of a merge, so a conflict
   * somebody else landed afterwards would read as this run having failed, and a card nothing touched as fine.
   */
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
    // Triage reads on a pass of its own; what is asserted is that settling added none.
    expect(control.reads.length).toBe(before);
  });

  /**
   * The report is the verdict, so the last run's copy of it must not be readable as this one's. A second run that
   * says nothing over a first that pushed is the case: without the clear, the card would report a second landing.
   */
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
      detail: 'The run ended without saying what it did.',
    });
  });

  /** A directory where the report belongs is the shape of a path the board cannot clear: an ACL, a locked file. */
  it('starts nothing when it could not clear the last run report, since that file is the verdict', async () => {
    const control = harness();
    mkdirSync(actionReportPathOf(home, 'issue:17198'), { recursive: true });
    watch(control);
    await control.pass();

    expect(control.dispatched).toEqual([]);
    expect(control.cardAction()).toMatchObject({
      state: 'refused',
      reason: expect.stringContaining('could not tell a new run apart from the last one'),
    });
  });

  it('reports a run that said nothing as a halt rather than a landing', async () => {
    const control = harness();
    watch(control);
    await control.pass();
    await control.appear();
    await control.finish();

    expect(control.cardAction()).toMatchObject({
      state: 'done',
      outcome: 'halted',
      detail: 'The run ended without saying what it did.',
    });
  });

  /** `--bg` returns before its session registers, so a run with no session yet is open rather than lost (§33). */
  it('leaves a dispatch whose session has not appeared open, and gives up once its budget is spent', async () => {
    const control = harness({ resultTimeoutMs: 60_000 });
    watch(control);
    await control.pass(10_000);

    expect(control.cardAction()).toMatchObject({ state: 'running' });

    // The next pass is past the budget, and the session still is not there. Inside the gate, so what is asserted is
    // the run being given up on rather than the card becoming due again.
    await control.pass(100_000);

    expect(control.cardAction()).toMatchObject({
      state: 'done',
      outcome: 'failed',
      detail: 'The session the board started never appeared on the machine.',
    });
  });

  /**
   * A dispatch that never started a session spent nothing and did nothing, so it is retried — but paced by the read
   * gate rather than immediately, and never inside it (R21).
   */
  it('records a dispatch that could not be made, and tries again only once the gate lifts', async () => {
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
    expect(control.notices).toContain('That card is already being worked on.');
  });

  /**
   * Every gate a hand-asked run reaches is reached after the click has returned, so without an answer the press is
   * one that did nothing and said nothing (R25). And it must leave no stored refusal: that would close the read gate
   * on the developer's own next attempt.
   */
  it('answers a hand-asked run that refused, and gates nothing by it', async () => {
    const control = harness({ actions: {} });
    control.pr = { baseRefName: '17000-parent-feature' };
    watch(control);
    await control.pass();

    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    expect(control.notices).toContain(
      '#4021 merges into 17000-parent-feature, not master, so keeping it current is a chain.',
    );
    expect(control.dispatched).toEqual([]);

    // Asked again straight away, it is read again rather than held off by a gate its own press closed.
    const before = control.reads.length;
    control.hub.receive({ id: 'board-1' }, { type: 'runAction', key: control.key() });
    await control.settle();

    expect(control.reads.length).toBeGreaterThan(before);
  });

  /** A throw that escaped would leave the card with no run and no refusal, which reads as never having been tried. */
  it('records a seam that threw rather than answering, and does not start it again at once', async () => {
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

  /**
   * A stop that failed leaves a real agent still working in the checkout, and a card reading "Stopped" over one is
   * the board asserting a state it knows it did not reach (R24). It stays stoppable instead.
   */
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
