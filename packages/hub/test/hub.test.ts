import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { GITHUB_SOURCE_ID, makeGithubSource } from '@ground-control/github';
import type { AssignedIssues, GithubConfig, GithubSourceDeps, Result } from '@ground-control/github';
import type { ClientHello, HubConfig, HubMessage, IssueCard, Snapshot, WorkSource } from '@ground-control/core';
import type { ActivityState } from '../src/activityInstall.js';
import { Hub } from '../src/hub.js';
import type { HubDeps } from '../src/hub.js';
import { makeLaneStore } from '../src/lanes.js';
import { makeTriageStore } from '../src/triageStore.js';
import { makeCheckoutStore } from '../src/checkoutStore.js';
import { makeActionStore } from '../src/actionStore.js';
import { makeIssueStore } from '../src/issueStore.js';
import { makeStatusStore } from '../src/statusStore.js';
import { makeSettingsStore } from '../src/settings.js';
import type { StoredConfig } from '../src/settings.js';
import { makeMarkStore } from '../src/marks.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lanesPathOf, logPathOf } from '../src/paths.js';
import { groundControlDirOf } from '@ground-control/core';
import type { LogEntry } from '@ground-control/core';
import { defaultConfig } from '../src/registry.js';
import { captureLog, fakeClock, fakeHost, fakeReaders, fakeSession, reportingAgent, tempHome } from './helpers.js';
import type { FakeAgentControl, FakeHostControl } from './helpers.js';

let home: string;
let dispose: () => void;

beforeEach(() => {
  ({ home, dispose } = tempHome());
});

afterEach(() => dispose());

const ISSUES: AssignedIssues = {
  cards: [],
  matched: 0,
  totalAssigned: 0,
  notOnProject: 0,
  truncated: false,
  fetchedAt: '2026-09-03T12:00:00Z',
  sourceQuery: 'assignee:dev-1',
};

/** What the GitHub source is given to read with, so a test drives a failed read without a network or a CLI. */
type Fetch = (config: GithubConfig) => Promise<Result<AssignedIssues>>;

/** One issue as a source reports it. `author` opens a pull request on it, which is what lanes a card to review. */
function card(number: number, author: string | null = null): IssueCard {
  return {
    number,
    title: `Issue ${number}`,
    type: null,
    typeColor: null,
    url: `https://example.invalid/issues/${number}`,
    status: null,
    statusColor: null,
    statusChangedAt: null,
    assignees: [],
    avatar: null,
    pullRequest:
      author === null
        ? null
        : {
            number: number + 1,
            url: `https://example.invalid/pull/${number + 1}`,
            state: 'OPEN',
            author,
            isDraft: false,
            reviewDecision: null,
            updatedAt: null,
            headOid: null,
            checksRed: null,
          },
    updatedAt: '2026-09-03T08:00:00Z',
  };
}

interface Harness {
  hub: Hub;
  /** Whether a watcher is armed. A batch delivered to nothing is indistinguishable from one nothing acted on. */
  watching: boolean;
  agent: FakeAgentControl;
  host: FakeHostControl;
  clock: ReturnType<typeof fakeClock>;
  /** Every message the hub sent, per client id, so a test can prove who was told and who was not. */
  sent: Map<string, HubMessage[]>;
  /** Each marker batch the hub is handed, as the watcher would deliver it. */
  signal(changes: { kind: 'created' | 'changed' | 'deleted'; sessionId: string }[]): void;
  issueReads: number;
  /** What each install run was asked to do, in order. */
  installs: ('install' | 'remove')[];
  /** Which agent ids each install was asked to reach, or null where it was asked to reach every one. */
  installedFor: (readonly string[] | null)[];
  /** What the install reports next, or null for a run that changed nothing. */
  activity: ActivityState | null;
  detected: string[];
  config(over?: Partial<HubConfig>): HubConfig;
  /** Every configuration the hub decided to remember. A refused one must never reach it. */
  wrote: HubConfig[];
  /** What the hub said about itself, message only. A line it never wrote is a decision nothing recorded. */
  logged: string[];
}

function harness(
  over: Partial<HubDeps> = {},
  extra: {
    fetch?: Fetch;
    sources?: WorkSource[];
    remembered?: Partial<HubConfig>;
    stored?: StoredConfig;
    readCard?: GithubSourceDeps['readCard'];
  } = {},
): Harness {
  const agent = reportingAgent();
  const host = fakeHost();
  const clock = fakeClock();
  const sent = new Map<string, HubMessage[]>();
  const counts = { issues: 0 };
  const detected = ['detected-dev'];
  let onChange: ((changes: { kind: 'created' | 'changed' | 'deleted'; sessionId: string }[]) => void) | undefined;

  // The shipped source, reading through an injected fetch: what the hub does with a configuration, a refusal, and
  // the accounts it has none of is the source's own answer, and a fake here would be a second implementation of it.
  const github = makeGithubSource({
    fetch: (config) => {
      counts.issues += 1;

      return extra.fetch ? extra.fetch(config) : Promise.resolve({ ok: true, value: ISSUES });
    },
    detectLogins: async () => detected,
    // Injected always: without it a session naming a number nothing assigned spawns `gh` from inside a unit test.
    readCard: extra.readCard ?? (async () => ({ ok: true, value: null })),
  });

  const registries = { agents: [agent.adapter], hosts: [host.adapter], sources: [github, ...(extra.sources ?? [])] };
  const logging = captureLog();

  const shape: Harness = {
    hub: undefined as unknown as Hub,
    watching: false,
    agent,
    host,
    clock,
    sent,
    signal: (changes) => {
      if (onChange === undefined) {
        throw new Error('no watcher is armed, so this batch would reach nothing and prove nothing');
      }

      onChange(changes);
    },
    get issueReads() {
      return counts.issues;
    },
    installs: [],
    installedFor: [],
    logged: logging.messages,
    activity: null,
    detected,
    wrote: [],
    config: (part = {}) => ({
      ...defaultConfig(registries, fakeReaders()),
      agents: [{ id: agent.adapter.id, path: agent.adapter.defaultPath }],
      hosts: { [host.adapter.id]: {} },
      sources: { github: { repo: 'example-org/example-repo', logins: ['dev-1'] } },
      ...part,
    }),
  };

  const deps: HubDeps = {
    clock: clock.clock,
    watch: (_dir, handler) => {
      onChange = handler as typeof onChange;
      shape.watching = true;

      return {
        dispose: () => {
          onChange = undefined;
          shape.watching = false;
        },
      };
    },
    home,
    registries,
    log: logging.log,
    lanes: makeLaneStore(home),
    marks: makeMarkStore(home),
    triage: makeTriageStore(home),
    checkouts: makeCheckoutStore(home),
    actions: makeActionStore(home),
    issues: makeIssueStore(home),
    status: makeStatusStore(home),
    // A hub built over a store that already holds a configuration is the browser-started case: nobody is here to
    // push one, and the developer set theirs in an editor that is not open.
    settings: {
      read: () => (extra.remembered ? { config: shape.config(extra.remembered) } : (extra.stored ?? null)),
      write: (config) => {
        shape.wrote.push(config);
      },
    },
    // Never the real one: it writes an agent's settings file, and none of these tests is about that. What it was
    // asked for is recorded, because "turn this off and the entries go" is a claim only the argument proves.
    syncActivity: (_registries, wanted, _home, enabled) => {
      shape.installs.push(wanted);
      shape.installedFor.push(enabled === undefined ? null : [...enabled].sort());

      return shape.activity ?? { wanted, plan: 'up-to-date', added: 0, failure: null };
    },
    ...over,
  };

  shape.hub = new Hub(deps);

  return shape;
}

function hello(over: Partial<ClientHello> = {}): ClientHello {
  return {
    id: 'board-1',
    hostId: 'fake-host',
    workspaceRoot: 'd:/checkouts/project-1',
    residentRoutes: ['reveal-here'],
    watching: true,
    ...over,
  };
}

function connect(h: Harness, who: ClientHello = hello()) {
  const inbox: HubMessage[] = [];
  h.sent.set(who.id, inbox);

  return { client: h.hub.connect(who, (message) => inbox.push(message)), inbox };
}

/** Lets every promise the hub has in flight settle. Nothing here sleeps: the fakes resolve immediately. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The last snapshot a client was sent, insisted on rather than guarded: a message of another type is the finding. */
function latest(inbox: HubMessage[]): Snapshot {
  const last = inbox.at(-1);

  if (last?.type !== 'snapshot' && last?.type !== 'changed') {
    throw new Error(`the last message was ${last?.type ?? 'nothing'}, not a snapshot`);
  }

  return last.snapshot;
}

describe('what the hub polls', () => {
  it('reads nothing until a client is watching, and stops when the last one looks away', async () => {
    const h = harness();

    expect(h.clock.cadences()).toEqual([]);

    const { client } = connect(h, hello({ watching: false }));

    expect(h.clock.cadences()).toEqual([]);

    h.hub.receive(client, { type: 'watching', watching: true });
    await settle();

    // Written out, not read back from the same defaults the hub used: the shipped cadences are 30 s and 5 minutes,
    // over the fixed 5 s tick that watches for a suspend and for a source that has come back.
    expect(h.clock.cadences()).toEqual([5_000, 30_000, 300_000]);

    h.hub.receive(client, { type: 'watching', watching: false });

    expect(h.clock.cadences()).toEqual([]);
  });

  it('stops polling when the last watching client disconnects', () => {
    const h = harness();
    const { client } = connect(h);

    expect(h.clock.cadences()).toHaveLength(3);

    h.hub.disconnect(client);

    expect(h.clock.cadences()).toEqual([]);
  });

  /** Two sources, two costs: a network round trip and a CLI spawn do not belong on one timer (mechanics §2). */
  it('polls the two sources on their own cadences', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    const before = { issues: h.issueReads, sessions: h.agent.calls };

    h.clock.fire(h.config().sessionIntervalMs);
    await settle();

    expect(h.agent.calls).toBe(before.sessions + 1);
    expect(h.issueReads).toBe(before.issues);

    h.clock.fire(h.config().refreshIntervalMs);
    await settle();

    expect(h.issueReads).toBe(before.issues + 1);
  });

  it('takes the cadences a client configures', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, {
      type: 'configure',
      config: h.config({ refreshIntervalMs: 60_000, sessionIntervalMs: 5_000 }),
    });
    await settle();

    // The two a client configured, plus the tick, which is the hub's own and takes no setting.
    expect(h.clock.cadences()).toEqual([5_000, 5_000, 60_000]);
  });

  /** The button is a read of whatever is there now, so pressing it twice is one read, not two CLI spawns. */
  it('ignores a refresh asked for again within the second', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'refresh' });
    await settle();

    const after = h.agent.calls;

    h.hub.receive(client, { type: 'refresh' });
    await settle();

    expect(h.agent.calls).toBe(after);

    h.clock.advance(1_001);
    h.hub.receive(client, { type: 'refresh' });
    await settle();

    expect(h.agent.calls).toBe(after + 1);
  });

  /** R35: a board becomes visible on every tab switch, and a source read is a network round trip GitHub rate limits. */
  it('shows a board that comes back inside the minute the cards it already read', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    const before = { issues: h.issueReads, sessions: h.agent.calls };

    h.clock.advance(59_000);
    h.hub.receive(client, { type: 'watching', watching: false });
    h.hub.receive(client, { type: 'watching', watching: true });
    await settle();

    // The sessions are read all the same: that one is a local CLI spawn, and it is what says a session ended.
    expect(h.issueReads).toBe(before.issues);
    expect(h.agent.calls).toBe(before.sessions + 1);

    h.clock.advance(1_001);
    h.hub.receive(client, { type: 'watching', watching: false });
    h.hub.receive(client, { type: 'watching', watching: true });
    await settle();

    expect(h.issueReads).toBe(before.issues + 1);
  });

  it('reads the sources for a button press inside that minute, and for settings that moved', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    const before = h.issueReads;

    h.clock.advance(1_001);
    h.hub.receive(client, { type: 'refresh' });
    await settle();

    expect(h.issueReads).toBe(before + 1);

    // Restated rather than changed, which is what every board that opens does, and must not cost a read. The second
    // says the same thing in another order, which is a client building its own source entry, not a setting that moved.
    h.clock.advance(1_001);
    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(h.issueReads).toBe(before + 1);

    h.clock.advance(1_001);
    h.hub.receive(client, {
      type: 'configure',
      config: h.config({ sources: { github: { logins: ['dev-1'], repo: 'example-org/example-repo' } } }),
    });
    await settle();

    expect(h.issueReads).toBe(before + 1);

    h.clock.advance(1_001);
    h.hub.receive(client, {
      type: 'configure',
      config: h.config({ sources: { github: { repo: 'example-org/other-repo', logins: ['dev-1'] } } }),
    });
    await settle();

    expect(h.issueReads).toBe(before + 2);
  });

  /** The board's arrival takes the session read's second. A press behind it is the developer asking, not that read. */
  it('reads the sources for a button press behind a board that just became visible', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    const before = h.issueReads;

    h.clock.advance(30_000);
    h.hub.receive(client, { type: 'watching', watching: false });
    h.hub.receive(client, { type: 'watching', watching: true });
    await settle();

    expect(h.issueReads).toBe(before);

    h.clock.advance(400);
    h.hub.receive(client, { type: 'refresh' });
    await settle();

    expect(h.issueReads).toBe(before + 1);
  });

  /** The read in flight went out with the settings these replaced, so folding this into it would answer the old ones. */
  it('reads again for a source whose settings moved under a read already in flight', async () => {
    const waiting: (() => void)[] = [];
    const repos: string[] = [];
    const h = harness(
      {},
      {
        fetch: (config) => {
          repos.push(config.repo);

          return new Promise((resolve) => waiting.push(() => resolve({ ok: true, value: ISSUES })));
        },
      },
    );
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(repos).toEqual(['example-org/example-repo']);

    h.hub.receive(client, {
      type: 'configure',
      config: h.config({ sources: { github: { repo: 'example-org/other-repo', logins: ['dev-1'] } } }),
    });
    await settle();

    // Queued, not folded in: the read in flight is still the only one that has gone out.
    expect(repos).toHaveLength(1);

    waiting.shift()?.();
    await settle();

    expect(repos).toEqual(['example-org/example-repo', 'example-org/other-repo']);

    waiting.shift()?.();
    await settle();
  });

  /** A rebuilt timer starts its count again, so a board toggled faster than the cadence would never reach a poll. */
  it('leaves the timers alone for a client that says nothing new', () => {
    const h = harness();
    const { client } = connect(h);
    const armed = h.clock.handles();

    h.hub.receive(client, { type: 'watching', watching: true });
    h.hub.receive(client, { type: 'hello', hello: hello() });

    expect(h.clock.handles()).toEqual(armed);

    connect(h, hello({ id: 'board-2' }));

    expect(h.clock.handles()).toEqual(armed);

    h.hub.receive(client, { type: 'watching', watching: false });

    expect(h.clock.handles()).toEqual(armed);
  });
});

