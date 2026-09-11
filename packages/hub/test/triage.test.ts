import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapDirOf } from '@ground-control/core';
import type {
  AgentAdapter,
  ClassifyInput,
  ClassifyResult,
  ContextReading,
  HubConfig,
  IssueCard,
  Session,
  Snapshot,
  SourceReading,
  TriageContext,
  WorkSource,
} from '@ground-control/core';
import { triageJsonSchema } from '@ground-control/board';
import { Hub } from '../src/hub.js';
import type { Registries } from '../src/registry.js';
import type { HubDeps } from '../src/hub.js';
import { makeLaneStore } from '../src/lanes.js';
import { makeMarkStore } from '../src/marks.js';
import { makeTriageStore } from '../src/triageStore.js';
import { makeCheckoutStore, makeWorktreeStore } from '../src/checkoutStore.js';
import { makeActionStore } from '../src/actionStore.js';
import { makeIssueStore } from '../src/issueStore.js';
import { makeStatusStore } from '../src/statusStore.js';
import { captureLog, fakeClock, fakeSession, reportingAgent, tempHome } from './helpers.js';

let home: string;
let stateDir: string;
let dispose: () => void;

beforeEach(() => {
  ({ home, dispose } = tempHome());
  stateDir = bootstrapDirOf(home);
});

afterEach(() => dispose());

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

function contextOf(card: IssueCard): TriageContext {
  return {
    issueNumber: card.number,
    title: card.title,
    body: 'The second page comes back empty.',
    status: card.status,
    comments: [
      { author: 'buildfriday', authorName: 'Friday', authorAssociation: 'MEMBER', body: 'Rebased.', createdAt: '2026-09-01T09:00:00Z' },
    ],
    stateEvents: [],
    logins: ['dev-1'],
    pullRequest: null,
    repository: 'example-org/example-repo',
    defaultBranch: 'master',
  };
}

interface Control {
  registries: Registries;
  hub: Hub;
  /** What the hub wrote down, message only. Reading a card spends the developer's usage, so it leaves a record. */
  logged: string[];
  clock: ReturnType<typeof fakeClock>;
  agent: ReturnType<typeof reportingAgent>;
  cards: IssueCard[];
  /** Every card key handed to the source, in order, so a second read of one card is visible. */
  contexts: number[];
  classified: ClassifyInput[];
  /** Held open so a test can watch what runs while one classification is genuinely in flight. */
  hold: (() => void) | null;
  holdContext?: (() => Promise<ContextReading>) | undefined;
  answerOnAbort?: ClassifyResult | undefined;
  answer: ClassifyResult;
  contextFailure: { kind: string; message: string } | null;
  /** Set to make the seam throw rather than classify a failure. Both seams are public and either may. */
  contextThrows: boolean;
  sourceFailed: boolean;
  snapshot(): Snapshot;
  settle(): Promise<void>;
  /** Advance beyond source throttling. Default steps also expire backoff; backoff tests use the minimum refresh step. */
  pass(advance?: number): Promise<void>;
  /** How many classifications were running at once, at the most. */
  peak(): number;
}

