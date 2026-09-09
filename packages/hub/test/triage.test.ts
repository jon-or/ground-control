import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import type { HubDeps } from '../src/hub.js';
import { makeLaneStore } from '../src/lanes.js';
import { makeMarkStore } from '../src/marks.js';
import { makeTriageStore } from '../src/triageStore.js';
import { makeCheckoutStore } from '../src/checkoutStore.js';
import { makeActionStore } from '../src/actionStore.js';
import { makeIssueStore } from '../src/issueStore.js';
import { makeStatusStore } from '../src/statusStore.js';
import { captureLog, fakeClock, fakeSession, reportingAgent, tempHome } from './helpers.js';

let home: string;
let dispose: () => void;

beforeEach(() => {
  ({ home, dispose } = tempHome());
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
  answer: ClassifyResult;
  contextFailure: { kind: string; message: string } | null;
  /** Set to make the seam throw rather than classify a failure. Both seams are public and either may. */
  contextThrows: boolean;
  sourceFailed: boolean;
  snapshot(): Snapshot;
  settle(): Promise<void>;
  /**
   * A refresh that genuinely re-reads: the clock moves past the source floor first. The default clears every backoff
   * too, so a test about a backoff passes the smallest step that re-reads and nothing more.
   */
  pass(advance?: number): Promise<void>;
  /** How many classifications were running at once, at the most. */
  peak(): number;
}

function harness(over: Partial<HubDeps> = {}, cards: IssueCard[] = [issue()]): Control {
  const clock = fakeClock();
  const agent = reportingAgent('claude');

  const logging = captureLog();

  const control: Control = {
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
    // Both reads keep a floor of their own, so a second refresh on a still clock is not a second read.
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
              truncated: false,
              fetchedAt: '2026-09-03T12:00:00Z',
            },
            failure: null,
            needs: null,
          },
    readContext: async (card): Promise<ContextReading> => {
      control.contexts.push(card.number);

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
        // Held open by every classification, not just the first: what a cap has to be measured against is how many
        // are in flight together, and a fake that lets all but one through would measure nothing. It answers an
        // abort, because the real runner kills the process and the outcome comes back — a fake that ignored the
        // signal would hold a slot no production run ever holds.
        if (control.hold !== null) {
          await new Promise<void>((resolve) => {
            input.signal.addEventListener('abort', () => resolve(), { once: true });
          });

          return { failure: { subject: 'claude', kind: 'classify-aborted', message: 'stood down', remedy: 'r' } };
        }

        return control.answer;
      } finally {
        live -= 1;
      }
    },
  };

  const registries = { agents: [classifying], hosts: [], sources: [source] };

  control.hub = new Hub({
    clock: clock.clock,
    watch: () => ({ dispose: () => undefined }),
    home,
    registries,
    lanes: makeLaneStore(home),
    marks: makeMarkStore(home),
    triage: makeTriageStore(home),
    checkouts: makeCheckoutStore(home),
    actions: makeActionStore(home),
    issues: makeIssueStore(home),
    status: makeStatusStore(home),
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
    hosts: {},
    logLevel: 'info',
    sources: { github: { repo: 'example-org/example-repo', logins: ['dev-1'] } },
    boardStatuses: ['⚒️ Dev', '🔍 Dev Review'],
    statusLanes,
    refreshIntervalMs: 300_000,
    sessionIntervalMs: 30_000,
    newSession: { prompt: '' },
    installActivity: false,
    triage,
    actions: { permissionMode: 'manual', concurrency: 1, dailyLimit: 0, resultTimeoutMs: 1_800_000, actions: {} },
  };
}

