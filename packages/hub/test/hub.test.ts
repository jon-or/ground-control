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
import { DEFAULT_SESSION_SCOPE, groundControlDirOf } from '@ground-control/core';
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

/** Inject GitHub responses without network requests or CLI processes. */
type Fetch = (config: GithubConfig) => Promise<Result<AssignedIssues>>;

/** Source issue fixture; author determines PR ownership for lane inference. */
function card(number: number, author: string | null = null): IssueCard {
  return {
    number,
    title: `Issue ${number}`,
    type: null,
    typeColor: null,
    url: `https://github.com/example-org/example-repo/issues/${number}`,
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
  /** Assert watcher registration before testing delivered events. */
  watching: boolean;
  agent: FakeAgentControl;
  host: FakeHostControl;
  clock: ReturnType<typeof fakeClock>;
  /** Messages grouped by client ID for delivery assertions. */
  sent: Map<string, HubMessage[]>;
  /** Injected watcher callback for each marker batch. */
  signal(changes: { kind: 'created' | 'changed' | 'deleted'; sessionId: string }[]): void;
  issueReads: number;
  /** Activity installation requests in call order. */
  installs: ('install' | 'remove')[];
  /** Agent IDs requested for installation, or null for all agents. */
  installedFor: (readonly string[] | null)[];
  /** Next installation result, or null when unchanged. */
  activity: ActivityState | null;
  detected: string[];
  config(over?: Partial<HubConfig>): HubConfig;
  /** Persisted configurations; rejected settings must not appear. */
  wrote: HubConfig[];
  /** Recorded log messages for diagnostic assertions. */
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

  // Use the real source with injected reads to test configuration, refusals, and account detection without duplicating its logic.
  const github = makeGithubSource({
    fetch: (config) => {
      counts.issues += 1;

      return extra.fetch ? extra.fetch(config) : Promise.resolve({ ok: true, value: ISSUES });
    },
    detectLogins: async () => detected,
    // Inject issue lookups so session-only references cannot spawn gh in tests.
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
    // Preload stored configuration to model browser startup without an editor connection.
    settings: {
      read: () => (extra.remembered ? { config: shape.config(extra.remembered) } : (extra.stored ?? null)),
      write: (config) => {
        shape.wrote.push(config);
      },
    },
    // Fake installation to avoid settings writes; record arguments to verify removal requests.
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

/** Complete pending promises; injected reads resolve without timers. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Require the final client message to be a snapshot before reading it. */
function latest(inbox: HubMessage[]): Snapshot {
  const last = inbox.at(-1);

  if (last?.type !== 'snapshot' && last?.type !== 'changed') {
    throw new Error(`the last message was ${last?.type ?? 'nothing'}, not a snapshot`);
  }

  return last.snapshot;
}

describe('what the hub polls', () => {
  it('polls only while a client is watching', async () => {
    const h = harness();

    expect(h.clock.cadences()).toEqual([]);

    const { client } = connect(h, hello({ watching: false }));

    expect(h.clock.cadences()).toEqual([]);

    h.hub.receive(client, { type: 'watching', watching: true });
    await settle();

    // Assert literal polling intervals: 30-second sessions, five-minute sources, and a five-second maintenance tick.
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

  /** Use separate timers for network sources and local CLI reads (M2). */
  it('uses separate source and session polling intervals', async () => {
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

    // Expect configured source/session timers plus the fixed maintenance tick.
    expect(h.clock.cadences()).toEqual([5_000, 5_000, 60_000]);
  });

  /** Coalesce repeated refresh clicks into one roster read. */
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

  /** Throttle visibility-triggered network reads during tab switches (R35). */
  it('reuses cached cards when shown again within one minute', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    const before = { issues: h.issueReads, sessions: h.agent.calls };

    h.clock.advance(59_000);
    h.hub.receive(client, { type: 'watching', watching: false });
    h.hub.receive(client, { type: 'watching', watching: true });
    await settle();

    // Still refresh the local session roster to detect ended sessions.
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

    // Equivalent settings, including reordered keys, must not trigger new reads on connection.
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

  /** A manual refresh following visibility must use the manual source interval. */
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

  /** Changed settings require a new read after the current request completes. */
  it('rereads after settings change during an active request', async () => {
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

    // Confirm the replacement read remains queued while the old read is pending.
    expect(repos).toHaveLength(1);

    waiting.shift()?.();
    await settle();

    expect(repos).toEqual(['example-org/example-repo', 'example-org/other-repo']);

    waiting.shift()?.();
    await settle();
  });

  /** Preserve timers on visibility updates so repeated toggles cannot postpone polling indefinitely. */
  it('preserves timers when client state is unchanged', () => {
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

  /** Suppress event-triggered retries when all roster reads fail. */
  it('does not ask an unreadable CLI again on every marker', async () => {
    const h = harness();
    h.agent.failure = { subject: 'fake', kind: 'cli-missing', message: 'no CLI', remedy: 'install it' };

    const { client, inbox } = connect(h);
    h.hub.receive(client, { type: 'refresh' });
    await settle();

    const spawns = h.agent.calls;

    // Verify the read count changes so an unregistered watcher cannot pass.
    expect(spawns).toBe(1);

    h.signal([{ kind: 'deleted', sessionId: 'whatever' }]);
    await settle();

    expect(h.agent.calls).toBe(1);
    expect(latest(inbox).failures.map((f) => f.kind)).toContain('cli-missing');
  });
});

describe('snapshot state', () => {
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

  /** Return missing settings and detected accounts for client selection. */
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

  /** Read only configured, registered sources. */
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

  /** Remove cards for sources no longer configured. */
  it('clears removed-source data and failures', async () => {
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

  /** Combine source counts, use the oldest read timestamp, and infer ownership from each read's logins. */
  it('merges what every source read, and is as old as the oldest of them', async () => {
    const other: WorkSource = {
      id: 'other-source',
      displayName: 'Another source',
      configure: () => null,
      read: async () => ({
        items: {
          // Use the source-read account to identify the PR as the developer's.
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
    // The combined board timestamp must use the older source read.
    expect(issues?.fetchedAt).toBe('2026-09-03T08:00:00Z');
    expect(lanes.find((lane) => lane.cards.some((c) => c.issueNumber === 4521))?.id).toBe('review');
  });

  /** Retain issue metadata after unassignment while a session still references it (R9). */
  it('retains unassigned issue metadata and archives after sessions end', async () => {
    // Use the same repository key for the stored issue and session.
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

  it('keeps checkout cards until issue lookup succeeds', async () => {
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

  /** Clear cards when the source configuration becomes invalid. */
  it('takes down what a source read once its settings are refused', async () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(latest(inbox).issues).not.toBeNull();

    // Without advancing time, configuration refusal must clear cards before another read.
    h.hub.receive(client, { type: 'configure', config: h.config({ sources: { github: { repo: '' } } }) });
    await settle();

    expect(latest(inbox).issues).toBeNull();
    expect(latest(inbox).failures.map((f) => f.kind)).toContain('bad-config');
  });

  /** No readable source means stale data, whether caused by failed reads or rejected settings (R24, R25). */
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

  /** New connections must preserve existing configuration errors. */
  it('leaves a refused configuration named when another client connects', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: { nothing: 'the hub can read' } as unknown as HubConfig });
    await settle();

    const refusal = () => h.hub.snapshot().failures.map((f) => f.message);

    expect(refusal()).toContainEqual(expect.stringContaining("Could not read settings:"));

    connect(h, hello({ id: 'board-2' }));

    expect(refusal()).toContainEqual(expect.stringContaining("Could not read settings:"));
  });

  /** Convert source exceptions to failures without aborting other source updates. */
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

  /** Do not use an unconfigured host's defaults to select editor windows (R27, R34). */
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

  /** Load saved settings for browser-started hubs without an editor open (R35, R36). */
  it('starts on the configuration a client last gave it, with no client here to give one', async () => {
    const h = harness({}, { remembered: {} });
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'refresh' });
    await settle();

    expect(latest(inbox).failures).toEqual([]);
    expect(latest(inbox).issues).not.toBeNull();
    expect(h.issueReads).toBe(1);
  });

  /** Never persist rejected configuration across restarts. */
  it('persists accepted configurations only', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config({ refreshIntervalMs: 60_000 }) });
    await settle();

    expect(h.wrote.map((config) => config.refreshIntervalMs)).toEqual([60_000]);

    h.hub.receive(client, { type: 'configure', config: { nothing: 'the hub can read' } as unknown as HubConfig });
    await settle();

    expect(h.wrote).toHaveLength(1);
  });

  /** Persist only settings accepted by both schema and adapters, including browser-started hub configuration. */
  it('does not persist adapter-rejected configurations', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config({ sources: { jira: {} } }) });
    await settle();

    expect(h.wrote).toEqual([]);

    h.hub.receive(client, { type: 'configure', config: h.config({ hosts: { 'not-an-editor': {} } }) });
    await settle();

    expect(h.wrote).toEqual([]);
  });

  /** Report invalid stored settings instead of silently using defaults (R25). */
  it('names a stored configuration it would not start on, until a client pushes one', async () => {
    const failure = {
      subject: 'config',
      kind: 'bad-config',
      message: 'Saved hub settings are invalid: it names a claude that is not there.',
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

  /** Host configuration errors must not mark successful source reads stale (R25). */
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

  /** A failed roster read also marks the board stale. */
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

  /** Use resident-host opening capabilities for editors and the configured host for Chrome, even without an open editor window (R14, R36). */
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

  /** Unconfigured hosts provide no opening capabilities. */
  it('offers no browser routes without a configured host', async () => {
    const h = harness();
    h.agent.sessions = [fakeSession()];

    const browser = connect(h, hello({ id: 'browser', hostId: null }));

    h.hub.receive(browser.client, { type: 'configure', config: h.config({ hosts: {} }) });
    h.hub.receive(browser.client, { type: 'refresh' });
    await settle();

    expect(latest(browser.inbox).openable).toEqual([]);
  });
});

/** Refresh after suspend and tolerate temporary network failure during resume. */
describe('network outage and recovery', () => {
  // Use literal thresholds so implementation changes can fail the test.
  const TICK_MS = 5_000;
  const OUTAGE_GRACE_MS = 60_000;

  const OFFLINE = {
    kind: 'offline' as const,
    message: 'GitHub could not be reached.',
    remedy: 'Waiting.',
    transient: true,
  };

  /** Start from cached data and manually trigger source failures/recovery; normal five-minute polling would also simulate suspend. */
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
      /** Advance beyond refresh coalescing before requesting another read. */
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

    // During the grace period, mark cached data stale without an error notice.
    expect(latest(inbox).stale).toBe(true);
    expect(latest(inbox).failures).toEqual([]);
    expect(latest(inbox).issues).not.toBeNull();
  });

  it('retries in seconds rather than waiting out the five-minute poll, and widens as the outage holds', async () => {
    const { h, cut, reread } = await reading();

    cut();
    await reread();

    const failed = h.issueReads;

    // Retry on every tick during the first 30 seconds of an outage.
    for (let tick = 1; tick <= 6; tick++) {
      h.clock.fire(TICK_MS);
      await settle();

      expect(h.issueReads).toBe(failed + tick);
    }

    // After 30 seconds, widen retry intervals to 15 seconds.
    h.clock.fire(TICK_MS);
    await settle();
    h.clock.fire(TICK_MS);
    await settle();

    expect(h.issueReads).toBe(failed + 6);

    h.clock.fire(TICK_MS);
    await settle();

    expect(h.issueReads).toBe(failed + 7);
  });

  it('reports an outage when its grace period expires before retry', async () => {
    const { h, inbox, cut, reread } = await reading();

    cut();
    await reread();

    for (let elapsed = 0; elapsed < OUTAGE_GRACE_MS + TICK_MS; elapsed += TICK_MS) {
      h.clock.fire(TICK_MS);
      await settle();
    }

    const offline = latest(inbox).failures.find((failure) => failure.kind === 'offline');

    expect(offline?.subject).toBe(GITHUB_SOURCE_ID);
    // Retain cached cards after reporting the outage (R24).
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

  /** A suspend gap triggers immediate refresh of both sources and sessions. */
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

    // Check both sides of suspend detection: 20 seconds late is below the threshold, 25 seconds is above it.
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

  /** Report an outage immediately when no cached data exists (R24). */
  it('states an unreachable source at once where it has no read to hold', async () => {
    const h = harness({}, { fetch: async () => ({ ok: false, error: OFFLINE }) });
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(latest(inbox).issues).toBeNull();
    expect(latest(inbox).failures.map((failure) => failure.kind)).toContain('offline');
  });

  /** Report each outage once (R25). */
  it('reports each outage once', async () => {
    const { h, inbox, cut, reread } = await reading();

    cut();
    await reread();

    for (let elapsed = 0; elapsed < OUTAGE_GRACE_MS + TICK_MS; elapsed += TICK_MS) {
      h.clock.fire(TICK_MS);
      await settle();
    }

    expect(latest(inbox).failures.map((failure) => failure.kind)).toContain('offline');

    // Most maintenance ticks should skip reads during the 15-second retry interval.
    const said = inbox.length;

    for (let elapsed = 0; elapsed < 20_000; elapsed += TICK_MS) {
      h.clock.fire(TICK_MS);
      await settle();
    }

    // Expect one due read and no broadcasts for unchanged state.
    expect(inbox.length - said).toBe(1);
  });

  /** Base automatic retry delay on outage duration so manual refreshes do not postpone recovery. */
  it('preserves automatic retry timing after manual refresh', async () => {
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

  /** Clear outage state for removed sources so they cannot trigger repeated reads of remaining sources. */
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

    // Clear removed-source retry state to avoid repeated reads and lane-store writes.
    expect(inbox.length).toBe(settled);
  });

  /** Report expired outage grace during pending reads; waiting for completion could hide the error indefinitely. */
  it('reports an expired outage grace period during a pending read', async () => {
    // Simulate a hanging source after cached data and an initial transient failure.
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

  /** Keep reported outages visible after suspend detection; restart grace only for unreported outages. */
  it('preserves reported outages and resets unreported grace after suspend', async () => {
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

    // Reset an unreported outage's grace period after suspend.
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
  it('persists lane moves and broadcasts them', async () => {
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

  it('refuses opening without an available host', async () => {
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
  /** Do not install activity hooks before client configuration. */
  /** Broadcast corrected settings immediately, even within the refresh interval. */
  it('shows a setting put back, even when the read it asked for was inside the floor', async () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    const named = (): boolean => latest(inbox).failures.some((failure) => failure.kind === 'bad-config');

    h.hub.receive(client, { type: 'configure', config: h.config({ agents: [{ id: 'claude', path: 'nowhere/at/all' }] }) });
    await settle();

    expect(named()).toBe(true);

    // Keep the clock unchanged so only the configuration broadcast can update the client.
    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(named()).toBe(false);
  });

  /** Acknowledge explicit activity setting changes, not settings restated on every connection (R34). */
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
      { type: 'notice', level: 'info', message: 'Session activity hooks removed. Existing sessions may keep reporting until restarted.' },
    ]);
  });

  /** Acknowledge explicit changes even when no write is needed. */
  it('acknowledges unchanged activity settings', async () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    h.hub.receive(client, { type: 'configure', config: h.config(), acknowledge: true });
    await settle();

    expect(inbox.filter((message) => message.type === 'notice')).toEqual([
      { type: 'notice', level: 'info', message: 'Session activity hooks already match your settings.' },
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

  it('waits for client configuration before installing activity hooks', async () => {
    const h = harness();

    expect(h.installs).toEqual([]);

    const { client } = connect(h);

    expect(h.installs).toEqual([]);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(h.installs).toEqual(['install']);
  });

  /** Assert configured agent IDs directly; the fake installer writes no files (R30). */
  it('selects configured agents for installation and requests global removal when disabled', async () => {
    const h = harness();
    const { client } = connect(h);

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(h.installedFor).toEqual([['fake']]);

    h.clock.advance(2000);
    h.hub.receive(client, { type: 'configure', config: h.config({ installActivity: false }) });
    await settle();

    // Remove hooks from every registered agent when disabled (R34).
    expect(h.installedFor).toEqual([['fake'], null]);
  });

  it('reconciles per-agent changes and agent removal while preserving the global override', async () => {
    const h = harness();
    const { client } = connect(h);
    const both = [{ id: 'fake', path: 'fake' }, { id: 'other', path: 'other' }];
    const apply = async (part: Partial<HubConfig>) => {
      h.hub.receive(client, { type: 'configure', config: h.config({ agents: both, ...part }) });
      await settle();
    };

    await apply({});
    await apply({ sessionHooks: { fake: false, other: true } });
    await apply({ sessionHooks: { fake: false, other: true } });
    expect(h.installedFor).toEqual([['fake', 'other'], ['other']]);
    await apply({ sessionHooks: { fake: true, other: false } });
    await apply({ agents: [both[1]!] });
    await apply({});
    await apply({ installActivity: false, sessionHooks: { fake: true, other: true } });

    expect(h.installedFor).toEqual([['fake', 'other'], ['other'], ['fake'], ['other'], ['fake', 'other'], null]);
    expect(h.installs).toEqual(['install', 'install', 'install', 'install', 'install', 'remove']);
  });

  it('acknowledges per-agent removal without claiming installation or resetting installation age', async () => {
    const h = harness();
    h.activity = { wanted: 'install', plan: 'write', added: 2, removed: 0, failure: null };
    const { client, inbox } = connect(h);
    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();
    const marks = makeMarkStore(home);
    const installedAt = marks.read().installedAt;
    expect(installedAt).not.toBeNull();
    h.clock.advance(2000);
    h.activity = { wanted: 'install', plan: 'write', added: 0, removed: 2, failure: null };
    h.hub.receive(client, { type: 'configure', config: h.config({ sessionHooks: { fake: false } }), acknowledge: true });
    await settle();

    expect(inbox).toContainEqual({ type: 'notice', level: 'info', message: 'Session activity hooks removed for disabled agents.' });
    expect(marks.read().installedAt).toBe(installedAt);
  });

  /** Watch only configured agents and recreate watchers when the agent set changes. */
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
    // Deliver an event after reconfiguration to verify the replacement watcher is active.
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

    // Install hooks for newly configured agents instead of reusing the earlier result.
    expect(h.installedFor).toEqual([['fake'], ['fake', 'other']]);
  });

  /** Disabling hooks removes entries even without an open board (R34). */
  it('removes and reinstalls hooks when the setting changes', async () => {
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

  /** Retry busy installation results; they establish no installed state (R25). */
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

    // Cache completed installation results instead of reinstalling on every snapshot.
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

  /** Announce each installation once per client (R25). */
  it('announces installations once per client', async () => {
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
  /** Ignore activity events while no board is visible to avoid unused CLI reads. */
  it('ignores activity events while unwatched', async () => {
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

    // Do not send or persist late results after disposal.
    h.clock.advance(2000);
    await h.hub.refresh();
    await settle();

    expect(h.agent.calls).toBe(spawns);
    expect(inbox).toHaveLength(messages);
  });

  /** Queue a fresh roster read for events occurring after the current read began. */
  it('reads again for a session that ended while it was reading', async () => {
    const h = harness();
    const ended = fakeSession();
    h.agent.sessions = [ended];

    const { client, inbox } = connect(h);
    h.hub.receive(client, { type: 'refresh' });
    await settle();

    expect(latest(inbox).sessions?.count).toBe(1);

    // Hold the roster promise pending while delivering the marker event.
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

describe('host requests', () => {
  it('builds open requests from the roster, client, and clock', async () => {
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

  it('timestamps snapshots with the hub clock', () => {
    const h = harness();

    expect(h.hub.snapshot().fetchedAt).toBe(new Date(1_788_000_000_000).toISOString());
  });
});

describe('a client changing its mind', () => {
  /** Restate workspace and visibility changes without reconnecting. */
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

  it('reports existing configuration errors to new clients', async () => {
    const h = harness();
    const first = connect(h, hello({ id: 'first' }));

    h.hub.receive(first.client, { type: 'configure', config: h.config({ hosts: { 'not-an-editor': {} } }) });
    await settle();

    const second = connect(h, hello({ id: 'second' }));

    expect(latest(second.inbox).failures.map((f) => f.kind)).toContain('unknown-host');
  });

  it('rejects invalid configuration and retains prior settings', async () => {
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
    h.agent.sessions = [fakeSession({ sessionId: 'past', issueNumber: 42, repository: 'github.com/org/repo' })];
    h.agent.phases.set('past', { phase: 'running', since: 1, at: 1, event: 'UserPromptSubmit' });
    h.signal([{ kind: 'created', sessionId: 'past' }]); await settle();
    expect(shown().lastSession).toBeUndefined();
    const reads = historyCalls;
    h.signal([{ kind: 'changed', sessionId: 'past' }]); await settle(); expect(historyCalls).toBe(reads);
    h.agent.sessions = []; h.signal([{ kind: 'deleted', sessionId: 'past' }]); await settle();
    expect(shown().lastSession?.sessionId).toBe('past'); expect(historyCalls).toBe(reads + 1);
    h.hub.dispose();
  });
  /** Simulate clean session exit by removing roster and marker entries; retained activity must survive both (R6). */
  it('retains phases after session exit until the card leaves active work', async () => {
    const h = setup();
    h.agent.adapter.listHistory = async () => ({ sessions: [past], failure: null });
    h.agent.sessions = [fakeSession({ sessionId: 'past', issueNumber: 42, repository: 'github.com/org/repo' })];
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

    // Use a stored archive timestamp later than the retained activity to invalidate it.
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
  it('checks full roster conflicts without returning excluded session records', async () => {
    const h = setup();
    connect(h);
    await h.hub.refresh('asked');
    h.hub.configure(h.config({ sessionScope: { ...DEFAULT_SESSION_SCOPE, excludeDirectories: ['/private'] } }));
    h.agent.sessions = [fakeSession({ sessionId: 'hidden-live', cwd: '/private/work', checkoutRoot: '/private/work', issueNumber: 42, repository: 'github.com/org/repo' })];
    expect(await h.hub.sessionCheck('past')).toEqual({ allowed: true, targetActive: false, cardActive: true });
    expect(await h.hub.roster()).toEqual([]);
    expect(await h.hub.sessionCheck('hidden-live')).toEqual({ allowed: false, targetActive: false, cardActive: false });
    expect(await h.hub.sessionCheck('unknown')).toEqual({ allowed: false, targetActive: false, cardActive: false });
    h.agent.sessions = [fakeSession({ sessionId: 'elsewhere', issueNumber: 42, repository: 'github.com/other/repo' })];
    expect(await h.hub.sessionCheck('past')).toEqual({ allowed: true, targetActive: false, cardActive: false });
    h.agent.sessions = [fakeSession({ sessionId: 'past', cwd: past.cwd, checkoutRoot: past.cwd, issueNumber: 42, repository: 'github.com/org/repo' })];
    expect(await h.hub.sessionCheck('past')).toEqual({ allowed: true, targetActive: true, cardActive: true });
    h.agent.sessions = [fakeSession({ sessionId: 'past', cwd: '/private/work', checkoutRoot: '/private/work', issueNumber: 42, repository: 'github.com/org/repo' })];
    expect(await h.hub.sessionCheck('past')).toEqual({ allowed: false, targetActive: false, cardActive: false });
    h.agent.failure = { subject: 'fake', kind: 'unreadable', message: 'failed', remedy: 'retry' };
    expect(await h.hub.sessionCheck('past')).toBeNull();
    h.hub.dispose();
  });
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
  it.each(['valid', 'copied', 'wrong-workspace', 'wrong-session', 'expired', 'held-past-deadline', 'missing'])('checks %s historical handover against its one-use lease', async (kind) => {
    const h = setup(); h.host.resident.push('resume-elsewhere');
    const first = connect(h, hello({ id: 'source', workspaceRoot: '/other', residentRoutes: ['resume-here', 'resume-elsewhere'] }));
    const target = connect(h, hello({ id: 'target', workspaceRoot: kind === 'wrong-workspace' ? '/wrong' : past.cwd, residentRoutes: ['resume-here', 'resume-elsewhere'] }));
    await h.hub.refresh('asked');
    h.host.plan = { route: 'resume-elsewhere', session: past, root: past.cwd, expiresAt: h.clock.clock.now() + 30_000, newWindow: true };
    ask(h, first.client); await settle();
    const initial = first.inbox.find((message) => message.type === 'perform');
    if (initial?.type !== 'perform') throw new Error('Expected initial handover');
    const token = initial.route.resumeToken;
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    h.host.plan = { route: 'resume-here', session: past, root: past.cwd, expiresAt: h.clock.clock.now() + 30_000 };
    let release: (() => void) | undefined;
    if (kind === 'held-past-deadline') h.agent.holding = new Promise((done) => { release = done; });
    if (kind === 'expired') h.clock.advance(30_001);
    const message = { type: 'open' as const, sessionId: kind === 'wrong-session' ? 'another' : 'past', extensionReady: true, handedOver: true,
      ...(kind === 'missing' ? {} : { resumeToken: token! }) };
    h.hub.receive(target.client, message);
    if (kind === 'copied') h.hub.receive(target.client, message);
    if (release) { await settle(); h.clock.advance(30_001); release(); }
    await settle();
    const performed = target.inbox.filter((entry) => entry.type === 'perform');
    expect(performed).toHaveLength(kind === 'valid' || kind === 'copied' ? 1 : 0);
    if (kind === 'valid' || kind === 'copied') {
      expect(performed[0]).toMatchObject({ route: { route: 'resume-here', expiresAt: initial.route.route === 'resume-elsewhere' ? initial.route.expiresAt : 0 } });
      h.hub.receive(target.client, message); await settle();
      expect(target.inbox.filter((entry) => entry.type === 'perform')).toHaveLength(1);
    }
    if (kind !== 'valid') expect(target.inbox.some((entry) => entry.type === 'notice' && entry.refusal === 'resume-pending')).toBe(true);
    h.hub.dispose();
  });
  it('uses the live reveal path if the clicked session resumed since rendering', async () => {
    const h = setup(); const { client, inbox } = connect(h);
    await h.hub.refresh('asked'); h.agent.sessions = [fakeSession({ sessionId: 'past', issueNumber: 42, repository: 'github.com/org/repo' })];
    h.host.plan = { route: 'reveal-here', session: h.agent.sessions[0]!, root: past.cwd };
    ask(h, client); await settle();
    expect(h.host.planned.at(-1)?.historicalSession).toBeUndefined();
    expect(inbox.some((m) => m.type === 'perform' && m.route.route === 'reveal-here')).toBe(true); h.hub.dispose();
  });
  it.each(['unreadable', 'missing', 'active-card', 'old-client'])('refuses %s instead of firing a resume', async (kind) => {
    const h = setup(); const { client, inbox } = connect(h); await h.hub.refresh('asked');
    if (kind === 'unreadable') h.agent.failure = { subject: 'fake', kind: 'bad-response', message: 'unreadable', remedy: 'retry' };
    if (kind === 'missing') h.agent.adapter.canResume = () => false;
    if (kind === 'active-card') h.agent.sessions = [fakeSession({ sessionId: 'different', issueNumber: 42, repository: 'github.com/org/repo' })];
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
    expect(h.logged).toContain('board-1 disconnected; 0 clients remain');
  });

  it('writes down a card the developer moved, and where to', async () => {
    const h = harness();
    const { client } = connect(h);

    await settle();
    h.hub.receive(client, { type: 'move', key: 'issue:18941', lane: 'review' });

    expect(h.logged).toContain('issue:18941 moved to review');
  });

  it('logs configuration refusal details', async () => {
    const h = harness();
    const { inbox } = connect(h);

    h.hub.configure({ agents: 'not a list' });

    const refusal = latest(inbox).failures.find((failure) => failure.subject === 'config');

    expect(refusal?.message).toBeDefined();
    expect(h.logged).toContain(`client settings rejected: ${refusal!.message}`);
  });

  // Log unchanged settings only at debug level.
  it('writes a line for the settings that changed and not for the ones restated after them', async () => {
    const h = harness();
    const { client } = connect(h);
    const settings = h.config({ logLevel: 'debug' });

    h.hub.receive(client, { type: 'configure', config: settings });
    await settle();
    h.hub.receive(client, { type: 'configure', config: settings });
    await settle();

    expect(h.logged.filter((line) => line.startsWith('client updated settings'))).toHaveLength(1);
    expect(h.logged.filter((line) => line === 'settings restated unchanged')).toHaveLength(1);
  });

  // Deduplicate recurring agent-read failures in logs.
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

  it('logs recovery only after a successful agent read', async () => {
    const h = harness();

    const { client } = connect(h);

    h.agent.failure = { subject: 'fake', kind: 'cli-missing', message: 'no CLI', remedy: 'install it' };
    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    expect(h.logged).toContain('fake: no CLI');
    expect(h.logged).not.toContain('all agent reads recovered');

    h.agent.failure = null;
    h.clock.fire(h.config().sessionIntervalMs);
    await settle();

    expect(h.logged).toContain('all agent reads recovered');
  });

  // Enable debug diagnostics through client configuration.
  it('holds back the per-read detail until a client asks for debug', async () => {
    const h = harness();
    const { client } = connect(h);
    const before = h.agent.calls;

    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    // Verify a read occurred before asserting its debug entry was filtered.
    expect(h.agent.calls).toBeGreaterThan(before);
    expect(h.logged.some((line) => line.endsWith('sessions in 0ms'))).toBe(false);

    h.hub.receive(client, { type: 'configure', config: h.config({ logLevel: 'debug' }) });
    await settle();

    // Advance the poll timer because a log-level-only change does not trigger a read.
    h.clock.fire(h.config().sessionIntervalMs);
    await settle();

    expect(h.logged.some((line) => line.endsWith('sessions in 0ms'))).toBe(true);
  });
});

describe('a client that opened a log viewer', () => {
  const LINE = '2026-09-06T19:01:24.114Z info listening on 127.0.0.1:51844';

  /** Create prior-process log output before starting the hub. */
  function seedLog(text: string): void {
    mkdirSync(groundControlDirOf(home), { recursive: true });
    writeFileSync(logPathOf(home), text);
  }

  function logged(inbox: HubMessage[]): LogEntry[] {
    return inbox.flatMap((message) => (message.type === 'log' ? message.entries : []));
  }

  // No log data is sent before subscription, even when entries exist.
  it('streams logs only to subscribed clients', async () => {
    const h = harness();
    const { inbox } = connect(h);

    await settle();

    expect(h.logged.length).toBeGreaterThan(0);
    expect(logged(inbox)).toEqual([]);
  });

  it('sends the log tail on subscription', () => {
    seedLog(`${LINE}\n`);

    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'watchLog', watching: true });

    expect(logged(inbox)).toEqual([
      { at: '2026-09-06T19:01:24.114Z', level: 'info', source: 'hub', message: 'listening on 127.0.0.1:51844' },
    ]);
  });

  // Include prior-process log entries from disk in backfill.
  it('includes prior-process log entries', () => {
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

  it('stops streaming logs after unsubscribe', () => {
    const h = harness();
    const { client, inbox } = connect(h);

    h.hub.receive(client, { type: 'watchLog', watching: true });
    h.hub.receive(client, { type: 'watchLog', watching: false });
    h.hub.receive(client, { type: 'move', key: 'issue:18941', lane: 'review' });

    expect(logged(inbox).map((entry) => entry.message)).not.toContain('issue:18941 moved to review');
  });

  // Remove log subscriptions on disconnect to avoid writes to closed streams.
  it('stops log streaming on disconnect', () => {
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

  // Log subscriptions alone must not enable board polling (R35).
  it('does not start the poll loop', () => {
    const h = harness();
    const { client } = connect(h, hello({ watching: false }));

    h.hub.receive(client, { type: 'watchLog', watching: true });

    expect(h.clock.cadences()).toEqual([]);
  });
});

/** Open the hub-resolved checkout without an agent. Chrome provides a card key, never a path. */
describe('opening a card in an editor', () => {
  /** Use a readable directory because deleted paths are not offered (M23). */
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

    // Verify the card exists before testing its missing checkout.
    expect(key).toBeDefined();

    h.hub.receive(client, { type: 'openCheckout', key: key! });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(0);
    expect(inbox.filter((m) => m.type === 'notice').at(-1)).toMatchObject({ refusal: 'no-checkout' });
  });

  it('returns host refusal without opening a window', async () => {
    const root = checkoutDir();
    const { h, client, inbox } = await boardWith(root);
    const key = h.hub.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key;

    h.host.checkoutPlan = { refusal: 'already-here', message: 'This window is already open on it.' };
    h.hub.receive(client, { type: 'openCheckout', key });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(0);
    expect(inbox.filter((m) => m.type === 'notice').at(-1)).toMatchObject({ refusal: 'already-here' });
  });

  // Report missing route support to clients running older builds.
  it('requests reload when the client lacks route support', async () => {
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

  /** Chrome may request checkout opening through a connected editor client (R41). */
  it('has an editor client open the window when the browser overlay is the one that asked', async () => {
    const root = checkoutDir();
    const { h, inbox } = await boardWith(root);
    const overlay = connect(h, hello({ id: 'overlay', hostId: null, workspaceRoot: null, residentRoutes: [] }));
    const key = h.hub.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key;

    h.host.resident = ['reveal-here', 'open-checkout'];
    h.host.checkoutPlan = { route: 'open-checkout', key, root, newWindow: true };
    h.hub.receive(overlay.client, { type: 'openCheckout', key });
    await settle();

    // Route the operation to the editor, not the requesting browser.
    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(1);
    expect(inbox.filter((m) => m.type === 'perform').at(-1)).toMatchObject({ route: { key, root } });
    expect(overlay.inbox.filter((m) => m.type === 'perform')).toHaveLength(0);

    // Build the plan from hub card state; Chrome supplies no workspace root.
    expect(h.host.checkoutsPlanned.at(-1)).toMatchObject({ key, root, workspaceRoot: null });
  });

  /** Include connected board windows absent from agent discovery to avoid duplicate windows and repeated workspace tasks. */
  it('uses connected board windows to avoid duplicate checkout windows', async () => {
    const root = checkoutDir();
    const { h } = await boardWith(root);
    const onRoot = connect(h, hello({ id: 'board-on-root', workspaceRoot: root, residentRoutes: ['reveal-here', 'open-checkout'] }));
    const overlay = connect(h, hello({ id: 'overlay', hostId: null, workspaceRoot: null, residentRoutes: [] }));
    const key = h.hub.snapshot().lanes.flatMap((lane) => lane.cards)[0]!.key;

    h.host.resident = ['reveal-here', 'open-checkout'];
    h.hub.receive(overlay.client, { type: 'openCheckout', key });
    await settle();

    expect(h.host.checkoutsPlanned.at(-1)?.liveWindows).toContainEqual({ folders: [root] });
    // Choose the board on the checkout instead of the first connected client.
    expect(onRoot.inbox.filter((m) => m.type === 'perform')).toHaveLength(1);
  });

  // Limit browser-triggered opens to avoid multiple simultaneous code processes.
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

    h.clock.advance(3_001);
    h.hub.receive(client, { type: 'openCheckout', key });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(2);
  });

  // Prefer the requesting editor client over connection order.
  it('routes checkout opening to the requesting editor', async () => {
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

  // Report the missing performer capability regardless of whether Chrome or an editor requested it.
  it('requests editor reload when a connected editor lacks route support', async () => {
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

  // Without a resident client, report how to open a board before requesting focus (M26).
  it('reports no connected editor for focus requests', async () => {
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

/** Manual starts permit multiple attempts and bypass unattended-action limits (R3, R33). */
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

  /** Recheck assignment on the server because an old snapshot may offer starts for a now read-only card (R9). */
  it('refuses a start on a card the developer is no longer assigned', async () => {
    const root = join(home, 'project-1');
    mkdirSync(root, { recursive: true });

    // Resolve an unassigned issue from cached metadata when the assigned search omits it.
    makeIssueStore(home).write({
      entries: { 'github.com/example-org/example-repo#18941': { card: card(18941), at: Date.now() } },
    });

    const h = harness({}, { fetch: async () => ({ ok: true, value: { ...ISSUES, cards: [], matched: 0, totalAssigned: 0 } }) });
    const { client, inbox } = connect(h, hello({ residentRoutes: ['reveal-here', 'start-session'], workspaceRoot: root }));

    h.host.resident = ['reveal-here', 'start-session'];
    h.agent.sessions = [fakeSession({ cwd: root, checkoutRoot: root })];
    h.hub.receive(client, { type: 'configure', config: h.config() });
    await settle();

    const unassigned = h.hub.snapshot().lanes.flatMap((lane) => lane.cards).find((candidate) => candidate.unassigned === true);

    // Verify the card is marked unassigned before testing refusal.
    expect(unassigned).toBeDefined();

    const key = unassigned!.key;

    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();

    expect(h.host.startsPlanned).toEqual([]);
    expect(inbox.filter((m) => m.type === 'notice').at(-1)).toMatchObject({
      message: expect.stringContaining('no longer assigned'),
    });
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

  it('returns host refusal without starting a session', async () => {
    const { h, client, inbox, key } = await boardWith();

    h.host.startPlan = { refusal: 'checkout-elsewhere', message: 'Open that checkout first.' };
    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(0);
    expect(inbox.filter((m) => m.type === 'notice').at(-1)).toMatchObject({ refusal: 'checkout-elsewhere' });
  });

  it('requests reload when the client lacks route support', async () => {
    const { h, client, inbox, key } = await boardWith(['reveal-here']);

    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(0);
    expect(inbox.filter((m) => m.type === 'notice').at(-1)).toMatchObject({ message: expect.stringContaining('Reload') });
  });

  // Deduplicate starts before the agent supplies a session ID (M51).
  it('holds one card’s start against a second while the first is in flight', async () => {
    const { h, client, inbox, key } = await boardWith();

    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();
    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(1);
    expect(inbox.filter((m) => m.type === 'notice').at(-1)).toMatchObject({ message: expect.stringContaining('already being started') });
  });

  // Deduplicate by card and agent so starting Claude does not block Codex (R42).
  it('does not let one agent’s start hold off the other’s on the same card', async () => {
    const { h, client, inbox, key, root } = await boardWith();

    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();

    h.host.startPlan = { route: 'start-session', key, agent: 'codex', root, prompt: null };
    h.hub.receive(client, { type: 'startSession', key, agent: 'codex', extensionReady: true });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(2);
  });

  // Expire duplicate-start suppression because clients do not report completion.
  it('lets the same card and agent be started again once the lease has run out', async () => {
    const { h, client, inbox, key } = await boardWith();

    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();
    h.clock.advance(10_001);
    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(2);
  });

  // Manual starts require a resident client; no headless fallback exists (M26).
  it('refuses a route the host itself does not call resident, rather than sending it', async () => {
    const { h, client, inbox, key } = await boardWith();

    h.host.resident = ['reveal-here'];
    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();

    expect(inbox.filter((m) => m.type === 'perform')).toHaveLength(0);
    expect(h.host.performed).toEqual([]);
  });

  /** Build prompts from hub card state. Ad-hoc cards have no issue, so {issue} stays empty rather than using an unlinked branch number (R4). */
  it('passes the expanded card prompt to the host', async () => {
    const { h, client, key, root } = await boardWith();

    h.hub.configure({ ...h.config(), newSession: { prompt: 'Work on #{issue} in {checkout}. Not {nonsense}.' } });
    h.hub.receive(client, { type: 'startSession', key, agent: 'claude', extensionReady: true });
    await settle();

    expect(h.host.startsPlanned.at(-1)?.prompt).toBe(`Work on # in ${root}. Not {nonsense}.`);
  });

  // Manual starts accept empty prompts; unattended actions require one (R39).
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

  /** Chrome has no resident routes even when host resolution succeeds; do not offer session starts (R42). */
  it('offers no start to a client that cannot perform the route, which is every browser board', async () => {
    const h = harness();
    const { client, inbox } = connect(h, hello({ id: 'overlay', hostId: null, workspaceRoot: null, residentRoutes: [] }));

    h.hub.receive(client, { type: 'refresh' });
    await settle();

    // Require a received snapshot before checking absent capabilities.
    const snapshots = inbox.filter((m) => m.type === 'snapshot' || m.type === 'changed');

    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.at(-1)).toMatchObject({ snapshot: { startable: [] } });
  });
});

/** Validate selected folders against the card repository before storing. */
describe('choosing a card’s folder', () => {
  /** Use a repository URL matching the selected folder's origin remote. */
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

    // Normalize selected paths consistently with session cwd paths.
    const stored = picked.replace(/\\/g, '/');

    expect(makeCheckoutStore(home).read()[key]).toBe(stored);
    expect(h.hub.snapshot().lanes.flatMap((lane) => lane.cards).find((card) => card.key === key)?.checkout).toEqual({
      root: stored,
      source: 'remembered',
      only: true,
    });
    expect(inbox.filter((m) => m.type === 'changed').length).toBeGreaterThan(0);
  });

  // Reject relative paths because hub and editor working directories differ.
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