function harness(over: Partial<HubDeps> = {}, cards: IssueCard[] = [issue()]): Control {
  const clock = fakeClock();
  const agent = reportingAgent('claude');

  const logging = captureLog();

  const control: Control = {
    registries: { agents: [], hosts: [], sources: [] },
    hub: undefined as unknown as Hub,
    logged: logging.messages,
    clock,
    agent,
    cards,
    contexts: [],
    classified: [],
    hold: null,
    answer: { value: { action: 'develop', detail: 'Pick it up.' } },
    contextFailure: null,
    contextThrows: false,
    sourceFailed: false,
    snapshot: () => control.hub.snapshot(),
    settle: async () => {
      // Several turns: the source read resolves, then the context read, then the classification each started.
      for (let i = 0; i < 8; i++) {
        await Promise.resolve();
      }
    },
    // Advance time between refreshes to satisfy source and session throttling.
    pass: async (advance = 400_000) => {
      control.clock.advance(advance);
      await control.hub.refresh('asked');
      await control.settle();
    },
    peak: () => peak,
  };

  const source: WorkSource = {
    id: 'github',
    displayName: 'GitHub',
    configure: () => null,
    read: async (): Promise<SourceReading> =>
      control.sourceFailed
        ? { items: null, failure: { subject: 'github', kind: 'query-failed', message: 'no', remedy: 'no' }, needs: null }
        : {
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
          },
    readContext: async (card): Promise<ContextReading> => {
      control.contexts.push(card.number);

      if (control.holdContext) return control.holdContext();

      if (control.contextThrows) {
        throw new Error('the seam threw rather than classifying');
      }

      return control.contextFailure
        ? { context: null, failure: { subject: 'github', ...control.contextFailure, remedy: 'r' } }
        : { context: contextOf(card), failure: null };
    },
  };

  let live = 0;
  let peak = 0;

  const classifying: AgentAdapter = {
    ...agent.adapter,
    classify: async (input: ClassifyInput): Promise<ClassifyResult> => {
      control.classified.push(input);
      live += 1;
      peak = Math.max(peak, live);

      try {
        // Keep every classification pending to measure peak concurrency. Resolve on abort to match real process cancellation.
        if (control.hold !== null) {
          await new Promise<void>((resolve) => {
            input.signal.addEventListener('abort', () => resolve(), { once: true });
          });

          return control.answerOnAbort ?? { failure: { subject: 'claude', kind: 'classify-aborted', message: 'stood down', remedy: 'r' } };
        }

        return control.answer;
      } finally {
        live -= 1;
      }
    },
  };

  const registries = { agents: [classifying], hosts: [], sources: [source] };
  control.registries = registries;

  control.hub = new Hub({
    clock: clock.clock,
    watch: () => ({ dispose: () => undefined }),
    home,
    stateDir,
    registries,
    lanes: makeLaneStore(stateDir),
    marks: makeMarkStore(stateDir),
    triage: makeTriageStore(stateDir),
    checkouts: makeCheckoutStore(stateDir), worktrees: makeWorktreeStore(stateDir),
    actions: makeActionStore(stateDir),
    issues: makeIssueStore(stateDir),
    status: makeStatusStore(stateDir),
    settings: { read: () => null, write: () => undefined },
    log: logging.log,
    syncActivity: (_r, wanted) => ({ wanted, plan: 'up-to-date', added: 0, failure: null }),
    ...over,
  });

    control.hub.configure(hubConfig());

  return control;
}

/** What a client pushes. Every test but one runs on this; that one turns triage off. */
function hubConfig(
  triage: HubConfig['triage'] = { enabled: true, concurrency: 2, timeoutMs: 60_000, names: {} },
  statusLanes: HubConfig['statusLanes'] = {},
): HubConfig {
  return {
    agents: [{ id: 'claude', path: 'claude-cli', model: 'claude-haiku-4-5-20251001' }],
    branchIssuePattern: '^(\d+)-',
    repositoryRoots: [],
    worktree: { prompt: '' },
    hosts: {},
    logLevel: 'info',
    sources: { github: { repo: 'example-org/example-repo', logins: ['dev-1'] } },
    boardStatuses: ['⚒️ Dev', '🔍 Dev Review'],
    statusLanes,
    refreshIntervalMs: 300_000,
    sessionIntervalMs: 30_000,
    idleExitMs: 1_800_000,
    logs: { rotateBytes: 1_000_000, kept: 2, dispatchRetentionMs: 604_800_000 },
    avatar: { review: 'pull-request-author', offReview: 'assignee' },
    newSession: { prompt: '' },
    installActivity: false,
    triage,
    actions: { permissionMode: 'manual', concurrency: 1, dailyLimit: 0, fromBrowser: false, resultTimeoutMs: 1_800_000, actions: {} },
  };
}

/** A watching client, which is what R35 makes triage conditional on. */
function watch(hub: Hub, watching = true) {
  return hub.connect(
    { id: 'board', hostId: 'vscode', workspaceRoot: null, residentRoutes: [], watching },
    () => undefined,
  );
}

function triageOf(snapshot: Snapshot, key = 'issue:17198') {
  return snapshot.lanes.flatMap((lane) => lane.cards).find((card) => card.key === key)?.triage;
}