describe('what an activity event costs', () => {
  it('re-reads one marker for a phase on a session it has already listed, without asking the CLI', async () => {
    const h = harness();
    const session = fakeSession();
    h.agent.sessions = [session];

    const { client, inbox } = connect(h);
    h.hub.receive(client, { type: 'refresh' });
    await settle();

    const spawns = h.agent.calls;
    h.agent.phases.set(session.sessionId, { phase: 'waiting', since: 1, at: 1, event: 'Notification' });
    h.signal([{ kind: 'changed', sessionId: session.sessionId }]);
    await settle();

    expect(h.agent.calls).toBe(spawns);

    const cards = latest(inbox).lanes.flatMap((lane) => lane.cards);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.attention).toBe('blocked');
  });

  it('asks the CLI for a marker naming a session it has never listed', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'refresh' });
    await settle();

    const spawns = h.agent.calls;
    h.agent.phases.set('a-new-session', { phase: 'running', since: 1, at: 1, event: 'UserPromptSubmit' });
    h.signal([{ kind: 'created', sessionId: 'a-new-session' }]);
    await settle();

    expect(h.agent.calls).toBe(spawns + 1);
  });

  /** The CLI lists nothing and fails, so every batch would be stale and spawn a read that fails again. */
  it('does not ask an unreadable CLI again on every marker', async () => {
    const h = harness();
    h.agent.failure = { subject: 'fake', kind: 'cli-missing', message: 'no CLI', remedy: 'install it' };

    const { client, inbox } = connect(h);
    h.hub.receive(client, { type: 'refresh' });
    await settle();

    const spawns = h.agent.calls;

    // Proved to have read at all: a count that never moves is the same number as a watcher that was never armed.
    expect(spawns).toBe(1);

    h.signal([{ kind: 'deleted', sessionId: 'whatever' }]);
    await settle();

    expect(h.agent.calls).toBe(1);
    expect(latest(inbox).failures.map((f) => f.kind)).toContain('cli-missing');
  });
});

