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
import { Hub } from '../src/hub.js';
import type { HubDeps } from '../src/hub.js';
import { makeLaneStore } from '../src/lanes.js';
import { makeMarkStore } from '../src/marks.js';
import { makeTriageStore } from '../src/triageStore.js';
import { fakeClock, fakeSession, reportingAgent, tempHome } from './helpers.js';

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
    comments: [],
    logins: ['dev-1'],
    pullRequest: null,
  };
}

interface Control {
  hub: Hub;
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

  const control: Control = {
    hub: undefined as unknown as Hub,
    clock,
    agent,
    cards,
    contexts: [],
    classified: [],
    hold: null,
    answer: { value: { action: 'begin-work', detail: 'Pick it up.' } },
    contextFailure: null,
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
        // are in flight together, and a fake that lets all but one through would measure nothing.
        if (control.hold !== null) {
          await new Promise<void>(() => undefined);
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
    settings: { read: () => null, write: () => undefined },
    syncActivity: (_r, wanted) => ({ wanted, plan: 'up-to-date', added: 0, failure: null }),
    ...over,
  });

    control.hub.configure(hubConfig());

  return control;
}

/** What a client pushes. Every test but one runs on this; that one turns triage off. */
function hubConfig(triage: HubConfig['triage'] = { enabled: true, concurrency: 2, timeoutMs: 60_000 }): HubConfig {
  return {
    agents: [{ id: 'claude', path: 'claude-cli', model: 'claude-haiku-4-5-20251001' }],
    branchIssuePattern: '^(\d+)-',
    hosts: {},
    sources: { github: { repo: 'example-org/example-repo', logins: ['dev-1'] } },
    boardStatuses: ['⚒️ Dev'],
    statusLanes: {},
    refreshIntervalMs: 300_000,
    sessionIntervalMs: 30_000,
    installActivity: false,
    triage,
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
    expect(triageOf(control.snapshot())).toMatchObject({ state: 'done', action: 'begin-work', detail: 'Pick it up.' });

    await control.pass();

    expect(control.contexts).toEqual([17198]);
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
    control.hub.configure(hubConfig({ enabled: false, concurrency: 2, timeoutMs: 60_000 }));

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

    expect(triageOf(snapshot, 'issue:1')).toBeUndefined();
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

    expect(triageOf(control.snapshot())).toBeUndefined();
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
    expect(told.join(' ')).toContain('not on the board');
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