describe('reading a card that arrives', () => {
  it('reads it once, and does not read it again', async () => {
    const control = harness();
    watch(control.hub);
    await control.hub.refresh('asked');
    await control.settle();

    expect(control.contexts).toEqual([17198]);
    expect(triageOf(control.snapshot())).toMatchObject({ state: 'done', action: 'develop', detail: 'Pick it up.' });

    await control.pass();

    expect(control.contexts).toEqual([17198]);
  });

  it('reads a card again once its status has moved, which is somebody saying what it now needs', async () => {
    // Status changes trigger triage; comment updates alone do not (R38).
    const control = harness();
    watch(control.hub);
    await control.hub.refresh('asked');
    await control.settle();

    expect(control.contexts).toEqual([17198]);

    control.cards = [issue({ status: '🔍 Dev Review', statusChangedAt: '2026-09-04T13:53:36Z' })];
    await control.pass();

    expect(control.contexts).toEqual([17198, 17198]);
  });

  it('does not retriage on comments alone', async () => {
    const control = harness();
    watch(control.hub);
    await control.hub.refresh('asked');
    await control.settle();

    control.cards = [issue({ updatedAt: '2026-09-04T18:00:00Z' })];
    await control.pass();

    expect(control.contexts).toEqual([17198]);
    // It does say the reading has aged, which is the honest half of what a new comment means (R24).
    expect(triageOf(control.snapshot())).toMatchObject({ state: 'done', stale: true });
  });

  it('preserves the status-derived action in the prompt and result', async () => {
    const control = harness(
      {},
      [issue({ status: '🔍 Dev Review' })],
    );
    control.hub.configure(hubConfig(undefined, { '🔍 Dev Review': 'review' }));
    control.answer = { value: { detail: 'dev-5 sent it over for your review.' } };
    watch(control.hub);
    await control.hub.refresh('asked');
    await control.settle();

    expect(control.classified[0]?.prompt).toContain('The action is already decided: review-others');
    expect(control.classified[0]?.schema).not.toHaveProperty('properties.action');
    expect(triageOf(control.snapshot(), 'issue:17198')).toMatchObject({
      state: 'done',
      action: 'review-others',
      detail: 'dev-5 sent it over for your review.',
    });
  });

  it('asks the model for the action where the status settled none', async () => {
    const control = harness();
    watch(control.hub);
    await control.hub.refresh('asked');
    await control.settle();

    expect(control.classified[0]?.prompt).toContain('Answer with the action and the sentence.');
    expect(control.classified[0]?.schema).toHaveProperty('properties.action');
  });

  it('uses the configured model and isolated hub directory', async () => {
    const control = harness();
    watch(control.hub);
    await control.hub.refresh('asked');
    await control.settle();

    expect(control.classified[0]?.model).toBe('claude-haiku-4-5-20251001');
    expect(control.classified[0]?.path).toBe('claude-cli');
    expect(control.classified[0]?.cwd.replace(/\\/g, '/')).toBe(`${home.replace(/\\/g, '/')}/.claude/ground-control`);
    expect(control.classified[0]?.prompt).toContain('ISSUE #17198');
  });

  it.each([['classifier-model', 'classifier-model'], ['', null]] as const)('uses explicit triage model %j independently of legacy and action models', async (model, expected) => {
    const control = harness();
    const configured = hubConfig({ enabled: true, concurrency: 2, timeoutMs: 60_000, names: {}, model });
    control.hub.configure({ ...configured, actions: { ...configured.actions, model: 'coding-model' } });
    watch(control.hub);
    await control.hub.refresh('asked');
    await control.settle();

    expect(control.classified).toHaveLength(1);
    expect(control.classified[0]?.model).toBe(expected);
  });

  it('applies configured display names to the prompt', () => {
    const control = harness();
    control.hub.configure(hubConfig({ enabled: true, concurrency: 2, timeoutMs: 60_000, names: { buildfriday: 'Chris' } }));
    watch(control.hub);

    return control.hub.refresh('asked').then(control.settle).then(() => {
      expect(control.classified[0]?.prompt).toContain('Chris, member');
      expect(control.classified[0]?.prompt).not.toContain('Friday');
    });
  });

  it('shows triage in progress', async () => {
    const control = harness();
    control.hold = () => undefined;
    watch(control.hub);
    void control.hub.refresh('asked');
    await control.settle();

    expect(triageOf(control.snapshot())).toEqual({ state: 'running' });
  });

  it('skips automatic triage while unwatched', async () => {
    // Connected editors without visible boards must not trigger classification (R35).
    const control = harness();
    watch(control.hub, false);
    await control.hub.refresh('asked');
    await control.settle();

    expect(control.contexts).toEqual([]);
    expect(triageOf(control.snapshot())).toBeUndefined();
  });

  it('skips triage when disabled', async () => {
    const control = harness();
    watch(control.hub);
    control.hub.configure(hubConfig({ enabled: false, concurrency: 2, timeoutMs: 60_000, names: {} }));

    await control.hub.refresh('asked');
    await control.settle();

    expect(control.contexts).toEqual([]);
  });

  it('never reads more cards at once than it was allowed', async () => {
    const control = harness({}, [issue({ number: 1 }), issue({ number: 2 }), issue({ number: 3 }), issue({ number: 4 })]);
    control.hold = () => undefined;
    watch(control.hub);
    void control.hub.refresh('asked');
    await control.settle();
    await control.pass();

    expect(control.peak()).toBe(2);
    expect(control.classified).toHaveLength(2);
  });

  it('skips cards without issues', async () => {
    const control = harness({}, []);
    control.agent.sessions = [fakeSession({ sessionId: 'a', cwd: 'd:/work/repo', issueNumber: null })];
    watch(control.hub);
    await control.pass();

    expect(control.contexts).toEqual([]);
  });
});