describe('what the snapshot says', () => {
  it('keeps the last good read of a source that has since failed, and names the failure', async () => {
    let ok = true;
    const h = harness(
      {},
      {
        fetch: async () =>
          ok
            ? { ok: true, value: { ...ISSUES, matched: 7 } }
            : { ok: false, error: { kind: 'query-failed', message: 'GitHub failed.', remedy: 'Try again.' } },
      },
    );

    const { client, inbox } = connect(h);
    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(h.hub.snapshot().issues?.matched).toBe(7);

    ok = false;
    h.clock.advance(2000);
    h.hub.receive(client, { type: 'refresh' });
    await settle();

    expect(latest(inbox).issues?.matched).toBe(7);
    expect(latest(inbox).failures.map((f) => f.kind)).toContain('query-failed');
  });

  /** The hub has no screen, so it says what it needs and what it could detect, and a client puts the question. */
  it('asks for the logins it has none of, and stops once it has some', async () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config({ sources: { github: { repo: 'o/r' } } }) });
    await settle();

    expect(latest(inbox).needs?.logins.detected).toEqual(['detected-dev']);
    expect(latest(inbox).failures.map((f) => f.kind)).toContain('no-logins');
    expect(h.issueReads).toBe(0);

    h.clock.advance(2000);
    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(latest(inbox).needs).toBeNull();
    expect(h.issueReads).toBe(1);
  });

  it('names a source configuration it will not read with, rather than reading with a default', async () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config({ sources: { github: { repo: '' } } }) });
    await settle();

    expect(latest(inbox).failures.map((f) => f.kind)).toContain('bad-config');
    expect(h.issueReads).toBe(0);
  });

  /** The registry is reached by id: a source the developer has not named costs no read, and neither does a typo. */
  it('reads the sources the configuration names, and only those', async () => {
    const reads: string[] = [];
    const other: WorkSource = {
      id: 'other-source',
      displayName: 'Another source',
      configure: () => null,
      read: async () => {
        reads.push('other-source');

        return { items: null, failure: null, needs: null };
      },
    };

    const h = harness({}, { sources: [other] });
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(reads).toEqual([]);
    expect(h.issueReads).toBe(1);

    h.clock.advance(2000);
    h.hub.receive(client, {
      type: 'configure',
      config: h.config({ sources: { 'other-source': {} } }),
    });
    await settle();

    expect(reads).toEqual(['other-source']);
    expect(h.issueReads).toBe(1);
  });

  /** A repository the developer stopped tracking keeping its cards on the board is the board naming work as theirs. */
  it('drops what a source read, and what it was complaining about, once the configuration stops naming it', async () => {
    let ok = true;
    const h = harness(
      {},
      {
        fetch: async () =>
          ok
            ? { ok: true, value: ISSUES }
            : { ok: false, error: { kind: 'query-failed', message: 'GitHub failed.', remedy: 'Try again.' } },
      },
    );

    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(latest(inbox).issues).not.toBeNull();

    ok = false;
    h.clock.advance(2000);
    h.hub.receive(client, { type: 'refresh' });
    await settle();

    expect(latest(inbox).stale).toBe(true);

    h.clock.advance(2000);
    h.hub.receive(client, { type: 'configure', config: h.config({ sources: {} }) });
    await settle();

    expect(latest(inbox).issues).toBeNull();
    expect(latest(inbox).failures.map((f) => f.subject)).not.toContain(GITHUB_SOURCE_ID);
    expect(latest(inbox).stale).toBe(false);
  });

  /**
   * One board out of several sources: the counts add up, the age is the source that has not been read since, and
   * the lane rules read the accounts the sources were read for rather than the accounts a setting names.
   */
  it('merges what every source read, and is as old as the oldest of them', async () => {
    const other: WorkSource = {
      id: 'other-source',
      displayName: 'Another source',
      configure: () => null,
      read: async () => ({
        items: {
          // Its pull request is by the account this source read for, which is what puts the card in review.
          cards: [card(4521, 'dev-2')],
          owners: ['dev-2'],
          matched: 2,
          totalAssigned: 3,
          notOnProject: 1,
          truncated: true,
          fetchedAt: '2026-09-03T08:00:00Z',
        },
        failure: null,
        needs: null,
      }),
    };

    const h = harness(
      {},
      {
        sources: [other],
        fetch: async () => ({
          ok: true,
          value: { ...ISSUES, cards: [card(4400)], matched: 5, totalAssigned: 6, notOnProject: 2 },
        }),
      },
    );

    const { client } = connect(h);

    h.hub.receive(client, {
      type: 'configure',
      config: h.config({
        sources: { [GITHUB_SOURCE_ID]: { repo: 'example-org/example-repo', logins: ['dev-1'] }, 'other-source': {} },
      }),
    });
    await settle();

    const { issues, lanes } = h.hub.snapshot();

    expect(issues).toMatchObject({ count: 2, matched: 7, totalAssigned: 9, notOnProject: 3, truncated: true });
    // ISSUES was read four hours later, and the board is as old as the source that has not been read since.
    expect(issues?.fetchedAt).toBe('2026-09-03T08:00:00Z');
    expect(lanes.find((lane) => lane.cards.some((c) => c.issueNumber === 4521))?.id).toBe('review');
  });

  /**
   * The whole of what a developer sees after finishing an issue: the assigned read stops returning it, the session
   * they left open is still there, and the card has to keep its title rather than becoming a bare number (R9).
   */
  it('names an issue nobody assigned any more, and archives the card once nothing is running on it', async () => {
    // The card's own URL is what keys the remembered issue, and it has to key the same repository the session names.
    const worked = { ...card(18941), url: 'https://github.com/example-org/example-repo/issues/18941' };
    let assigned = [worked];
    const h = harness(
      {},
      {
        fetch: async () => ({ ok: true, value: { ...ISSUES, cards: assigned } }),
        readCard: async () => {
          throw new Error('the board already had this card, so it must not read GitHub again');
        },
      },
    );

    h.agent.sessions = [fakeSession({ finished: true })];

    const { client } = connect(h);
    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    assigned = [];
    h.clock.fire(h.config().refreshIntervalMs);
    await settle();

    const card18941 = h.hub
      .snapshot()
      .lanes.flatMap((lane) => lane.cards)
      .find((c) => c.issueNumber === 18941);

    expect(card18941?.issue?.title).toBe('Issue 18941');
    expect(card18941?.unassigned).toBe(true);
    expect(card18941?.lane).toBe('archived');
  });

  it('reads an issue no session has ever seen assigned, and puts the title on the card', async () => {
    const h = harness(
      {},
      { readCard: async (_config, _owner, _name, number) => ({ ok: true, value: card(number) }) },
    );

    h.agent.sessions = [fakeSession({ finished: true })];

    const { client } = connect(h);
    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();
    await settle();

    const found = h.hub
      .snapshot()
      .lanes.flatMap((lane) => lane.cards)
      .find((c) => c.issueNumber === 18941);

    expect(found?.issue?.title).toBe('Issue 18941');
    expect(found?.lane).toBe('archived');
  });

  it('leaves a session on a checkout card while nothing can name the number its branch carries', async () => {
    const h = harness({}, { readCard: async () => ({ ok: true, value: null }) });

    h.agent.sessions = [fakeSession()];

    const { client } = connect(h);
    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();
    await settle();

    const cards = h.hub.snapshot().lanes.flatMap((lane) => lane.cards);

    expect(cards.filter((c) => c.sessions.length > 0)).toHaveLength(1);
    expect(cards.find((c) => c.sessions.length > 0)?.issueNumber).toBeNull();
  });

  /** Cards read for a repository whose settings the developer has since broken are not cards they can act on. */
  it('takes down what a source read once its settings are refused', async () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(latest(inbox).issues).not.toBeNull();

    // No clock advance: inside the refresh floor there is no read to take them down, so what does is the refusal.
    h.hub.receive(client, { type: 'configure', config: h.config({ sources: { github: { repo: '' } } }) });
    await settle();

    expect(latest(inbox).issues).toBeNull();
    expect(latest(inbox).failures.map((f) => f.kind)).toContain('bad-config');
  });

  /**
   * A board with no source it can read is stale, whether the read failed or the settings for it were refused. The
   * dimming is what says the cards on screen are not what the world says now (R24, R25).
   */
  it('calls the board stale while a source it cannot read is configured', async () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(latest(inbox).stale).toBe(false);

    h.clock.advance(2000);
    h.hub.receive(client, { type: 'configure', config: h.config({ sources: { github: { repo: '' } } }) });
    await settle();

    expect(latest(inbox).stale).toBe(true);
  });

  /** A second window opening must not take down what the board is telling the developer about the first one. */
  it('leaves a refused configuration named when another client connects', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: { nothing: 'the hub can read' } as unknown as HubConfig });
    await settle();

    const refusal = () => h.hub.snapshot().failures.map((f) => f.message);

    expect(refusal()).toContainEqual(expect.stringContaining("The board's settings could not be read"));

    connect(h, hello({ id: 'board-2' }));

    expect(refusal()).toContainEqual(expect.stringContaining("The board's settings could not be read"));
  });

  /** A source is a seam anyone may implement. One that throws must land like one that failed, not take the pass. */
  it('names a source that threw, and reads the others anyway', async () => {
    const boom: WorkSource = {
      id: 'other-source',
      displayName: 'Another source',
      configure: () => null,
      read: () => Promise.reject(new Error('it fell over')),
    };

    const h = harness({}, { sources: [boom] });
    const { client, inbox } = connect(h);

    h.hub.receive(client, {
      type: 'configure',
      config: h.config({
        sources: { [GITHUB_SOURCE_ID]: { repo: 'example-org/example-repo', logins: ['dev-1'] }, 'other-source': {} },
      }),
    });
    await settle();

    expect(latest(inbox).failures.map((f) => f.kind)).toContain('source-failed');
    expect(latest(inbox).failures.find((f) => f.kind === 'source-failed')?.message).toContain('it fell over');
    expect(latest(inbox).issues).not.toBeNull();
  });

  /**
   * A host left out of the configuration was handed no settings of its own. Reaching into an editor on defaults
   * nobody chose reads another install's windows and brings the wrong one forward (R27, R34).
   */
  it('will not open a session for a host the configuration does not name', async () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config({ hosts: {} }) });
    await settle();

    h.hub.receive(client, { type: 'open', sessionId: 'a-session', extensionReady: true });
    await settle();

    const notices = inbox.filter((message) => message.type === 'notice');

    expect(notices.at(-1)).toMatchObject({ message: expect.stringContaining('not running inside an application') });
  });

  /**
   * The developer's settings live in an editor that need not be open, and which repository work is tracked in
   * cannot be guessed — so a hub the browser started would report itself unconfigured however long ago they set it
   * (R35, R36). It starts on the last configuration a client gave it instead.
   */
  it('starts on the configuration a client last gave it, with no client here to give one', async () => {
    const h = harness({}, { remembered: {} });
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'refresh' });
    await settle();

    expect(latest(inbox).failures).toEqual([]);
    expect(latest(inbox).issues).not.toBeNull();
    expect(h.issueReads).toBe(1);
  });

  /** A refused configuration is one no hub should start on: remembering it would carry the mistake across restarts. */
  it('remembers the configuration it accepted, and remembers nothing it refused', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config({ refreshIntervalMs: 60_000 }) });
    await settle();

    expect(h.wrote.map((config) => config.refreshIntervalMs)).toEqual([60_000]);

    h.hub.receive(client, { type: 'configure', config: { nothing: 'the hub can read' } as unknown as HubConfig });
    await settle();

    expect(h.wrote).toHaveLength(1);
  });

  /**
   * The schema is not the only thing that refuses a configuration: a source or a host refuses ids and shapes it
   * treats as opaque. Remembering one of those would carry the mistake past the window that made it, to a hub the
   * browser starts with no editor open to correct it.
   */
  it('remembers nothing a source or a host refused, however well-formed', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config({ sources: { jira: {} } }) });
    await settle();

    expect(h.wrote).toEqual([]);

    h.hub.receive(client, { type: 'configure', config: h.config({ hosts: { 'not-an-editor': {} } }) });
    await settle();

    expect(h.wrote).toEqual([]);
  });

  /**
   * A stored configuration this hub will not run on is said out loud. Falling back to defaults in silence is how a
   * board comes to report itself unconfigured with the developer's own settings sitting on disk (R25).
   */
  it('names a stored configuration it would not start on, until a client pushes one', async () => {
    const failure = {
      subject: 'config',
      kind: 'bad-config',
      message: 'The settings this machine last accepted cannot be used: it names a claude that is not there.',
      remedy: 'Open the board in an editor to push its settings again.',
    };
    const h = harness({}, { stored: { failure } });
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'refresh' });
    await settle();

    expect(latest(inbox).failures).toContainEqual(failure);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(latest(inbox).failures).not.toContainEqual(failure);
  });

  it('names a source id no registry carries', async () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config({ sources: { jira: {} } }) });
    await settle();

    expect(latest(inbox).failures.map((f) => f.kind)).toContain('unknown-source');
  });

  it('names a host id no registry carries', async () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config({ hosts: { 'not-an-editor': {} } }) });
    await settle();

    expect(latest(inbox).failures.map((f) => f.kind)).toContain('unknown-host');
  });

  /**
   * A board that says "could not refresh" over cards it read a second ago is telling the developer something false.
   * Only a failed read is stale; a settings problem is worth stating and is a different thing (R25).
   */
  it('calls the board stale only when a read of a source failed', async () => {
    let ok = true;
    const h = harness(
      {},
      {
        fetch: async () =>
          ok
            ? { ok: true, value: ISSUES }
            : { ok: false, error: { kind: 'query-failed', message: 'GitHub failed.', remedy: 'Try again.' } },
      },
    );

    const { client } = connect(h);
    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(h.hub.snapshot().stale).toBe(false);

    h.clock.advance(2000);
    h.hub.receive(client, { type: 'configure', config: h.config({ hosts: { 'not-an-editor': {} } }) });
    await settle();

    expect(h.hub.snapshot().failures.map((f) => f.kind)).toContain('unknown-host');
    expect(h.hub.snapshot().stale).toBe(false);

    ok = false;
    h.clock.advance(2000);
    h.hub.receive(client, { type: 'refresh' });
    await settle();

    expect(h.hub.snapshot().stale).toBe(true);
  });

  /** The agent's own read failing is the other half of it: a roster nobody could read is a board out of date. */
  it('calls the board stale when the agent could not be read', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(h.hub.snapshot().stale).toBe(false);

    h.agent.failure = { subject: 'fake', kind: 'cli-missing', message: 'no CLI', remedy: 'install it' };
    h.clock.advance(2000);
    h.hub.receive(client, { type: 'refresh' });
    await settle();

    expect(h.hub.snapshot().stale).toBe(true);
  });

  /**
   * Openable is a host's answer. A board resident in one gets its own; a browser board gets the configured host's,
   * because it reaches an editor by asking the operating system for one rather than by being inside a window — so
   * what it may open cannot depend on a window happening to be open (R14, R36).
   */
  it('offers a session to a client in a host and to a browser board alike', async () => {
    const h = harness();
    h.agent.sessions = [fakeSession()];

    const inside = connect(h, hello({ id: 'inside' }));
    const browser = connect(h, hello({ id: 'browser', hostId: null }));

    h.hub.receive(inside.client, { type: 'refresh' });
    await settle();

    expect(latest(inside.inbox).openable).toEqual([fakeSession().sessionId]);
    expect(latest(browser.inbox).openable).toEqual([fakeSession().sessionId]);
  });

  /** The same gate `#open` gives a resident client: a host the configuration does not name answers for nobody. */
  it('offers a browser board nothing while the configuration names no host', async () => {
    const h = harness();
    h.agent.sessions = [fakeSession()];

    const browser = connect(h, hello({ id: 'browser', hostId: null }));

    h.hub.receive(browser.client, { type: 'configure', config: h.config({ hosts: {} }) });
    h.hub.receive(browser.client, { type: 'refresh' });
    await settle();

    expect(latest(browser.inbox).openable).toEqual([]);
  });
});

/**
 * A laptop that was asleep is the common way a board goes wrong: both readings are as old as the sleep was, and the
 * first read after the lid opens runs before the network is back. Neither is a condition the developer has to act on.
 */