/** A watching client, which is what R35 makes triage conditional on. */
function watch(hub: Hub, watching = true) {
  return hub.connect(
    { id: 'board', hostId: null, workspaceRoot: null, residentRoutes: [], watching },
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
    // The one change worth paying to re-read. A comment moves the card's `updatedAt` and settles nothing; a status
    // move is the team's word on what the work is (R38).
    const control = harness();
    watch(control.hub);
    await control.hub.refresh('asked');
    await control.settle();

    expect(control.contexts).toEqual([17198]);

    control.cards = [issue({ status: '🔍 Dev Review', statusChangedAt: '2026-09-04T13:53:36Z' })];
    await control.pass();

    expect(control.contexts).toEqual([17198, 17198]);
  });

  it('does not read a card again for a comment, which costs the developer usage and settles nothing', async () => {
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

  it('tells the model the action where the status settled one, and takes it whatever the model says', async () => {
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

  it('classifies with the configured model, in the hub own directory, and never in a checkout', async () => {
    const control = harness();
    watch(control.hub);
    await control.hub.refresh('asked');
    await control.settle();

    expect(control.classified[0]?.model).toBe('claude-haiku-4-5-20251001');
    expect(control.classified[0]?.path).toBe('claude-cli');
    expect(control.classified[0]?.cwd.replace(/\\/g, '/')).toBe(`${home.replace(/\\/g, '/')}/.claude/ground-control`);
    expect(control.classified[0]?.prompt).toContain('ISSUE #17198');
  });

  it('carries the configured names into the prompt, so a card calls an agent account by whoever drives it', () => {
    const control = harness();
    control.hub.configure(hubConfig({ enabled: true, concurrency: 2, timeoutMs: 60_000, names: { buildfriday: 'Chris' } }));
    watch(control.hub);

    return control.hub.refresh('asked').then(control.settle).then(() => {
      expect(control.classified[0]?.prompt).toContain('Chris, member');
      expect(control.classified[0]?.prompt).not.toContain('Friday');
    });
  });

  it('says a card is being read while it is', async () => {
    const control = harness();
    control.hold = () => undefined;
    watch(control.hub);
    void control.hub.refresh('asked');
    await control.settle();

    expect(triageOf(control.snapshot())).toEqual({ state: 'running' });
  });

  it('reads nothing while no board is watching, however often the hub broadcasts', async () => {
    // R35: a window that has activated the extension stays connected with no board open, and without this gate
    // opening the editor would read the whole board at nobody.
    const control = harness();
    watch(control.hub, false);
    await control.hub.refresh('asked');
    await control.settle();

    expect(control.contexts).toEqual([]);
    expect(triageOf(control.snapshot())).toBeUndefined();
  });

  it('reads nothing while triage is turned off', async () => {
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

  it('reads nothing for work with no issue of its own', async () => {
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

  it('offers the merge to the model, since a merge is a request and nothing derives one', () => {
    // R39: the board reads no mergeability, so the words somebody wrote are the only channel there is. An action
    // the build does not have is refused by the same enum, which is what keeps a stale answer off a card.
    const offered = (triageJsonSchema(null) as { properties: { action: { enum: string[] } } }).properties.action.enum;

    expect(offered).toContain('merge-upstream');
    expect(offered).not.toContain('resolve-conflicts');
    expect(offered).not.toContain('land');
  });
});

describe('when a seam throws rather than classifying', () => {
  it('charges the card a failure and backs off, rather than reading it again on every pass', async () => {
    // A rejection would otherwise leave neither an entry nor a failure, which reads as never having been tried — so
    // the very next broadcast starts it again, with no backoff and no end.
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

describe('standing readings down', () => {
  it('does not charge a card for a reading the developer turned off', async () => {
    const control = harness();
    control.hold = () => undefined;
    watch(control.hub);
    void control.hub.refresh('asked');
    await control.settle();

    expect(triageOf(control.snapshot())).toEqual({ state: 'running' });

    control.hub.configure(hubConfig({ enabled: false, concurrency: 2, timeoutMs: 120_000, names: {} }));
    await control.settle();

    // Charged, four flicks of the setting would silence a card for good, and the board would say it had failed.
    expect(triageOf(control.snapshot())).toBeUndefined();
    expect(control.snapshot().failures.filter((f) => f.subject === 'triage')).toEqual([]);
  });
});

describe('telling the developer what it is about to spend', () => {
  it('says so once, before the first card is read, and never again', async () => {
    // The activity install announces itself, and it writes a local file and costs nothing. A feature that spends the
    // developer's usage and sends their colleagues' words to an API, on by default, cannot say less (R25, R38).
    const told: string[] = [];
    const control = harness({}, [issue({ number: 1 }), issue({ number: 2 })]);
    control.hub.connect(
      { id: 'board', hostId: null, workspaceRoot: null, residentRoutes: [], watching: true },
      (m) => {
        if (m.type === 'notice') told.push(m.message);
      },
    );

    await control.pass();

    expect(told).toHaveLength(1);
    expect(told[0]).toContain('2 cards');
    expect(told[0]).toContain('uses your Claude allowance');
    expect(told[0]).toContain('groundControl.triage.enabled');

    control.cards = [issue({ number: 3 })];
    await control.pass();

    expect(told).toHaveLength(1);
  });

  it('says nothing on a board where there is nothing to read', async () => {
    const told: string[] = [];
    const control = harness({}, []);
    control.hub.connect(
      { id: 'board', hostId: null, workspaceRoot: null, residentRoutes: [], watching: true },
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

  it('keeps its own classification off the roster, even when the adapter reports it', async () => {
    const control = harness();
    control.hold = () => undefined;
    watch(control.hub);
    void control.hub.refresh('asked');
    await control.settle();

    const mine = control.classified[0]!.sessionId;

    // Given a status, so the adapter's own `neverPrompted` would not drop it first — otherwise this assertion holds
    // with the hub's filter deleted, which is a test that cannot fail.
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
    // The cooldown is per card, so without a cap here a board of fifteen chips is fifteen clicks away from fifteen
    // classifications at once, whatever the setting says.
    const told: string[] = [];
    const control = harness({}, [issue({ number: 1 }), issue({ number: 2 }), issue({ number: 3 })]);
    const client = control.hub.connect(
      { id: 'board', hostId: null, workspaceRoot: null, residentRoutes: [], watching: true },
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
      { id: 'board', hostId: null, workspaceRoot: null, residentRoutes: [], watching: true },
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

    // Past the developer's hands: the status is outside the board set, so the card archives.
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