describe('when a reading cannot be made', () => {
  it('leaves the card unlabelled, names the condition once, and does not try again at once', async () => {
    const control = harness({}, [issue({ number: 1 }), issue({ number: 2 })]);
    control.contextFailure = { kind: 'not-authenticated', message: 'GitHub rejected the credentials.' };
    watch(control.hub);
    await control.pass();

    const snapshot = control.snapshot();

    // The card carries a control and no words; what went wrong is the one line above the lanes.
    expect(triageOf(snapshot, 'issue:1')).toMatchObject({ state: 'failed', attempts: 1 });
    // One condition, however many cards it hit (R25).
    expect(snapshot.failures.filter((f) => f.kind === 'not-authenticated')).toHaveLength(1);

    // Far enough to re-read the sources, and nowhere near far enough to clear the minute a first failure waits.
    const asked = control.contexts.length;
    await control.pass(31_000);

    expect(control.contexts).toHaveLength(asked);
  });

  it('tries again once the wait is up', async () => {
    const control = harness();
    control.contextFailure = { kind: 'query-failed', message: 'no' };
    watch(control.hub);
    await control.hub.refresh('asked');
    await control.settle();

    expect(control.contexts).toEqual([17198]);

    control.contextFailure = null;
    await control.pass();

    expect(control.contexts).toEqual([17198, 17198]);
    expect(triageOf(control.snapshot())).toMatchObject({ state: 'done' });
  });

  it('refuses an action no build has, rather than labelling the card with it', async () => {
    const control = harness();
    control.answer = { value: { action: 'ship-it-now', detail: 'go' } };
    watch(control.hub);
    await control.hub.refresh('asked');
    await control.settle();

    expect(triageOf(control.snapshot())).toMatchObject({ state: 'failed' });
  });

  it('leaves merge classification to the model', () => {
    // Merges require written requests. Reject unsupported action labels through the response enum (R39).
    const offered = (triageJsonSchema(null) as { properties: { action: { enum: string[] } } }).properties.action.enum;

    expect(offered).toContain('merge-upstream');
    expect(offered).not.toContain('resolve-conflicts');
    expect(offered).not.toContain('land');
  });
});

describe('adapter exceptions', () => {
  it('records adapter failures and applies retry backoff', async () => {
    // Record exceptions as failures with backoff to prevent immediate retries.
    const control = harness();
    control.contextThrows = true;
    watch(control.hub);
    await control.pass();

    expect(control.contexts).toEqual([17198]);
    expect(triageOf(control.snapshot())).toMatchObject({ state: 'failed', attempts: 1 });

    await control.pass(31_000);

    expect(control.contexts).toEqual([17198]);
  });
});

describe('classification cancellation', () => {
  it('does not charge a card for a reading the developer turned off', async () => {
    const control = harness();
    control.hold = () => undefined;
    watch(control.hub);
    void control.hub.refresh('asked');
    await control.settle();

    expect(triageOf(control.snapshot())).toEqual({ state: 'running' });

    control.hub.configure(hubConfig({ enabled: false, concurrency: 2, timeoutMs: 120_000, names: {} }));
    await control.settle();

    // Do not count settings-triggered cancellations toward the retry limit.
    expect(triageOf(control.snapshot())).toBeUndefined();
    expect(control.snapshot().failures.filter((f) => f.subject === 'triage')).toEqual([]);
  });
});