describe('what the hub does when the network goes and comes back', () => {
  // Written out rather than imported, so a change to either in the hub fails a test instead of following it.
  const TICK_MS = 5_000;
  const OUTAGE_GRACE_MS = 60_000;

  const OFFLINE = {
    kind: 'offline' as const,
    message: 'GitHub could not be reached.',
    remedy: 'Waiting.',
    transient: true,
  };

  /**
   * A board that has read once, whose GitHub can be taken away and given back. Reads are asked for rather than
   * fired off the poll cadence: firing it moves the clock five minutes, which is a suspend as far as the tick knows.
   */
  async function reading() {
    let reachable = true;
    const h = harness({}, { fetch: async () => (reachable ? { ok: true, value: ISSUES } : { ok: false, error: OFFLINE }) });
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    return {
      h,
      inbox,
      cut: () => (reachable = false),
      restore: () => (reachable = true),
      /** A read now, past the second that would coalesce it with the one before. */
      reread: async () => {
        h.clock.advance(2_000);
        h.hub.receive(client, { type: 'refresh' });
        await settle();
      },
    };
  }

  it('holds the board on its last read rather than showing a banner for a network blip', async () => {
    const { inbox, cut, reread } = await reading();

    cut();
    await reread();

    // Said quietly in the meta line, not as a red notice: the board is a minute out of date and fixing itself.
    expect(latest(inbox).stale).toBe(true);
    expect(latest(inbox).failures).toEqual([]);
    expect(latest(inbox).issues).not.toBeNull();
  });

  it('retries in seconds rather than waiting out the five-minute poll, and widens as the outage holds', async () => {
    const { h, cut, reread } = await reading();

    cut();
    await reread();

    const failed = h.issueReads;

    // Every tick for the first thirty seconds, which is where a machine coming back from sleep is answered.
    for (let tick = 1; tick <= 6; tick++) {
      h.clock.fire(TICK_MS);
      await settle();

      expect(h.issueReads).toBe(failed + tick);
    }

    // Half a minute down is no longer a blip, so the gap widens to fifteen seconds: two ticks spend nothing.
    h.clock.fire(TICK_MS);
    await settle();
    h.clock.fire(TICK_MS);
    await settle();

    expect(h.issueReads).toBe(failed + 6);

    h.clock.fire(TICK_MS);
    await settle();

    expect(h.issueReads).toBe(failed + 7);
  });

  it('says so once the outage outlasts the grace, without waiting for the next try', async () => {
    const { h, inbox, cut, reread } = await reading();

    cut();
    await reread();

    for (let elapsed = 0; elapsed < OUTAGE_GRACE_MS + TICK_MS; elapsed += TICK_MS) {
      h.clock.fire(TICK_MS);
      await settle();
    }

    const offline = latest(inbox).failures.find((failure) => failure.kind === 'offline');

    expect(offline?.subject).toBe(GITHUB_SOURCE_ID);
    // Still the board it last read, under the notice: R24 forbids erasing what the developer can still act on.
    expect(latest(inbox).issues).not.toBeNull();
  });

  it('clears the notice, and the staleness, on the read that gets through', async () => {
    const { h, inbox, cut, restore, reread } = await reading();

    cut();
    await reread();

    for (let elapsed = 0; elapsed < OUTAGE_GRACE_MS + TICK_MS; elapsed += TICK_MS) {
      h.clock.fire(TICK_MS);
      await settle();
    }

    expect(latest(inbox).failures.map((failure) => failure.kind)).toContain('offline');

    restore();
    await reread();

    expect(latest(inbox).failures).toEqual([]);
    expect(latest(inbox).stale).toBe(false);
  });

  /**
   * The sleep itself. A timer that counted none of it leaves both readings as old as the sleep was, so the tick that
   * finds the gap reads now rather than letting the board show an hour-old roster until the next cadence comes round.
   */
  it('reads both sources on the first tick after a suspend, whatever the cadences were counting', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    const before = { issues: h.issueReads, sessions: h.agent.calls };

    h.clock.advance(3_600_000);
    h.clock.fire(TICK_MS);
    await settle();

    expect(h.issueReads).toBe(before.issues + 1);
    expect(h.agent.calls).toBe(before.sessions + 1);
  });

  it('leaves a tick that merely ran late alone', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    const before = { issues: h.issueReads, sessions: h.agent.calls };

    // Twenty seconds late is a loop under load. Twenty-five is a machine that was off — the threshold, pinned from
    // both sides, because a test that only tries an hour would pass on any threshold at all.
    h.clock.advance(20_000);
    h.clock.fire(TICK_MS);
    await settle();

    expect(h.issueReads).toBe(before.issues);
    expect(h.agent.calls).toBe(before.sessions);

    h.clock.advance(21_000);
    h.clock.fire(TICK_MS);
    await settle();

    expect(h.issueReads).toBe(before.issues + 1);
  });

  /** R24: a board with nothing behind it must say why it is empty, not ride out an outage in silence. */
  it('states an unreachable source at once where it has no read to hold', async () => {
    const h = harness({}, { fetch: async () => ({ ok: false, error: OFFLINE }) });
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(latest(inbox).issues).toBeNull();
    expect(latest(inbox).failures.map((failure) => failure.kind)).toContain('offline');
  });

  /** A notice restated every five seconds is the noise R25 says to state once. */
  it('says an outage once, however long it holds', async () => {
    const { h, inbox, cut, reread } = await reading();

    cut();
    await reread();

    for (let elapsed = 0; elapsed < OUTAGE_GRACE_MS + TICK_MS; elapsed += TICK_MS) {
      h.clock.fire(TICK_MS);
      await settle();
    }

    expect(latest(inbox).failures.map((failure) => failure.kind)).toContain('offline');

    // Past the grace the retries widen to fifteen seconds, so most of these ticks find nothing at all to do.
    const said = inbox.length;

    for (let elapsed = 0; elapsed < 20_000; elapsed += TICK_MS) {
      h.clock.fire(TICK_MS);
      await settle();
    }

    // One read came due in that window. Nothing else broadcast, because nothing else had anything new to say.
    expect(inbox.length - said).toBe(1);
  });

  /**
   * The developer's own asking must not cost the recovery: the ladder is stepped by how long the source has been
   * unreachable, so four presses of refresh leave the next automatic try exactly where one press would have.
   */
  it('does not spend the backoff on reads the developer asked for', async () => {
    const { h, cut, restore, reread } = await reading();

    cut();
    await reread();
    await reread();
    await reread();
    await reread();

    const failed = h.issueReads;

    restore();
    h.clock.fire(TICK_MS);
    await settle();

    expect(h.issueReads).toBe(failed + 1);
  });

  /**
   * The retry a dropped source is waiting on never comes due, because nothing reads it again. Left behind, it makes
   * the tick spend a read on every surviving source every five seconds for the life of the hub.
   */
  it('forgets an outage for a source the configuration stops naming', async () => {
    const { h, cut, reread } = await reading();
    const { client, inbox } = connect(h, hello({ id: 'board-2' }));

    cut();
    await reread();

    h.hub.receive(client, { type: 'configure', config: h.config({ sources: {} }) });
    await settle();

    const settled = inbox.length;

    for (let elapsed = 0; elapsed < 60_000; elapsed += TICK_MS) {
      h.clock.fire(TICK_MS);
      await settle();
    }

    // Nothing reads that source again, so its retry never comes due and every tick would spend one — a read of each
    // surviving source, and a write of the lane store, five seconds apart for the life of the hub.
    expect(inbox.length).toBe(settled);
  });

  /**
   * A read with no deadline can hang for as long as the network blackholes it, and the tick coalesces onto it. The
   * board would otherwise sit dimmed and silent for the whole of that, because only a finished read broadcasts.
   */
  it('says so on the grace even while the read that would have said it is still hanging', async () => {
    // A board with a read behind it, an outage the grace is riding out, and then a read that never answers: the
    // source poll carries no deadline, so a blackholed network hangs it and every tick coalesces onto that one.
    const answers = ['read', 'offline'];
    const h = harness({}, {
      fetch: () => {
        const answer = answers.shift();

        return answer === 'read'
          ? Promise.resolve({ ok: true as const, value: ISSUES })
          : answer === 'offline'
            ? Promise.resolve({ ok: false as const, error: OFFLINE })
            : new Promise<never>(() => undefined);
      },
    });
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    h.clock.advance(2_000);
    h.hub.receive(client, { type: 'refresh' });
    await settle();

    expect(latest(inbox).failures).toEqual([]);

    for (let elapsed = 0; elapsed < OUTAGE_GRACE_MS + TICK_MS; elapsed += TICK_MS) {
      h.clock.fire(TICK_MS);
      await settle();
    }

    expect(latest(inbox).failures.map((failure) => failure.kind)).toContain('offline');
    expect(latest(inbox).issues).not.toBeNull();
  });

  /**
   * A stall long enough to look like a suspend must not retract a notice the board has already given, because the
   * condition behind it has not changed. A suspend still gives an outage nobody has been told about its minute back.
   */
  it('keeps an outage it has already stated across a suspend, and gives an unstated one its minute again', async () => {
    const { h, inbox, cut, reread } = await reading();

    cut();
    await reread();

    for (let elapsed = 0; elapsed < OUTAGE_GRACE_MS + TICK_MS; elapsed += TICK_MS) {
      h.clock.fire(TICK_MS);
      await settle();
    }

    expect(latest(inbox).failures.map((failure) => failure.kind)).toContain('offline');

    h.clock.advance(3_600_000);
    h.clock.fire(TICK_MS);
    await settle();

    expect(latest(inbox).failures.map((failure) => failure.kind)).toContain('offline');
  });

  it('gives an outage nobody has been told about its minute back after a suspend', async () => {
    const { h, inbox, cut, reread } = await reading();

    cut();
    await reread();

    // Most of the grace spent, then the machine sleeps: the minute starts again rather than expiring on the way up.
    for (let elapsed = 0; elapsed < 50_000; elapsed += TICK_MS) {
      h.clock.fire(TICK_MS);
      await settle();
    }

    expect(latest(inbox).failures).toEqual([]);

    h.clock.advance(3_600_000);
    h.clock.fire(TICK_MS);
    await settle();

    h.clock.fire(TICK_MS);
    await settle();

    expect(latest(inbox).failures).toEqual([]);
    expect(latest(inbox).stale).toBe(true);
  });

  it('does not tick at all while no client is watching', () => {
    const h = harness();
    const { client } = connect(h, hello({ watching: false }));

    expect(h.clock.cadences()).toEqual([]);

    h.hub.receive(client, { type: 'watching', watching: true });

    expect(h.clock.cadences()).toContain(TICK_MS);
  });
});

describe('what the developer does', () => {
  it('writes a moved card to the machine record and tells every board', async () => {
    const h = harness();
    const first = connect(h, hello({ id: 'first' }));
    const second = connect(h, hello({ id: 'second' }));

    h.hub.receive(first.client, { type: 'move', key: 'issue:18941', lane: 'review' });
    await settle();

    expect(existsSync(lanesPathOf(home))).toBe(true);
    expect(JSON.parse(readFileSync(lanesPathOf(home), 'utf8')).placements).toEqual({ 'issue:18941': 'review' });
    expect(second.inbox.filter((m) => m.type === 'changed')).toHaveLength(1);
  });

  it('sends a resident route back to the board that asked, and to no other', async () => {
    const h = harness();
    const session = fakeSession();
    h.agent.sessions = [session];
    h.host.plan = { route: 'reveal-here', session, root: session.cwd };

    const asking = connect(h, hello({ id: 'asking' }));
    const other = connect(h, hello({ id: 'other' }));

    h.hub.receive(asking.client, { type: 'refresh' });
    await settle();
    h.hub.receive(asking.client, { type: 'open', sessionId: session.sessionId, extensionReady: true });
    await settle();

    expect(asking.inbox.filter((m) => m.type === 'perform')).toHaveLength(1);
    expect(other.inbox.filter((m) => m.type === 'perform')).toHaveLength(0);
    expect(h.host.performed).toEqual([]);
  });

  it('carries out a route the host does not call resident, rather than sending it anywhere', async () => {
    const h = harness();
    const session = fakeSession();
    h.agent.sessions = [session];
    h.host.plan = { route: 'reveal-elsewhere', session, root: session.cwd };
    h.host.resident = ['reveal-here'];

    const { client, inbox } = connect(h);
    h.hub.receive(client, { type: 'open', sessionId: session.sessionId, extensionReady: true });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(0);
    expect(h.host.performed.map((route) => route.route)).toEqual(['reveal-elsewhere']);
  });

  it('passes a refusal back by name, so the client can offer the setting that fixes it', async () => {
    const h = harness();
    h.host.plan = { refusal: 'elsewhere-not-allowed', message: 'not allowed to bring it forward' };

    const { client, inbox } = connect(h);
    h.hub.receive(client, { type: 'open', sessionId: 'anything', extensionReady: true });
    await settle();

    const notice = inbox.at(-1);
    expect(notice?.type === 'notice' && notice.refusal).toBe('elsewhere-not-allowed');
    expect(notice?.type === 'notice' && notice.message).toContain('not allowed');
  });

  it('tells a board resident in no host that it cannot open anything', async () => {
    const h = harness();
    const { client, inbox } = connect(h, hello({ hostId: null }));

    h.hub.receive(client, { type: 'open', sessionId: 'anything', extensionReady: true });
    await settle();

    const notice = inbox.at(-1);
    expect(notice?.type === 'notice' && notice.message).toContain('not running inside an application');
  });

  it('ignores every message from a client it has already let go', async () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.disconnect(client);
    const after = inbox.length;

    h.hub.receive(client, { type: 'refresh' });
    h.hub.receive(client, { type: 'move', key: 'issue:1', lane: 'done' });
    await settle();

    expect(inbox).toHaveLength(after);
    expect(existsSync(lanesPathOf(home))).toBe(false);
  });
});

