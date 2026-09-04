import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { GITHUB_SOURCE_ID, makeGithubSource } from '@ground-control/github';
import type { AssignedIssues, GithubConfig, Result } from '@ground-control/github';
import type { ClientHello, HubConfig, HubMessage, IssueCard, Snapshot, WorkSource } from '@ground-control/core';
import type { ActivityState } from '../src/activityInstall.js';
import { Hub } from '../src/hub.js';
import type { HubDeps } from '../src/hub.js';
import { makeLaneStore } from '../src/lanes.js';
import { makeSettingsStore } from '../src/settings.js';
import type { StoredConfig } from '../src/settings.js';
import { makeMarkStore } from '../src/marks.js';
import { lanesPathOf } from '../src/paths.js';
import { defaultConfig } from '../src/registry.js';
import { fakeClock, fakeHost, fakeSession, reportingAgent, tempHome } from './helpers.js';
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
  /** What the install reports next, or null for a run that changed nothing. */
  activity: ActivityState | null;
  detected: string[];
  config(over?: Partial<HubConfig>): HubConfig;
  /** Every configuration the hub decided to remember. A refused one must never reach it. */
  wrote: HubConfig[];
}

function harness(
  over: Partial<HubDeps> = {},
  extra: { fetch?: Fetch; sources?: WorkSource[]; remembered?: Partial<HubConfig>; stored?: StoredConfig } = {},
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
  });

  const registries = { agents: [agent.adapter], hosts: [host.adapter], sources: [github, ...(extra.sources ?? [])] };

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
    activity: null,
    detected,
    wrote: [],
    config: (part = {}) => ({
      ...defaultConfig(registries),
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
    lanes: makeLaneStore(home),
    marks: makeMarkStore(home),
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
    syncActivity: (_registries, wanted) => {
      shape.installs.push(wanted);

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

    // Written out, not read back from the same defaults the hub used: the shipped cadences are 30 s and 5 minutes.
    expect(h.clock.cadences()).toEqual([30_000, 300_000]);

    h.hub.receive(client, { type: 'watching', watching: false });

    expect(h.clock.cadences()).toEqual([]);
  });

  it('stops polling when the last watching client disconnects', () => {
    const h = harness();
    const { client } = connect(h);

    expect(h.clock.cadences()).toHaveLength(2);

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

    expect(h.clock.cadences()).toEqual([5_000, 60_000]);
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
    h.agent.phases.set(session.sessionId, { phase: 'waiting', since: 1, event: 'Notification' });
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
    h.agent.phases.set('a-new-session', { phase: 'running', since: 1, event: 'UserPromptSubmit' });
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

    expect(h.clock.cadences()).toHaveLength(2);

    h.hub.receive(client, { type: 'hello', hello: hello({ watching: false, workspaceRoot: 'd:/checkouts/other' }) });

    expect(h.clock.cadences()).toEqual([]);

    const session = fakeSession();
    h.agent.sessions = [session];
    h.host.plan = { route: 'reveal-here', session, root: session.cwd };
    h.hub.receive(client, { type: 'hello', hello: hello({ watching: true, workspaceRoot: 'd:/checkouts/other' }) });
    await settle();
    h.hub.receive(client, { type: 'open', sessionId: session.sessionId, extensionReady: true });
    await settle();

    expect(h.clock.cadences()).toHaveLength(2);
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