describe('triage modes and automatic allowance', () => {
  const limits = { enabled: true, concurrency: 2, timeoutMs: 60_000, names: {} };
  const usagePath = () => join(stateDir, 'triage-usage.json');
  const keyOf = (control: Control) => control.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key;

  it('manual mode makes no automatic reads and permits an initial deliberate request', async () => {
    const control = harness();
    control.hub.configure(hubConfig({ ...limits, mode: 'manual' }));
    watch(control.hub);
    await control.pass();
    expect(control.contexts).toEqual([]);
    expect(control.snapshot().triage).toMatchObject({ mode: 'manual', canRequest: true });
    control.hub.receive({ id: 'board' }, { type: 'retriage', key: keyOf(control) });
    await control.settle();
    expect(control.classified).toHaveLength(1);
    expect(triageOf(control.snapshot())).toMatchObject({ state: 'done' });

    control.hub.configure(hubConfig({ ...limits, mode: 'off' }));
    await control.pass();
    control.hub.receive({ id: 'board' }, { type: 'retriage', key: keyOf(control) });
    await control.settle();
    expect(control.classified).toHaveLength(1);
    expect(control.snapshot().triage).toMatchObject({ mode: 'off', canRequest: false });
  });

  it('reserves concurrent automatic starts before reading and keeps manual requests available at the cap', async () => {
    const control = harness({}, [issue({ number: 1 }), issue({ number: 2 }), issue({ number: 3 })]);
    control.hold = () => undefined;
    control.hub.configure(hubConfig({ ...limits, mode: 'automatic', dailyLimit: 1 }));
    watch(control.hub);
    await control.pass();
    expect(control.contexts).toEqual([1]);
    expect(control.classified).toHaveLength(1);
    expect(JSON.parse(readFileSync(usagePath(), 'utf8'))).toHaveLength(1);
    expect(control.snapshot().triage?.message).toContain('limit reached');
    const second = control.snapshot().lanes.flatMap((lane) => lane.cards).find((card) => card.issueNumber === 2)!;
    control.hub.receive({ id: 'board' }, { type: 'retriage', key: second.key });
    await control.settle();
    expect(control.contexts).toEqual([1, 2]);
    expect(control.peak()).toBe(2);
    expect(JSON.parse(readFileSync(usagePath(), 'utf8'))).toHaveLength(1);
    control.hub.dispose();
    await control.settle();
  });

  /**
   * The per-card cooldown bounds one card, not a caller working through every key, so a request that did not
   * come from the developer's own editor is charged against the daily allowance (R33, R38).
   */
  it('charges a browser request against the daily allowance and refuses it at the cap', async () => {
    const control = harness({}, [issue({ number: 1 }), issue({ number: 2 })]);
    const notices: string[] = [];

    control.hub.configure(hubConfig({ ...limits, mode: 'manual', dailyLimit: 1 }));
    control.hub.connect(
      { id: 'chrome', hostId: null, workspaceRoot: null, residentRoutes: [], watching: true },
      (message) => {
        if (message.type === 'notice') notices.push(message.message);
      },
    );
    await control.pass();

    const cards = () => control.snapshot().lanes.flatMap((lane) => lane.cards);
    const first = cards().find((card) => card.issueNumber === 1)!;

    control.hub.receive({ id: 'chrome' }, { type: 'retriage', key: first.key });
    await control.settle();

    expect(control.contexts).toEqual([1]);
    expect(JSON.parse(readFileSync(usagePath(), 'utf8'))).toHaveLength(1);

    const second = cards().find((card) => card.issueNumber === 2)!;

    control.hub.receive({ id: 'chrome' }, { type: 'retriage', key: second.key });
    await control.settle();

    expect(control.contexts).toEqual([1]);
    expect(notices.at(-1)).toContain('daily limit');
    control.hub.dispose();
    await control.settle();
  });

  /** A hidden tab is not a developer asking, and R35 keeps background work off when nothing is watching. */
  it('refuses a browser request from a tab that is not watching', async () => {
    const control = harness();
    const notices: string[] = [];

    control.hub.configure(hubConfig({ ...limits, mode: 'manual' }));
    watch(control.hub);
    control.hub.connect(
      { id: 'chrome', hostId: null, workspaceRoot: null, residentRoutes: [], watching: false },
      (message) => {
        if (message.type === 'notice') notices.push(message.message);
      },
    );
    await control.pass();

    control.hub.receive({ id: 'chrome' }, { type: 'retriage', key: keyOf(control) });
    await control.settle();

    expect(control.contexts).toEqual([]);
    // Nothing was reserved, so the allowance file was never written.
    expect(existsSync(usagePath())).toBe(false);
    expect(notices.at(-1)).toBe('Open this project tab to read a card from the browser.');
    control.hub.dispose();
    await control.settle();
  });

  it('retains failed attempts across restart without retrying at an exhausted cap', async () => {
    const control = harness();
    control.answer = { failure: { subject: 'claude', kind: 'classify-failed', message: 'failed', remedy: 'retry' } };
    control.hub.configure(hubConfig({ ...limits, dailyLimit: 1 }));
    watch(control.hub);
    await control.pass();
    expect(control.classified).toHaveLength(1);
    await control.pass(3_600_000);
    expect(control.classified).toHaveLength(1);
    control.hub.dispose();

    const restarted = harness();
    restarted.hub.configure(hubConfig({ ...limits, dailyLimit: 1 }));
    watch(restarted.hub);
    await restarted.pass(3_600_000);
    expect(restarted.classified).toEqual([]);
    expect(restarted.snapshot().triage?.message).toContain('limit reached');
    await restarted.pass(24 * 60 * 60 * 1000);
    expect(restarted.classified).toHaveLength(1);
    restarted.hub.dispose();
  });

  it('cancels automatic context reads on manual mode without starting a classifier afterward', async () => {
    const control = harness();
    let resolve: (reading: ContextReading) => void = () => undefined;
    control.holdContext = () => new Promise((done) => { resolve = done; });
    watch(control.hub);
    await control.pass();
    expect(control.contexts).toEqual([17198]);
    control.hub.configure(hubConfig({ ...limits, mode: 'manual' }));
    resolve({ context: contextOf(issue()), failure: null });
    await control.settle();
    expect(control.classified).toEqual([]);
    expect(JSON.parse(readFileSync(usagePath(), 'utf8'))).toHaveLength(1);
    expect(triageOf(control.snapshot())).toBeUndefined();
  });

  it('keeps manual work running when automatic mode changes to manual, then cancels it in off mode', async () => {
    const control = harness();
    control.hold = () => undefined;
    control.answerOnAbort = { value: { action: 'develop', detail: 'Late result after cancellation.' } };
    watch(control.hub, false);
    await control.pass();
    control.hub.receive({ id: 'board' }, { type: 'retriage', key: keyOf(control) });
    await control.settle();
    expect(control.classified).toHaveLength(1);
    control.hub.configure(hubConfig({ ...limits, mode: 'manual' }));
    await control.settle();
    expect(control.classified[0]!.signal.aborted).toBe(false);
    expect(triageOf(control.snapshot())).toMatchObject({ state: 'running' });
    control.hub.configure(hubConfig({ ...limits, mode: 'off' }));
    await control.settle();
    expect(control.classified[0]!.signal.aborted).toBe(true);
    expect(triageOf(control.snapshot())).toBeUndefined();
  });

  it('refuses automatic work when usage cannot be trusted or saved', async () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(usagePath(), 'corrupt');
    const control = harness();
    watch(control.hub);
    await control.pass();
    expect(control.contexts).toEqual([]);
    expect(control.snapshot().triage?.message).toContain('could not be read or saved');
    // Manual requests are independent of the automatic ledger.
    control.hub.receive({ id: 'board' }, { type: 'retriage', key: keyOf(control) });
    await control.settle();
    expect(control.classified).toHaveLength(1);
  });
});