describe('the activity signal', () => {
  /** Nothing is written to an agent's settings on the hub's own default, before a client has said what it wants. */
  /**
   * A developer who makes a setting wrong and puts it back does both inside the refresh floor, and what they see is
   * the broadcast rather than the read that the floor swallowed.
   */
  it('shows a setting put back, even when the read it asked for was inside the floor', async () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    const named = (): boolean => latest(inbox).failures.some((failure) => failure.kind === 'bad-config');

    h.hub.receive(client, { type: 'configure', config: h.config({ agents: [{ id: 'claude', path: 'nowhere/at/all' }] }) });
    await settle();

    expect(named()).toBe(true);

    // No clock movement at all, so the read this triggers is refused by the floor and the broadcast is all there is.
    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(named()).toBe(false);
  });

  /**
   * The message a developer gets back for turning the signal off. It rides on the configure that carried the change,
   * because a client pushes its whole configuration on every connect and a hub that answered each of those would
   * pop a message on every board that opened (R34).
   */
  it('answers a configure the developer asked to be told about, and only that one', async () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(inbox.filter((message) => message.type === 'notice')).toEqual([]);

    h.activity = { wanted: 'remove', plan: 'write', added: 0, failure: null };
    h.hub.receive(client, { type: 'configure', config: h.config({ installActivity: false }), acknowledge: true });
    await settle();

    expect(inbox.filter((message) => message.type === 'notice')).toEqual([
      { type: 'notice', level: 'info', message: 'Session activity hooks were removed. Sessions no longer report what they are doing.' },
    ]);
  });

  /** A run that changed nothing still answers: it answers an action, and "nothing to do" is the answer. */
  it('says the signal was already where the developer put it, whichever way that is', async () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    h.hub.receive(client, { type: 'configure', config: h.config(), acknowledge: true });
    await settle();

    expect(inbox.filter((message) => message.type === 'notice')).toEqual([
      { type: 'notice', level: 'info', message: 'Session activity hooks are already installed.' },
    ]);

    const off = harness();
    const second = connect(off);

    off.hub.receive(second.client, { type: 'configure', config: off.config({ installActivity: false }) });
    off.hub.receive(second.client, { type: 'configure', config: off.config({ installActivity: false }), acknowledge: true });
    await settle();

    expect(second.inbox.filter((message) => message.type === 'notice')).toEqual([
      { type: 'notice', level: 'info', message: 'Session activity hooks are already absent.' },
    ]);
  });

  it('answers with the reason when the install refused, rather than claiming it happened', async () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });

    h.activity = {
      wanted: 'install',
      plan: 'refuse',
      added: 0,
      failure: { subject: 'claude', kind: 'unreadable-settings', message: 'settings.json is not JSON', remedy: 'Fix the file and turn it back on.' },
    };
    h.hub.receive(client, { type: 'configure', config: h.config({ installActivity: false }), acknowledge: true });
    await settle();

    expect(inbox.filter((message) => message.type === 'notice')).toEqual([
      { type: 'notice', level: 'error', message: 'settings.json is not JSON' },
    ]);
  });

  it('installs nothing until a client has configured it', async () => {
    const h = harness();

    expect(h.installs).toEqual([]);

    const { client } = connect(h);

    expect(h.installs).toEqual([]);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(h.installs).toEqual(['install']);
  });

  /**
   * R30: the install reaches the agents the configuration names and no others, so the board never writes into the
   * settings of a CLI it was not asked to read. Only the argument proves it — the fake writes no file.
   */
  it('installs for the agents the configuration names, and reaches every one only to remove', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(h.installedFor).toEqual([['fake']]);

    h.clock.advance(2000);
    h.hub.receive(client, { type: 'configure', config: h.config({ installActivity: false }) });
    await settle();

    // A removal is the developer turning the hooks off, so it carries no ids: leaving another agent's entries in
    // place would leave a writer nobody maintains firing (R34).
    expect(h.installedFor).toEqual([['fake'], null]);
  });

  /**
   * The marker watcher is what turns a hook's write into a phase on a card, and it is armed per agent. An agent the
   * configuration does not name is not read at all, so watching its directory would report sessions of a CLI the
   * board was told to leave alone; and the watchers are re-armed on a change, or naming it again would arm nothing.
   */
  it('watches the marker directory only while the configuration names the agent', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config({ agents: [] }) });
    await settle();

    expect(h.watching).toBe(false);
    expect(() => h.signal([{ kind: 'created', sessionId: 'thread-1' }])).toThrow();

    h.clock.advance(2000);
    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(h.watching).toBe(true);
    // And the watcher that came back is a live one: a re-arm that only disposed would leave this reaching nothing.
    h.signal([{ kind: 'created', sessionId: 'thread-1' }]);
  });

  it('installs again when the configuration names an agent it did not name before', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    h.clock.advance(2000);
    h.hub.receive(client, {
      type: 'configure',
      config: h.config({ agents: [{ id: 'fake', path: 'claude' }, { id: 'other', path: 'other' }] }),
    });
    await settle();

    // A named agent that was not named before has no signal in place yet, so the settled run is the wrong one.
    expect(h.installedFor).toEqual([['fake'], ['fake', 'other']]);
  });

  /** R34: turning it off takes the entries away, whether or not a board is open to see it happen. */
  it('takes the signal away when the setting says so, and puts it back when it changes again', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    h.clock.advance(2000);
    h.hub.receive(client, { type: 'configure', config: h.config({ installActivity: false }) });
    await settle();

    expect(h.installs).toEqual(['install', 'remove']);

    h.clock.advance(2000);
    h.hub.receive(client, { type: 'configure', config: h.config({ installActivity: true }) });
    await settle();

    expect(h.installs).toEqual(['install', 'remove', 'install']);
  });

  /**
   * A `busy` run observed another process's lock and settled nothing. Keeping it would leave this hub reporting no
   * phase for any session for the life of the process, with nothing on screen saying why (R25).
   */
  it('tries again after a run that observed another process holding the lock', async () => {
    const h = harness();
    h.activity = { wanted: 'install', plan: 'busy', added: 0, failure: null };

    const { client } = connect(h);
    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    const tries = h.installs.length;

    expect(tries).toBeGreaterThan(0);

    h.hub.snapshot();

    expect(h.installs).toHaveLength(tries + 1);

    // And a run that settled is kept: the retry is for the lock, not a re-install on every snapshot.
    h.activity = { wanted: 'install', plan: 'write', added: 2, failure: null };
    h.hub.snapshot();
    const settled = h.installs.length;
    h.hub.snapshot();

    expect(h.installs).toHaveLength(settled);
  });

  it('puts an install failure above the lanes rather than swallowing it', async () => {
    const h = harness();
    h.activity = {
      wanted: 'install',
      plan: 'refuse',
      added: 0,
      failure: { subject: 'fake', kind: 'activity-refused', message: 'not JSON', remedy: 'fix it' },
    };

    const { client, inbox } = connect(h);
    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(latest(inbox).failures.map((f) => f.kind)).toContain('activity-refused');
  });

  /** R25: an install is announced once per board, and a second window has not read the first one's notice. */
  it('announces an install to each board once, and to a second board of its own', async () => {
    const h = harness();
    h.activity = { wanted: 'install', plan: 'write', added: 2, failure: null };

    const first = connect(h, hello({ id: 'first' }));
    h.hub.receive(first.client, { type: 'configure', config: h.config() });
    await settle();

    const said = first.inbox.filter((m) => (m.type === 'snapshot' || m.type === 'changed') && m.snapshot.hooks !== null);

    expect(said).toHaveLength(1);

    const second = connect(h, hello({ id: 'second' }));

    expect(latest(second.inbox).hooks?.notice).toContain('installed');

    h.clock.advance(2000);
    h.hub.receive(second.client, { type: 'refresh' });
    await settle();

    expect(latest(second.inbox).hooks).toBeNull();
  });
});

describe('what it does not do', () => {
  /** A board that is closed pays the same CLI spawn for an event as one on screen, with nobody to show it to. */
  it('reads nothing on an activity event once no board is watching', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'refresh' });
    await settle();

    const spawns = h.agent.calls;

    expect(spawns).toBe(1);

    h.hub.disconnect(client);
    h.signal([{ kind: 'deleted', sessionId: 'anything' }]);
    await settle();

    expect(h.agent.calls).toBe(spawns);
  });

  it('stops its timers, its watchers and its clients when it is disposed', async () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'refresh' });
    await settle();

    const spawns = h.agent.calls;
    const messages = inbox.length;

    h.hub.dispose();

    expect(h.clock.cadences()).toEqual([]);
    expect(h.watching).toBe(false);

    // Nothing reaches a client it let go, and a read that lands afterwards writes nothing back.
    h.clock.advance(2000);
    await h.hub.refresh();
    await settle();

    expect(h.agent.calls).toBe(spawns);
    expect(inbox).toHaveLength(messages);
  });

  /**
   * A change the read in flight cannot have seen: a session that ended after that read listed it would otherwise
   * sit on the board until the next poll.
   */
  it('reads again for a session that ended while it was reading', async () => {
    const h = harness();
    const ended = fakeSession();
    h.agent.sessions = [ended];

    const { client, inbox } = connect(h);
    h.hub.receive(client, { type: 'refresh' });
    await settle();

    expect(latest(inbox).sessions?.count).toBe(1);

    // A read that finishes only when the test lets it, so the marker lands while one is genuinely in flight.
    let release: (() => void) | undefined;
    h.agent.holding = new Promise<void>((resolve) => (release = resolve));

    h.clock.advance(2000);
    const reading = h.hub.refresh();

    h.agent.sessions = [];
    h.signal([{ kind: 'deleted', sessionId: ended.sessionId }]);

    release?.();
    await reading;
    await settle();
    await settle();

    expect(h.agent.calls).toBe(3);
    expect(latest(inbox).sessions?.count).toBe(0);
  });
});

describe('what it hands the host', () => {
  it('builds the open request from the roster, the client and its own clock', async () => {
    const h = harness();
    const session = fakeSession();
    h.agent.sessions = [session];
    h.host.plan = { route: 'reveal-here', session, root: session.cwd };

    const { client } = connect(h, hello({ workspaceRoot: 'd:/checkouts/project-9' }));
    h.hub.receive(client, { type: 'refresh' });
    await settle();
    h.hub.receive(client, { type: 'open', sessionId: session.sessionId, extensionReady: false });
    await settle();

    expect(h.host.planned).toHaveLength(1);
    expect(h.host.planned[0]).toMatchObject({
      sessionId: session.sessionId,
      sessions: [session],
      workspaceRoot: 'd:/checkouts/project-9',
      liveRoots: ['d:/checkouts/project-1'],
      extensionReady: false,
      now: 1_788_000_000_000,
    });
  });

  it('reads the CLI at the path the configuration named, not at the adapter default', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, {
      type: 'configure',
      config: h.config({ agents: [{ id: 'fake', path: 'claude' }] }),
    });
    await settle();

    expect(h.agent.paths).toEqual(['claude']);
  });

  it('stamps the snapshot from its own clock, so a stale board can say how old it is', () => {
    const h = harness();

    expect(h.hub.snapshot().fetchedAt).toBe(new Date(1_788_000_000_000).toISOString());
  });
});

describe('a client changing its mind', () => {
  /** A window that opens a folder, or a board that goes to the background, says so again rather than reconnecting. */
  it('takes a second hello, and re-times on the watching it carries', async () => {
    const h = harness();
    const { client } = connect(h);

    expect(h.clock.cadences()).toHaveLength(3);

    h.hub.receive(client, { type: 'hello', hello: hello({ watching: false, workspaceRoot: 'd:/checkouts/other' }) });

    expect(h.clock.cadences()).toEqual([]);

    const session = fakeSession();
    h.agent.sessions = [session];
    h.host.plan = { route: 'reveal-here', session, root: session.cwd };
    h.hub.receive(client, { type: 'hello', hello: hello({ watching: true, workspaceRoot: 'd:/checkouts/other' }) });
    await settle();
    h.hub.receive(client, { type: 'open', sessionId: session.sessionId, extensionReady: true });
    await settle();

    expect(h.clock.cadences()).toHaveLength(3);
    expect(h.host.planned[0]?.workspaceRoot).toBe('d:/checkouts/other');
  });

  it('tells a board that connects after a bad setting what is wrong with it', async () => {
    const h = harness();
    const first = connect(h, hello({ id: 'first' }));

    h.hub.receive(first.client, { type: 'configure', config: h.config({ hosts: { 'not-an-editor': {} } }) });
    await settle();

    const second = connect(h, hello({ id: 'second' }));

    expect(latest(second.inbox).failures.map((f) => f.kind)).toContain('unknown-host');
  });

  it('refuses a configuration it cannot read, and goes on polling with the one it had', async () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    const cadences = h.clock.cadences();
    h.clock.advance(2000);
    h.hub.receive(client, { type: 'configure', config: { agents: 'not a list' } as never });
    await settle();

    expect(latest(inbox).failures.map((f) => f.kind)).toEqual(['bad-config']);
    expect(h.clock.cadences()).toEqual(cadences);
    expect(h.agent.paths.at(-1)).toBe('fake-cli');
  });
});