describe('classification capability', () => {
  const limits = { enabled: true, mode: 'automatic' as const, concurrency: 2, timeoutMs: 60_000, names: {} };
  const keyOf = (control: Control) => control.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key;

  it('refuses deliberate readings of archived issues', async () => {
    const control = harness({}, [issue({ status: 'Backlog' })]);
    const notices: string[] = [];
    control.hub.connect({ id: 'board', hostId: 'vscode', workspaceRoot: null, residentRoutes: [], watching: true }, (message) => {
      if (message.type === 'notice') notices.push(message.message);
    });
    await control.pass();
    expect(control.snapshot().lanes.find((lane) => lane.id === 'archived')?.cards).toHaveLength(1);
    control.hub.receive({ id: 'board' }, { type: 'retriage', key: keyOf(control) });
    expect(notices.at(-1)).toContain('Only assigned issues on active lanes');
    expect(control.contexts).toEqual([]);
  });

  it('explains absent classification in a Codex-only configuration without announcing or charging usage', async () => {
    const control = harness();
    const notices: string[] = [];
    control.hub.configure({ ...hubConfig(limits), agents: [{ id: 'codex', path: 'codex-cli' }] });
    control.hub.connect({ id: 'board', hostId: 'vscode', workspaceRoot: null, residentRoutes: [], watching: true }, (message) => {
      if (message.type === 'notice') notices.push(message.message);
    });
    await control.pass();
    expect(control.classified).toEqual([]);
    expect(control.contexts).toEqual([]);
    expect(control.snapshot().triage).toMatchObject({ canRequest: false });
    expect(control.snapshot().triage?.message).toContain('No enabled agent supports card classification');
    expect(notices).toEqual([]);
    control.hub.receive({ id: 'board' }, { type: 'retriage', key: keyOf(control) });
    expect(notices.at(-1)).toContain('No enabled agent supports card classification');
    expect(() => readFileSync(join(stateDir, 'triage-usage.json'))).toThrow();

    control.hub.configure(hubConfig(limits));
    await control.pass();
    expect(control.snapshot().triage?.canRequest).toBe(true);
    expect(control.classified).toHaveLength(1);
  });

  it('handles an empty adapter registry without losing card state', async () => {
    const control = harness();
    // The runner and hub retain this registry array; remove all adapters in the isolated harness.
    (control.registries.agents as AgentAdapter[]).splice(0);
    watch(control.hub);
    await control.pass();
    expect(keyOf(control)).toBe('issue:17198');
    expect(control.snapshot().triage?.canRequest).toBe(false);
    expect(control.classified).toEqual([]);
  });

  it('distinguishes a missing card from an unavailable conversation source', async () => {
    const control = harness();
    control.hub.configure(hubConfig({ ...limits, mode: 'manual' }));
    const notices: string[] = [];
    control.hub.connect({ id: 'board', hostId: 'vscode', workspaceRoot: null, residentRoutes: [], watching: true }, (message) => {
      if (message.type === 'notice') notices.push(message.message);
    });
    await control.pass();
    delete control.registries.sources[0]!.readContext;
    control.hub.configure(hubConfig(limits));
    expect(control.snapshot().triage?.message).toContain('No configured source can provide card conversations');
    control.hub.receive({ id: 'board' }, { type: 'retriage', key: keyOf(control) });
    expect(notices.at(-1)).toContain('No configured source can provide card conversations');
    control.hub.receive({ id: 'board' }, { type: 'retriage', key: 'missing' });
    expect(notices.at(-1)).toContain('no longer on the board');
    expect(control.contexts).toEqual([]);
  });

  it('does not retain omitted or rejected sources as classification providers', async () => {
    const control = harness();
    control.hub.configure({ ...hubConfig(limits), sources: {} });
    expect(control.snapshot().triage?.canRequest).toBe(false);
    expect(control.snapshot().triage?.message).toContain('No configured source');
    control.registries.sources[0]!.configure = () => ({ subject: 'github', kind: 'bad-config', message: 'invalid source', remedy: 'correct it' });
    control.hub.configure(hubConfig(limits));
    watch(control.hub);
    await control.pass();
    expect(control.snapshot().triage?.canRequest).toBe(false);
    expect(control.contexts).toEqual([]);
  });

  it('cancels pending readings when the classifier is disabled', async () => {
    const control = harness();
    control.hold = () => undefined;
    watch(control.hub);
    await control.pass();
    expect(control.classified).toHaveLength(1);
    control.hub.configure({ ...hubConfig(limits), agents: [{ id: 'codex', path: 'codex-cli' }] });
    await control.settle();
    expect(control.classified[0]!.signal.aborted).toBe(true);
    expect(triageOf(control.snapshot())).toBeUndefined();
    expect(control.snapshot().triage?.canRequest).toBe(false);
  });
});

describe('telling the developer what it is about to spend', () => {
  it('announces triage usage once before the first read', async () => {
    // Disclose that requested triage uses paid resources and sends card text to an API (R25, R38).
    const told: string[] = [];
    const control = harness({}, [issue({ number: 1 }), issue({ number: 2 })]);
    control.hub.connect(
      { id: 'board', hostId: 'vscode', workspaceRoot: null, residentRoutes: [], watching: true },
      (m) => {
        if (m.type === 'notice') told.push(m.message);
      },
    );

    await control.pass();

    expect(told).toHaveLength(1);
    expect(told[0]).toContain('Triaging a card');
    expect(told[0]).toContain('uses your Claude allowance');
    expect(told[0]).toContain('groundControl.triage.mode');

    control.cards = [issue({ number: 3 })];
    await control.pass();

    expect(told).toHaveLength(1);
  });

  it('does not announce triage when no cards are due', async () => {
    const told: string[] = [];
    const control = harness({}, []);
    control.hub.connect(
      { id: 'board', hostId: 'vscode', workspaceRoot: null, residentRoutes: [], watching: true },
      (m) => {
        if (m.type === 'notice') told.push(m.message);
      },
    );

    await control.pass();

    expect(told).toEqual([]);
  });
});

describe('what triage must never do', () => {
  it('changes no lane and no placement', async () => {
    const control = harness();
    watch(control.hub);
    await control.hub.refresh('asked');
    const before = control.snapshot().lanes.map((lane) => [lane.id, lane.cards.map((c) => c.key)]);
    await control.settle();

    expect(control.snapshot().lanes.map((lane) => [lane.id, lane.cards.map((c) => c.key)])).toEqual(before);
    expect(triageOf(control.snapshot())).toBeDefined();
  });

  it('excludes classification sessions even if reported by the adapter', async () => {
    const control = harness();
    control.hold = () => undefined;
    watch(control.hub);
    void control.hub.refresh('asked');
    await control.settle();

    const mine = control.classified[0]!.sessionId;

    // Supply status so adapter filtering cannot hide a missing hub classification-session filter.
    control.agent.sessions = [
      fakeSession({ sessionId: mine, cwd: 'd:/work/repo', details: { status: 'busy' } }),
      fakeSession({ sessionId: 'a-real-session', cwd: 'd:/work/repo', details: { status: 'busy' } }),
    ];

    control.clock.advance(400_000);
    await control.hub.refresh('asked');

    const sessions = control.snapshot().lanes.flatMap((lane) => lane.cards).flatMap((card) => card.sessions);

    expect(sessions.map((s: Session) => s.sessionId)).toEqual(['a-real-session']);
    expect(control.snapshot().sessions?.count).toBe(1);
  });
});