describe('historical fallback publication', () => {
  const past = { agent: 'fake', sessionId: 'past', title: 'Past attempt', cwd: '/work/42-test', branch: '42-test', issueNumber: 42, repository: 'github.com/org/repo', updatedAt: 100 };
  const setup = () => harness({}, { remembered: {}, fetch: async () => ({ ok: true, value: { ...ISSUES, cards: [{ ...card(42), url: 'https://github.com/org/repo/issues/42' }] } }) });
  it('shares the fallback with both clients, removes it on resume and rediscovers it after exit', async () => {
    const h = setup(); let historyCalls = 0;
    h.agent.adapter.listHistory = async () => { historyCalls++; return { sessions: [past], failure: null }; };
    const { inbox } = connect(h); const browser = connect(h, hello({ id: 'browser', hostId: null }));
    await h.hub.refresh('asked');
    const shown = () => latest(inbox).lanes.flatMap((l) => l.cards)[0]!;
    expect(shown().lastSession?.sessionId).toBe('past'); expect(shown().attention).toBeNull();
    expect(latest(browser.inbox).lanes).toEqual(latest(inbox).lanes);
    expect(latest(inbox).sessions?.count).toBe(0); expect(latest(inbox).openable).toEqual([]);
    inbox.length = 0;
    await h.hub.roster();
    expect(inbox.filter((m) => m.type === 'changed')).toHaveLength(2);
    expect(inbox.filter((m) => m.type === 'changed').every((m) => m.type === 'changed' && m.snapshot.lanes.flatMap((l) => l.cards)[0]?.lastSession?.sessionId === 'past')).toBe(true);
    h.agent.sessions = [fakeSession({ sessionId: 'past', issueNumber: 42 })];
    h.agent.phases.set('past', { phase: 'running', since: 1, at: 1, event: 'UserPromptSubmit' });
    h.signal([{ kind: 'created', sessionId: 'past' }]); await settle();
    expect(shown().lastSession).toBeUndefined();
    const reads = historyCalls;
    h.signal([{ kind: 'changed', sessionId: 'past' }]); await settle(); expect(historyCalls).toBe(reads);
    h.agent.sessions = []; h.signal([{ kind: 'deleted', sessionId: 'past' }]); await settle();
    expect(shown().lastSession?.sessionId).toBe('past'); expect(historyCalls).toBe(reads + 1);
    h.hub.dispose();
  });
  /**
   * R6 through the whole path a closing window takes: the CLI stops listing the session and the hook deletes the marker it read the phase
   * from, so the last read before it went is the only chance to keep the reading. Both are dropped here, which is what a clean exit does.
   */
  it('keeps the phase of a session whose window closed, and drops it once the card has been past the developer hands', async () => {
    const h = setup();
    h.agent.adapter.listHistory = async () => ({ sessions: [past], failure: null });
    h.agent.sessions = [fakeSession({ sessionId: 'past', issueNumber: 42 })];
    h.agent.phases.set('past', { phase: 'waiting', since: 400, at: 400, event: 'Notification' });
    await h.hub.refresh('asked');

    const shown = () => h.hub.snapshot().lanes.flatMap((l) => l.cards)[0]!;

    expect(shown().attention).toBe('blocked');

    h.agent.sessions = [];
    h.agent.phases.delete('past');
    await h.hub.roster();

    expect(shown().lastSession?.sessionId).toBe('past');
    expect(shown().lastSession?.retained).toEqual({ phase: 'waiting', event: 'Notification', at: 400 });
    expect(shown().attention).toBe('blocked');

    // A departure dated after the reading, which is the one thing that ends it. `nextMemory` is what dates one; this is that date on disk.
    const store = makeLaneStore(home);

    store.write({ ...store.read(h.config().boardStatuses), pastMyHandsAt: { 'issue:42': 900 } });

    expect(shown().lastSession?.retained).toBeUndefined();
    expect(shown().attention).toBeNull();
    h.hub.dispose();
  });

  it('suppresses history on complete or partial roster failure but retains readable live sessions', async () => {
    const h = setup(); let historyCalls = 0;
    h.agent.adapter.listHistory = async () => { historyCalls++; return { sessions: [past], failure: null }; };
    await h.hub.refresh('asked'); expect(historyCalls).toBe(1);
    h.agent.failure = { subject: 'fake', kind: 'bad-response', message: 'partial', remedy: 'retry' };
    for (const live of [[], [fakeSession({ issueNumber: 99 })]]) {
      h.agent.sessions = live; await h.hub.roster();
      expect(h.hub.snapshot().lanes.flatMap((l) => l.cards).every((c) => !c.lastSession)).toBe(true);
      expect(h.hub.snapshot().sessions?.count).toBe(live.length);
    }
    expect(historyCalls).toBe(1); h.hub.dispose();
  });
  it('isolates a history failure and discards a late result from replaced settings', async () => {
    const h = setup(); h.agent.sessions = [fakeSession()];
    h.agent.adapter.listHistory = async () => { throw new Error('history access'); };
    await h.hub.refresh('asked');
    expect(h.hub.snapshot().sessions?.count).toBe(1);
    expect(h.hub.snapshot().failures.some((f) => f.kind === 'history-failed')).toBe(true);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    h.agent.adapter.listHistory = async () => { await gate; return { sessions: [past], failure: null }; };
    const reading = h.hub.roster(); await settle();
    h.hub.configure(h.config({ agents: [] })); finish(); await reading; await settle();
    expect(h.hub.snapshot().lanes.flatMap((l) => l.cards).every((c) => !c.lastSession)).toBe(true);
    expect(h.hub.snapshot().sessions?.count).toBe(0); h.hub.dispose();
  });
});

describe('opening a historical session', () => {
  const past = { agent: 'fake', sessionId: 'past', title: 'Past attempt', cwd: '/work/42-test', branch: '42-test', issueNumber: 42, repository: 'github.com/org/repo', updatedAt: 100 };
  function setup() {
    const h = harness({}, { remembered: {}, fetch: async () => ({ ok: true, value: { ...ISSUES, cards: [{ ...card(42), url: 'https://github.com/org/repo/issues/42' }] } }) });
    h.agent.adapter.listHistory = async () => ({ sessions: [past], failure: null });
    h.agent.adapter.canResume = () => true;
    h.host.adapter.openable = (live, history = []) => [...live, ...history].map((s) => s.sessionId);
    h.host.resident.push('resume-here');
    h.host.plan = { route: 'resume-here', session: past, root: past.cwd, expiresAt: h.clock.clock.now() + 30_000 };
    return h;
  }
  const ask = (h: Harness, client: ReturnType<typeof connect>['client']) => h.hub.receive(client, { type: 'open', sessionId: 'past', extensionReady: true });
  it('offers history to both boards and serializes concurrent editor clicks before window discovery', async () => {
    const h = setup();
    const first = connect(h, hello({ residentRoutes: ['resume-here'] }));
    const other = connect(h, hello({ id: 'other', residentRoutes: ['resume-here'] }));
    const browser = connect(h, hello({ id: 'browser', hostId: null }));
    await h.hub.refresh('asked');
    expect(latest(first.inbox).openable).toContain('past'); expect(latest(browser.inbox).openable).toContain('past');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.host.adapter.windows = async () => { await gate; return { live: [], holding: null }; };
    ask(h, first.client); await settle(); ask(h, other.client); await settle();
    expect(other.inbox.some((m) => m.type === 'notice' && m.refusal === 'resume-pending')).toBe(true);
    release(); await settle();
    const performed = first.inbox.filter((m) => m.type === 'perform'); expect(performed).toHaveLength(1);
    expect(h.host.planned.at(-1)?.historicalSession).toEqual(past);
    expect(performed[0]).toMatchObject({ route: { route: 'resume-here', expiresAt: h.clock.clock.now() + 30_000 } });
    h.hub.dispose();
  });
  it('uses the live reveal path if the clicked session resumed since rendering', async () => {
    const h = setup(); const { client, inbox } = connect(h);
    await h.hub.refresh('asked'); h.agent.sessions = [fakeSession({ sessionId: 'past', issueNumber: 42 })];
    h.host.plan = { route: 'reveal-here', session: h.agent.sessions[0]!, root: past.cwd };
    ask(h, client); await settle();
    expect(h.host.planned.at(-1)?.historicalSession).toBeUndefined();
    expect(inbox.some((m) => m.type === 'perform' && m.route.route === 'reveal-here')).toBe(true); h.hub.dispose();
  });
  it.each(['unreadable', 'missing', 'active-card', 'old-client'])('refuses %s instead of firing a resume', async (kind) => {
    const h = setup(); const { client, inbox } = connect(h); await h.hub.refresh('asked');
    if (kind === 'unreadable') h.agent.failure = { subject: 'fake', kind: 'bad-response', message: 'unreadable', remedy: 'retry' };
    if (kind === 'missing') h.agent.adapter.canResume = () => false;
    if (kind === 'active-card') h.agent.sessions = [fakeSession({ sessionId: 'different', issueNumber: 42 })];
    ask(h, client); await settle();
    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(0);
    expect(inbox.some((m) => m.type === 'notice')).toBe(true);
    if (kind === 'unreadable') expect(await h.hub.roster()).toBeNull(); h.hub.dispose();
  });
  it('takes a fresh active read after an older history scan finishes', async () => {
    const h = setup(); let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstRead = true;
    h.agent.adapter.listHistory = async () => { if (firstRead) { firstRead = false; await gate; } return { sessions: [past], failure: null }; };
    const poll = h.hub.refresh('asked'); await settle();
    const prefire = h.hub.roster();
    h.agent.sessions = [fakeSession({ sessionId: 'past' })]; release();
    await poll; expect((await prefire)?.map((s) => s.sessionId)).toEqual(['past']); h.hub.dispose();
  });
  it('does not let an expired window lookup use a newer click reservation', async () => {
    const h = setup();
    const first = connect(h, hello({ id: 'first', residentRoutes: ['resume-here'] }));
    const second = connect(h, hello({ id: 'second', residentRoutes: ['resume-here'] }));
    await h.hub.refresh('asked');
    let release!: () => void; let lookups = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.host.adapter.windows = async () => { if (++lookups === 1) await gate; return { live: [], holding: null }; };
    ask(h, first.client); await settle(); h.clock.advance(60_001);
    h.host.plan = { route: 'resume-here', session: past, root: past.cwd, expiresAt: h.clock.clock.now() + 30_000 };
    ask(h, second.client); await settle(); release(); await settle();
    expect(first.inbox.filter((m) => m.type === 'perform')).toHaveLength(0);
    expect(second.inbox.filter((m) => m.type === 'perform')).toHaveLength(1);
    ask(h, first.client); await settle();
    expect(first.inbox.some((m) => m.type === 'notice' && m.refusal === 'resume-pending')).toBe(true);
    h.hub.dispose();
  });
  it('expires a slow window lookup before it can launch anything', async () => {
    const h = setup(); const { client, inbox } = connect(h, hello({ residentRoutes: ['resume-here'] }));
    await h.hub.refresh('asked');
    h.host.adapter.windows = async () => { h.clock.advance(30_001); return { live: [], holding: null }; };
    ask(h, client); await settle();
    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(0);
    expect(inbox.some((m) => m.type === 'notice' && m.message.includes('expired'))).toBe(true);
    h.hub.dispose();
  });
  it('releases a refused lease and gives a fresh lease only after the old one expires', async () => {
    const h = setup(); const { client, inbox } = connect(h, hello({ residentRoutes: ['resume-here'] }));
    await h.hub.refresh('asked'); h.host.plan = { refusal: 'no-extension', message: 'missing' };
    ask(h, client); await settle();
    h.host.plan = { route: 'resume-here', session: past, root: past.cwd, expiresAt: h.clock.clock.now() + 30_000 };
    ask(h, client); await settle();
    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(1);
    h.clock.advance(60_001); h.host.plan = { ...h.host.plan, expiresAt: h.clock.clock.now() + 30_000 };
    ask(h, client); await settle(); expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(2); h.hub.dispose();
  });
});

describe('what the hub writes down about itself', () => {
  it('names the source it read and how much it got, so a quiet board can be told from a stopped loop', async () => {
    const h = harness({}, { fetch: async () => ({ ok: true, value: { ...ISSUES, cards: [card(11), card(12)] } }) });
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(h.logged).toContain('github read 2 cards in 0ms');
  });

  it('names a source it could not read, and the kind rather than the sentence the board shows', async () => {
    const h = harness(
      {},
      { fetch: async () => ({ ok: false, error: { kind: 'query-failed', message: 'GitHub failed.', remedy: 'Try again.' } }) },
    );

    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(h.logged).toContain('github could not be read after 0ms: query-failed');
  });

  it('writes down a board arriving and a board going away', async () => {
    const h = harness();
    const { client } = connect(h);

    await settle();
    h.hub.disconnect(client);

    expect(h.logged).toContain('board-1 connected from fake-host, watching');
    expect(h.logged).toContain('board-1 went away, leaving 0');
  });

  it('writes down a card the developer moved, and where to', async () => {
    const h = harness();
    const { client } = connect(h);

    await settle();
    h.hub.receive(client, { type: 'move', key: 'issue:18941', lane: 'review' });

    expect(h.logged).toContain('issue:18941 moved to review');
  });

  it('says why it refused a configuration, in the words the board is given', async () => {
    const h = harness();
    const { inbox } = connect(h);

    h.hub.configure({ agents: 'not a list' });

    const refusal = latest(inbox).failures.find((failure) => failure.subject === 'config');

    expect(refusal?.message).toBeDefined();
    expect(h.logged).toContain(`a client's settings were refused: ${refusal!.message}`);
  });

  // Every board that opens restates its settings, and a hub that wrote a line for each would say nothing else.
  it('writes a line for the settings that changed and not for the ones restated after them', async () => {
    const h = harness();
    const { client } = connect(h);
    const settings = h.config({ logLevel: 'debug' });

    h.hub.receive(client, { type: 'configure', config: settings });
    await settle();
    h.hub.receive(client, { type: 'configure', config: settings });
    await settle();

    expect(h.logged.filter((line) => line.startsWith('settings changed by a client'))).toHaveLength(1);
    expect(h.logged.filter((line) => line === 'settings restated unchanged')).toHaveLength(1);
  });

  // An agent whose CLI is missing fails every read. Twice a minute, forever, would bury everything else in the file.
  it('names a broken agent once rather than on every session read', async () => {
    const h = harness();

    const { client } = connect(h);

    h.agent.failure = { subject: 'fake', kind: 'cli-missing', message: 'no CLI', remedy: 'install it' };
    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    h.clock.fire(h.config().sessionIntervalMs);
    await settle();
    h.clock.fire(h.config().sessionIntervalMs);
    await settle();

    expect(h.logged.filter((line) => line === 'fake: no CLI')).toHaveLength(1);
  });

  it('says an agent is readable again once it comes back, and not before', async () => {
    const h = harness();

    const { client } = connect(h);

    h.agent.failure = { subject: 'fake', kind: 'cli-missing', message: 'no CLI', remedy: 'install it' };
    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(h.logged).toContain('fake: no CLI');
    expect(h.logged).not.toContain('every agent is readable again');

    h.agent.failure = null;
    h.clock.fire(h.config().sessionIntervalMs);
    await settle();

    expect(h.logged).toContain('every agent is readable again');
  });

  // The per-item detail. It is off by default, and turning it on is a setting a client pushes like any other.
  it('holds back the per-read detail until a client asks for debug', async () => {
    const h = harness();
    const { client } = connect(h);
    const before = h.agent.calls;

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    // The read happened; its line is what is missing, which is the only way this can prove the floor.
    expect(h.agent.calls).toBeGreaterThan(before);
    expect(h.logged.some((line) => line.endsWith('sessions in 0ms'))).toBe(false);

    h.hub.receive(client, { type: 'configure', config: h.config({ logLevel: 'debug' }) });
    await settle();

    // A configuration that moved only the level asks for no read the floor would allow, so the cadence supplies one.
    h.clock.fire(h.config().sessionIntervalMs);
    await settle();

    expect(h.logged.some((line) => line.endsWith('sessions in 0ms'))).toBe(true);
  });
});

describe('a client that opened a log viewer', () => {
  const LINE = '2026-09-06T19:01:24.114Z info listening on 127.0.0.1:51844';

  /** A hub.log an earlier run left behind. The directory is the hub's own to create, and it has not run yet. */
  function seedLog(text: string): void {
    mkdirSync(groundControlDirOf(home), { recursive: true });
    writeFileSync(logPathOf(home), text);
  }

  function logged(inbox: HubMessage[]): LogEntry[] {
    return inbox.flatMap((message) => (message.type === 'log' ? message.entries : []));
  }

  // The whole of "read nothing until the viewer is open": the hub has plenty to say by now and says none of it here.
  it('is sent nothing about the log until it asks, however much the hub has written', async () => {
    const h = harness();
    const { inbox } = connect(h);

    await settle();

    expect(h.logged.length).toBeGreaterThan(0);
    expect(logged(inbox)).toEqual([]);
  });

  it('is handed the tail of hub.log the moment it asks', () => {
    seedLog(`${LINE}\n`);

    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'watchLog', watching: true });

    expect(logged(inbox)).toEqual([
      { at: '2026-09-06T19:01:24.114Z', level: 'info', source: 'hub', message: 'listening on 127.0.0.1:51844' },
    ]);
  });

  // The backfill comes off disk, so it carries the hub before this one — which is the case a restart leaves behind.
  it('is handed lines an earlier hub wrote, not only this one', () => {
    seedLog(`2026-09-05T08:00:00.000Z error could not listen on 127.0.0.1\n`);

    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'watchLog', watching: true });

    expect(logged(inbox).map((entry) => entry.message)).toEqual(['could not listen on 127.0.0.1']);
  });

  it('is sent each line as it is written, once it has asked', () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'watchLog', watching: true });
    h.hub.receive(client, { type: 'move', key: 'issue:18941', lane: 'review' });

    expect(logged(inbox).map((entry) => entry.message)).toContain('issue:18941 moved to review');
  });

  it('is sent nothing more once it closes the viewer', () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'watchLog', watching: true });
    h.hub.receive(client, { type: 'watchLog', watching: false });
    h.hub.receive(client, { type: 'move', key: 'issue:18941', lane: 'review' });

    expect(logged(inbox).map((entry) => entry.message)).not.toContain('issue:18941 moved to review');
  });

  // A stream that went away must take its subscription with it, or the hub writes into a response that has ended.
  it('stops being sent lines when its stream goes', () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'watchLog', watching: true });
    h.hub.disconnect(client);

    const before = logged(inbox).length;

    h.hub.receive(client, { type: 'move', key: 'issue:18941', lane: 'review' });

    expect(logged(inbox)).toHaveLength(before);
  });

  it('sends one client its lines without sending them to a client that never asked', () => {
    const h = harness();
    const reader = connect(h, hello({ id: 'board-reading' }));
    const other = connect(h, hello({ id: 'board-quiet' }));

    h.hub.receive(reader.client, { type: 'watchLog', watching: true });
    h.hub.receive(reader.client, { type: 'move', key: 'issue:18941', lane: 'review' });

    expect(logged(reader.inbox).map((entry) => entry.message)).toContain('issue:18941 moved to review');
    expect(logged(other.inbox)).toEqual([]);
  });

  // Reading the log is not a board on screen. Turning the loop on for one would spend a CLI spawn every thirty
  // seconds for a window nobody is looking at (R35).
  it('does not start the poll loop', () => {
    const h = harness();
    const { client } = connect(h, hello({ watching: false }));

    h.hub.receive(client, { type: 'watchLog', watching: true });

    expect(h.clock.cadences()).toEqual([]);
  });
});

/**
 * A window on a card's checkout, and no agent in it. The root is never the client's to name: it is whatever the
 * hub resolved for that card, which is what makes the same message safe from a browser overlay.
 */
describe('opening a card in an editor', () => {
  /** A real directory, because a root is offered only where it reads back — a deleted one refuses everything (§23). */
  function checkoutDir(name = 'project-1'): string {
    const root = join(home, name);
    mkdirSync(root, { recursive: true });

    return root;
  }

  async function boardWith(root: string, residentRoutes = ['reveal-here', 'open-checkout']) {
    const h = harness();
    const { client, inbox } = connect(h, hello({ residentRoutes }));

    h.agent.sessions = [fakeSession({ cwd: root, checkoutRoot: root })];
    h.hub.receive(client, { type: 'refresh' });
    await settle();

    return { h, client, inbox };
  }

  it('sends the client a route to the checkout the hub resolved, never one the client named', async () => {
    const root = checkoutDir();
    const { h, client, inbox } = await boardWith(root);
    const key = h.hub.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key;

    h.host.resident = ['reveal-here', 'open-checkout'];
    h.host.checkoutPlan = { route: 'open-checkout', key, root, newWindow: true };
    h.hub.receive(client, { type: 'openCheckout', key });
    await settle();

    expect(h.host.checkoutsPlanned.at(-1)).toMatchObject({ key, root });
    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(1);
  });

  it('refuses a card with no checkout by name, rather than opening a directory it invented', async () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.agent.sessions = [fakeSession({ cwd: join(home, 'gone'), checkoutRoot: join(home, 'gone') })];
    h.hub.receive(client, { type: 'refresh' });
    await settle();

    const key = h.hub.snapshot().lanes.flatMap((lane) => lane.cards)[0]?.key;

    // Named, so this cannot pass by falling down the same branch a card that was never built would take.
    expect(key).toBeDefined();

    h.hub.receive(client, { type: 'openCheckout', key: key! });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(0);
    expect(inbox.filter((m) => m.type === 'notice').at(-1)).toMatchObject({ refusal: 'no-checkout' });
  });

  it('passes on the host’s own refusal rather than reaching for a window anyway', async () => {
    const root = checkoutDir();
    const { h, client, inbox } = await boardWith(root);
    const key = h.hub.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key;

    h.host.checkoutPlan = { refusal: 'already-here', message: 'This window is already open on it.' };
    h.hub.receive(client, { type: 'openCheckout', key });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(0);
    expect(inbox.filter((m) => m.type === 'notice').at(-1)).toMatchObject({ refusal: 'already-here' });
  });

  // A client that has not reloaded since the route was added would be sent something it cannot carry out, and the
  // click would land nowhere with nothing said.
  it('tells a client that cannot perform the route to reload, rather than sending it', async () => {
    const root = checkoutDir();
    const { h, client, inbox } = await boardWith(root, ['reveal-here']);

    h.host.resident = ['reveal-here', 'open-checkout'];
    const key = h.hub.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key;

    h.host.checkoutPlan = { route: 'open-checkout', key, root, newWindow: false };
    h.hub.receive(client, { type: 'openCheckout', key });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(0);
    expect(inbox.filter((m) => m.type === 'notice').at(-1)).toMatchObject({ message: expect.stringContaining('Reload') });
  });

  /**
   * The one route a client that cannot perform it may ask for. It names a directory rather than a session, so any
   * editor client carries it out identically — which is what lets the overlay ask (R41).
   */
  it('has an editor client open the window when the browser overlay is the one that asked', async () => {
    const root = checkoutDir();
    const { h, inbox } = await boardWith(root);
    const overlay = connect(h, hello({ id: 'overlay', hostId: null, workspaceRoot: null, residentRoutes: [] }));
    const key = h.hub.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key;

    h.host.resident = ['reveal-here', 'open-checkout'];
    h.host.checkoutPlan = { route: 'open-checkout', key, root, newWindow: true };
    h.hub.receive(overlay.client, { type: 'openCheckout', key });
    await settle();

    // The editor performs it; the browser that asked is sent nothing to perform, having no way to.
    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(1);
    expect(inbox.filter((m) => m.type === 'perform').at(-1)).toMatchObject({ route: { key, root } });
    expect(overlay.inbox.filter((m) => m.type === 'perform')).toHaveLength(0);

    // The plan is the hub's, built from the card. A browser names no workspace root, so nothing about where the
    // overlay is looking reaches the planner.
    expect(h.host.checkoutsPlanned.at(-1)).toMatchObject({ key, root, workspaceRoot: null });
  });

  /**
   * The window a board is open in is a window the hub knows about directly. The host enumerates only the windows an
   * agent has announced itself in, so one running no agent is invisible there — and `code --new-window` on a folder
   * it already holds opens a second window on it, re-running that folder's tasks.
   */
  it('counts a connected board’s own window, so a checkout with one open is raised rather than opened twice', async () => {
    const root = checkoutDir();
    const { h } = await boardWith(root);
    const onRoot = connect(h, hello({ id: 'board-on-root', workspaceRoot: root, residentRoutes: ['reveal-here', 'open-checkout'] }));
    const overlay = connect(h, hello({ id: 'overlay', hostId: null, workspaceRoot: null, residentRoutes: [] }));
    const key = h.hub.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key;

    h.host.resident = ['reveal-here', 'open-checkout'];
    h.hub.receive(overlay.client, { type: 'openCheckout', key });
    await settle();

    expect(h.host.checkoutsPlanned.at(-1)?.liveWindows).toContainEqual({ folders: [root] });
    // And it is that window's own board that performs it, rather than whichever one connected first.
    expect(onRoot.inbox.filter((m) => m.type === 'perform')).toHaveLength(1);
  });

  // One card's window at a time. A script on the page the overlay paints into could otherwise fire every card's
  // item at once, and each is a `code` spawn on a folder VS Code trusts.
  it('drops a second ask for one card while its window is on its way', async () => {
    const root = checkoutDir();
    const { h, client, inbox } = await boardWith(root);
    const key = h.hub.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key;

    h.host.resident = ['reveal-here', 'open-checkout'];
    h.host.checkoutPlan = { route: 'open-checkout', key, root, newWindow: true };
    h.hub.receive(client, { type: 'openCheckout', key });
    await settle();
    h.hub.receive(client, { type: 'openCheckout', key });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(1);

    h.clock.advance(12_001);
    h.hub.receive(client, { type: 'openCheckout', key });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(2);
  });

  // A window opens where the developer clicked. Taking the first connected client instead would open it from
  // whichever window happened to connect first, which on three open windows is arbitrary.
  it('has the editor board that asked perform its own open, rather than another window’s', async () => {
    const root = checkoutDir();
    const { h, inbox } = await boardWith(root);
    const second = connect(h, hello({ id: 'board-2', residentRoutes: ['reveal-here', 'open-checkout'] }));
    const key = h.hub.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key;

    h.host.resident = ['reveal-here', 'open-checkout'];
    h.host.checkoutPlan = { route: 'open-checkout', key, root, newWindow: true };
    h.hub.receive(second.client, { type: 'openCheckout', key });
    await settle();

    expect(second.inbox.filter((m) => m.type === 'perform')).toHaveLength(1);
    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(0);
  });

  // Which message is right turns on why there is no performer, not on who asked: an editor board running a build
  // that predates the route is told to reload, whoever asked on its behalf.
  it('tells the overlay to reload an editor that is running but cannot perform the route', async () => {
    const root = checkoutDir();
    const { h } = await boardWith(root, ['reveal-here']);
    const overlay = connect(h, hello({ id: 'overlay', hostId: null, workspaceRoot: null, residentRoutes: [] }));
    const key = h.hub.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key;

    h.host.resident = ['reveal-here', 'open-checkout'];
    h.host.checkoutPlan = { route: 'open-checkout', key, root, newWindow: true };
    h.hub.receive(overlay.client, { type: 'openCheckout', key });
    await settle();

    expect(overlay.inbox.filter((m) => m.type === 'notice').at(-1)).toMatchObject({
      message: expect.stringContaining('Reload'),
    });
  });

  // A headless hub can open a window but cannot bring one forward (§26), so this is honest rather than a silent
  // nothing — and it names the remedy, which is opening the board in an editor at all.
  it('tells the overlay no editor is running rather than opening a window it cannot raise', async () => {
    const h = harness();
    const overlay = connect(h, hello({ id: 'overlay', hostId: null, workspaceRoot: null, residentRoutes: [] }));
    const root = checkoutDir();

    h.host.resident = ['open-checkout'];
    h.agent.sessions = [fakeSession({ cwd: root, checkoutRoot: root })];
    h.hub.receive(overlay.client, { type: 'refresh' });
    await settle();

    const key = h.hub.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key;

    h.host.checkoutPlan = { route: 'open-checkout', key, root, newWindow: true };
    h.hub.receive(overlay.client, { type: 'openCheckout', key });
    await settle();

    expect(overlay.inbox.filter((m) => m.type === 'perform')).toHaveLength(0);
    expect(overlay.inbox.filter((m) => m.type === 'notice').at(-1)).toMatchObject({
      message: expect.stringContaining('not running in an editor'),
    });
  });
});