describe('asking for a card again', () => {
  it('reads it again, and refuses a second ask straight after', async () => {
    const control = harness();
    const client = watch(control.hub);
    await control.hub.refresh('asked');
    await control.settle();

    expect(control.contexts).toEqual([17198]);

    control.hub.receive(client, { type: 'retriage', key: 'issue:17198' });
    await control.settle();

    expect(control.contexts).toEqual([17198, 17198]);

    control.hub.receive(client, { type: 'retriage', key: 'issue:17198' });
    await control.settle();

    expect(control.contexts).toEqual([17198, 17198]);
  });

  it('refuses when the board is already reading as many cards as it may', async () => {
    // Enforce global concurrency across manual requests; per-card cooldown alone is insufficient.
    const told: string[] = [];
    const control = harness({}, [issue({ number: 1 }), issue({ number: 2 }), issue({ number: 3 })]);
    const client = control.hub.connect(
      { id: 'board', hostId: 'vscode', workspaceRoot: null, residentRoutes: [], watching: true },
      (m) => {
        if (m.type === 'notice') told.push(m.message);
      },
    );

    control.hold = () => undefined;
    void control.hub.refresh('asked');
    await control.settle();

    expect(control.peak()).toBe(2);

    control.hub.receive(client, { type: 'retriage', key: 'issue:3' });
    await control.settle();

    expect(control.peak()).toBe(2);
    expect(told.join(' ')).toContain('Concurrent triage limit reached');
  });

  it('refuses a key no card holds, rather than spawning against it', async () => {
    const control = harness();
    const told: string[] = [];
    const client = control.hub.connect(
      { id: 'board', hostId: 'vscode', workspaceRoot: null, residentRoutes: [], watching: true },
      (message) => {
        if (message.type === 'notice') {
          told.push(message.message);
        }
      },
    );

    await control.hub.refresh('asked');
    await control.settle();
    control.hub.receive(client, { type: 'retriage', key: 'issue:404' });
    await control.settle();

    expect(control.contexts).toEqual([17198]);
    expect(told.join(' ')).toContain('no longer on the board');
  });
});

describe('a card that leaves and comes back', () => {
  it('is read again, and an archived card is never read while it sits there', async () => {
    const control = harness();
    watch(control.hub);
    await control.hub.refresh('asked');
    await control.settle();

    expect(control.contexts).toEqual([17198]);

    // Use a status outside active membership to archive the card.
    control.cards = [issue({ status: '🚀 Released' })];

    for (let n = 0; n < 3; n++) {
      await control.pass();
    }

    expect(control.contexts).toEqual([17198]);

    control.cards = [issue()];
    await control.pass();

    expect(control.contexts).toEqual([17198, 17198]);
  });

  it('keeps its reading when a source read fails, rather than reading the board again', async () => {
    const control = harness();
    watch(control.hub);
    await control.hub.refresh('asked');
    await control.settle();

    control.sourceFailed = true;
    await control.pass();

    expect(control.contexts).toEqual([17198]);
    expect(triageOf(control.snapshot())).toMatchObject({ state: 'done' });
  });
});

describe('what a reading leaves in the log', () => {
  // A classification sends card text to an API and spends the developer's usage. It is never only a redraw (R38).
  it('names the card it read and the agent it spent, and how long the reading took', async () => {
    const control = harness();

    watch(control.hub);
    await control.hub.refresh('asked');
    await control.settle();

    expect(control.logged.some((line) => line.startsWith('reading issue:') && line.endsWith(' with claude'))).toBe(true);
    expect(control.logged.some((line) => /^issue:\d+ read in \d+ms$/.test(line))).toBe(true);
  });
});