/**
 * A new session on a card. Nothing the board's own runs are gated on gates this: R33 bounds what the board starts,
 * and a developer starting a second attempt on a card is R3, not R18's "already open somewhere".
 */
describe('starting a session on a card', () => {
  async function boardWith(residentRoutes = ['reveal-here', 'start-session']) {
    const root = join(home, 'project-1');
    mkdirSync(root, { recursive: true });

    const h = harness();
    const { client, inbox } = connect(h, hello({ residentRoutes, workspaceRoot: root }));

    h.host.resident = ['reveal-here', 'start-session'];
    h.agent.sessions = [fakeSession({ cwd: root, checkoutRoot: root })];
    h.hub.receive(client, { type: 'refresh' });
    await settle();

    const key = h.hub.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key;
    h.host.startPlan = { route: 'start-session', key, agent: 'claude', root, prompt: null };

    return { h, client, inbox, key, root };
  }

  it('sends the client a route built from the checkout the hub resolved, and the agent it named', async () => {
    const { h, client, inbox, key, root } = await boardWith();

    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();

    expect(h.host.startsPlanned.at(-1)).toMatchObject({ key, agent: 'claude', root, extensionReady: true });
    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(1);
  });

  it('refuses a card with no checkout by name, rather than starting somewhere it invented', async () => {
    const h = harness();
    const { client, inbox } = connect(h, hello({ residentRoutes: ['start-session'] }));

    h.agent.sessions = [fakeSession({ cwd: join(home, 'gone'), checkoutRoot: join(home, 'gone') })];
    h.hub.receive(client, { type: 'refresh' });
    await settle();

    const key = h.hub.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key;

    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();

    expect(h.host.startsPlanned).toEqual([]);
    expect(inbox.filter((m) => m.type === 'notice').at(-1)).toMatchObject({ refusal: 'no-checkout' });
  });

  it('passes on the host’s own refusal rather than starting anything', async () => {
    const { h, client, inbox, key } = await boardWith();

    h.host.startPlan = { refusal: 'checkout-elsewhere', message: 'Open that checkout first.' };
    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(0);
    expect(inbox.filter((m) => m.type === 'notice').at(-1)).toMatchObject({ refusal: 'checkout-elsewhere' });
  });

  it('tells a client that cannot perform the route to reload, rather than sending it', async () => {
    const { h, client, inbox, key } = await boardWith(['reveal-here']);

    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(0);
    expect(inbox.filter((m) => m.type === 'notice').at(-1)).toMatchObject({ message: expect.stringContaining('Reload') });
  });

  // Two boards, or two clicks: no session exists between the click and the agent minting one (§48), so the card is
  // the only thing there is to tell a second from the first by.
  it('holds one card’s start against a second while the first is in flight', async () => {
    const { h, client, inbox, key } = await boardWith();

    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();
    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(1);
    expect(inbox.filter((m) => m.type === 'notice').at(-1)).toMatchObject({ message: expect.stringContaining('already being started') });
  });

  // Both items sit in the same menu. Holding by the card alone would make starting Claude swallow the click that
  // starts Codex, which is nothing R42 asks for.
  it('does not let one agent’s start hold off the other’s on the same card', async () => {
    const { h, client, inbox, key, root } = await boardWith();

    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();

    h.host.startPlan = { route: 'start-session', key, agent: 'codex', root, prompt: null };
    h.hub.receive(client, { type: 'startSession', key, agent: 'codex', extensionReady: true });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(2);
  });

  // Nothing reports a start's outcome back, so the lease expires rather than being released — which is why it is
  // sized to the double-click it exists for rather than to how long a session takes to appear.
  it('lets the same card and agent be started again once the lease has run out', async () => {
    const { h, client, inbox, key } = await boardWith();

    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();
    h.clock.advance(10_001);
    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(2);
  });

  // Every route follows this rule, and a start has no headless fallback to be handed to instead (§26).
  it('refuses a route the host itself does not call resident, rather than sending it', async () => {
    const { h, client, inbox, key } = await boardWith();

    h.host.resident = ['reveal-here'];
    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(0);
    expect(h.host.performed).toEqual([]);
  });

  // The prompt is the hub's to build: the card's facts are its own, and a client naming one would be a client
  // naming what an agent is told to do.
  it('fills the configured prompt from the card and hands the result to the host', async () => {
    const { h, client, key, root } = await boardWith();

    h.hub.configure({ ...h.config(), newSession: { prompt: 'Work on #{issue} in {checkout}. Not {nonsense}.' } });
    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();

    expect(h.host.startsPlanned.at(-1)?.prompt).toBe(`Work on #18941 in ${root}. Not {nonsense}.`);
  });

  // R39's rule is the card action's, not this one's: nothing here runs unattended, so an unset prompt is a bare
  // session rather than a refusal.
  it('starts a bare session where no prompt is configured', async () => {
    const { h, client, key } = await boardWith();

    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();

    expect(h.host.startsPlanned.at(-1)?.prompt).toBeNull();
  });

  it('carries the host’s startable agents to a client, so a card can offer one item per agent', async () => {
    const h = harness();
    const { client, inbox } = connect(h, hello({ residentRoutes: ['start-session'] }));

    h.hub.receive(client, { type: 'refresh' });
    await settle();

    expect(inbox.filter((m) => m.type === 'snapshot' || m.type === 'changed').at(-1)).toMatchObject({
      snapshot: { startable: [{ agent: 'claude', takesPrompt: true }] },
    });
  });

  /**
   * The bridge gives a browser client `hostId: null`, and `#hostFor` answers the single configured host for one —
   * so reading the host alone would offer the overlay items that could only ever refuse (R42).
   */
  it('offers no start to a client that cannot perform the route, which is every browser board', async () => {
    const h = harness();
    const { client, inbox } = connect(h, hello({ id: 'overlay', hostId: null, workspaceRoot: null, residentRoutes: [] }));

    h.hub.receive(client, { type: 'refresh' });
    await settle();

    // Named, so this cannot pass by the client having been sent no snapshot at all.
    const snapshots = inbox.filter((m) => m.type === 'snapshot' || m.type === 'changed');

    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.at(-1)).toMatchObject({ snapshot: { startable: [] } });
  });
});

/** The folder the developer chose. Checked against the card's own repository before it is stored, never taken. */
describe('choosing a card’s folder', () => {
  /** A real repository URL, because the pick is checked by comparing it against the folder's own origin remote. */
  const PICKABLE: IssueCard = { ...card(19002), url: 'https://github.com/example-org/example-repo/issues/19002' };

  it('refuses a folder that is not a checkout of that card’s repository', async () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.agent.sessions = [fakeSession()];
    h.hub.receive(client, { type: 'refresh' });
    await settle();

    const key = h.hub.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key;
    const elsewhere = join(home, 'not-a-checkout');
    mkdirSync(elsewhere, { recursive: true });

    h.hub.receive(client, { type: 'setCheckout', key, root: elsewhere });
    await settle();

    expect(makeCheckoutStore(home).read()).toEqual({});
    expect(inbox.filter((m) => m.type === 'notice').at(-1)).toMatchObject({ message: expect.stringContaining('not a checkout') });
  });

  it('stores a folder that is a checkout of the card, and puts it on the card', async () => {
    const h = harness({}, { fetch: async () => ({ ok: true, value: { ...ISSUES, cards: [PICKABLE], matched: 1, totalAssigned: 1 } }) });
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    const picked = join(home, 'refund-window');
    mkdirSync(join(picked, '.git'), { recursive: true });
    writeFileSync(join(picked, '.git', 'config'), '[remote "origin"]\n url = https://github.com/example-org/example-repo.git');

    const key = h.hub.snapshot().lanes.flatMap((lane) => lane.cards).find((card) => card.issue !== null)!.key;

    h.hub.receive(client, { type: 'setCheckout', key, root: picked });
    await settle();

    // Stored as the board spells every other path, so a pick and a session's own cwd compare as one directory.
    const stored = picked.replace(/\\/g, '/');

    expect(makeCheckoutStore(home).read()[key]).toBe(stored);
    expect(h.hub.snapshot().lanes.flatMap((lane) => lane.cards).find((card) => card.key === key)?.checkout).toEqual({
      root: stored,
      source: 'remembered',
      only: true,
    });
    expect(inbox.filter((m) => m.type === 'changed').length).toBeGreaterThan(0);
  });

  // A relative path resolves against the hub's own working directory here and against the editor's there, so the
  // two would disagree about which folder was meant.
  it('refuses a folder that is not named absolutely', async () => {
    const h = harness({}, { fetch: async () => ({ ok: true, value: { ...ISSUES, cards: [PICKABLE], matched: 1, totalAssigned: 1 } }) });
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    const key = h.hub.snapshot().lanes.flatMap((lane) => lane.cards).find((card) => card.issue !== null)!.key;

    h.hub.receive(client, { type: 'setCheckout', key, root: 'refund-window' });
    await settle();

    expect(makeCheckoutStore(home).read()).toEqual({});
  });

  it('refuses a card that is no longer on the board', async () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'setCheckout', key: 'issue:404', root: home });
    await settle();

    expect(makeCheckoutStore(home).read()).toEqual({});
    expect(inbox.filter((m) => m.type === 'notice').at(-1)).toMatchObject({ message: expect.stringContaining('no longer on the board') });
  });
});
