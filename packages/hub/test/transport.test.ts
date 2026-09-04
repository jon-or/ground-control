import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client, ClientHello, ClientMessage, HubMessage, Session, Snapshot } from '@ground-control/core';
import { createHubServer } from '../src/server.js';
import type { HubServer } from '../src/server.js';
import { HubTransport } from '../src/transport.js';
import type { Ensured } from '../src/ensure.js';
import type { HubRecord } from '../src/discover.js';

const SNAPSHOT = {
  lanes: [],
  issues: null,
  sessions: null,
  openable: [],
  hooks: null,
  failures: [],
  stale: false,
  needs: null,
  fetchedAt: '2026-09-04T12:00:00Z',
} as Snapshot;

const SESSION = {
  agent: 'claude',
  sessionId: 'a1',
  pid: 1,
  title: null,
  cwd: 'd:/checkouts/project-1',
  branch: null,
  issueNumber: null,
  startedAt: 0,
  transcriptWrittenAt: null,
  activity: null,
  finished: false,
  details: {},
} as Session;

/** The real server, on a real loopback port, which `testing.md` allows for a listener the test itself started. */
function fakeHub() {
  const sends = new Map<string, (message: HubMessage) => void>();
  const received: ClientMessage[] = [];

  return {
    sends,
    received,
    connect(who: ClientHello, send: (message: HubMessage) => void): Client {
      sends.set(who.id, send);

      return { id: who.id };
    },
    disconnect(client: Client): void {
      sends.delete(client.id);
    },
    receive(_client: Client, message: ClientMessage): void {
      received.push(message);
    },
    snapshot: () => SNAPSHOT,
    roster: () => Promise.resolve([SESSION]),
  };
}

const shut: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (shut.length > 0) {
    await shut.pop()!();
  }
});

async function serving() {
  const hub = fakeHub();
  const created = createHubServer({ hub, fingerprint: 'abc123', onShutdown: () => {} });
  const server = await created.listen();

  shut.push(() => server.close());

  return { hub, server };
}

function recordOf(server: HubServer): HubRecord {
  return {
    protocol: 1,
    version: '1.0.0',
    port: server.port,
    token: server.token,
    pid: 1,
    startedAt: '',
    fingerprint: 'abc123',
  };
}

interface Watched {
  transport: HubTransport;
  inbox: HubMessage[];
  trouble: (string | null)[];
  hellos: number;
  restated: number;
  ensures: number;
}

function connecting(id: string, ensure: () => Promise<Ensured>, deadlineMs?: number): Watched {
  const shape: Watched = {
    transport: undefined as unknown as HubTransport,
    inbox: [],
    trouble: [],
    hellos: 0,
    restated: 0,
    ensures: 0,
  };

  shape.transport = new HubTransport(id, {
    ensure: () => {
      shape.ensures += 1;

      return ensure();
    },
    hello: () => {
      shape.hellos += 1;

      return { id, hostId: 'vscode', workspaceRoot: null, residentRoutes: [], watching: true };
    },
    afterHello: () => {
      shape.restated += 1;
    },
    onMessage: (message) => shape.inbox.push(message),
    onTrouble: (message) => shape.trouble.push(message),
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });

  shut.push(() => shape.transport.dispose());

  return shape;
}

/** Waits on a condition rather than a duration: everything here is a real socket. */
async function until(what: () => boolean, why: string, within = 5000): Promise<void> {
  const deadline = Date.now() + within;

  while (!what()) {
    expect(Date.now(), why).toBeLessThan(deadline);
    await new Promise((done) => setTimeout(done, 10));
  }
}

describe('what a client does over the wire', () => {
  it('opens a stream, says hello, and takes what the hub sends', async () => {
    const { hub, server } = await serving();
    const found = { hub: { record: recordOf(server), identity: { hub: 'ground-control', protocol: 1, fingerprint: 'abc123' } } };
    const client = connecting('board-1', () => Promise.resolve(found as Ensured));

    await until(() => hub.sends.size === 1, 'the hello never reached the hub');
    // The hub registers the client while it handles the hello; `afterHello` runs when that answer comes back.
    await until(() => client.restated === 1, 'the client never restated itself to the hub it just said hello to');

    hub.sends.get('board-1')!({ type: 'changed', snapshot: SNAPSHOT });

    await until(() => client.inbox.length > 0, 'the hub sent a snapshot and the client never saw it');
    expect(client.inbox[0]).toEqual({ type: 'changed', snapshot: SNAPSHOT });
  });

  /** Only ever a read that happened: an empty list would be read by its caller as "nothing is running" (R24). */
  it('reads the roster, and answers null rather than nothing when it cannot', async () => {
    const { server } = await serving();
    const found = { hub: { record: recordOf(server), identity: { hub: 'ground-control', protocol: 1, fingerprint: 'abc123' } } };
    const client = connecting('board-1', () => Promise.resolve(found as Ensured));

    await until(() => client.restated > 0, 'never connected');
    expect((await client.transport.roster())?.map((one) => one.sessionId)).toEqual(['a1']);

    await server.close();

    expect(await client.transport.roster()).toBeNull();
  });

  /**
   * A hub that goes away is what a developer does with `--stop`, and what the idle rule does on its own. The stream
   * closing is the only signal, and it has to end in a reconnect rather than a board that quietly stops updating.
   */
  it('reconnects and says hello again when the hub goes away', async () => {
    const first = await serving();
    let current = first;

    const client = connecting('board-1', () =>
      Promise.resolve({
        hub: { record: recordOf(current.server), identity: { hub: 'ground-control', protocol: 1, fingerprint: 'abc123' } },
      } as Ensured),
    );

    await until(() => client.hellos === 1, 'never connected');

    await first.server.close();
    current = await serving();

    await until(() => client.hellos === 2, 'the hub went away and the client never came back');
    await until(() => current.hub.sends.size === 1, 'it reconnected without saying hello to the new hub');
    expect(client.restated).toBe(2);
  });

  /** An outage is one message, not one per retry, and the developer is told when it clears. */
  it('says trouble once and says it is over once', async () => {
    const client = connecting('board-1', () => Promise.resolve({ failed: 'nothing is answering yet' }));

    await until(() => client.trouble.length > 0, 'a client that cannot reach its hub said nothing');
    await until(() => client.ensures > 1, 'it gave up after one try');

    expect(client.trouble).toEqual(['nothing is answering yet']);
  });

  /**
   * The hub knows nothing of a client until its hello, so a stream whose hello was refused is not a connection. It
   * has to be dropped: a transport that looked healthy would never drain what it queued and never try again.
   */
  it('treats a refused hello as a lost connection rather than a working one', async () => {
    const { hub, server } = await serving();
    const found = { hub: { record: recordOf(server), identity: { hub: 'ground-control', protocol: 1, fingerprint: 'abc123' } } };

    let hellos = 0;
    let restated = 0;

    // The server refuses a hello naming a client other than the stream it arrived on. Trying again is the tell: a
    // transport that took the refusal for a connection would sit there, registered nowhere and never retrying.
    const mismatched = new HubTransport('stream-id', {
      ensure: () => Promise.resolve(found as Ensured),
      hello: () => {
        hellos += 1;

        return { id: 'a-different-client', hostId: null, workspaceRoot: null, residentRoutes: [], watching: false };
      },
      afterHello: () => {
        restated += 1;
      },
      onMessage: () => {},
      onTrouble: () => {},
    });

    shut.push(() => mismatched.dispose());

    await until(() => hellos > 1, 'a refused hello was taken for a connection and never tried again', 4000);

    expect(hub.sends.size).toBe(0);
    expect(restated).toBe(0);
  });

  /**
   * A listener that accepts and never answers. Without an absolute deadline the promise never settles, and the route
   * that was waiting on it is stuck for the life of the window — the board silently ignores that card from then on.
   */
  it('gives up on a hub that accepts and never answers', async () => {
    const silent = createServer(() => {
      // Deliberately no response: the socket stays open and the request is never completed.
    });

    await new Promise<void>((listening) => silent.listen(0, '127.0.0.1', listening));

    const address = silent.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    shut.push(
      () =>
        new Promise<void>((closed) => {
          silent.closeAllConnections();
          silent.close(() => closed());
        }),
    );

    const client = connecting(
      'board-1',
      () =>
        Promise.resolve({
          hub: {
            record: { protocol: 1, version: '1.0.0', port, token: 't', pid: 1, startedAt: '', fingerprint: 'abc123' },
            identity: { hub: 'ground-control', protocol: 1, fingerprint: 'abc123' },
          },
        } as Ensured),
      300,
    );

    await until(() => client.ensures > 0, 'never tried');

    expect(await client.transport.roster()).toBeNull();
  });

  /** Queued while the stream is down, sent once there is one: a card moved mid-reconnect is not a card lost. */
  it('holds actions until it has a connection, and sends them in the order they were taken', async () => {
    const { hub, server } = await serving();
    let answer: Ensured = { failed: 'nothing is answering yet' };
    const client = connecting('board-1', () => Promise.resolve(answer));

    await until(() => client.trouble.length > 0, 'never reported the outage');

    client.transport.send({ type: 'move', key: 'issue-1', lane: 'build' });
    client.transport.send({ type: 'move', key: 'issue-2', lane: 'review' });

    expect(hub.received).toEqual([]);

    answer = {
      hub: { record: recordOf(server), identity: { hub: 'ground-control', protocol: 1, fingerprint: 'abc123' } },
    } as Ensured;

    await until(() => hub.received.length === 2, 'the actions taken while it was down never arrived');

    // In order, because two of these are a lane placement: the last one to land is the one that sticks.
    expect(hub.received).toEqual([
      { type: 'move', key: 'issue-1', lane: 'build' },
      { type: 'move', key: 'issue-2', lane: 'review' },
    ]);
    expect(client.trouble).toEqual(['nothing is answering yet', null]);
  });

  /**
   * A configuration is never queued: the client restates the current one after every hello, and a queued one is by
   * then some earlier minute's settings, which replayed on top would undo the change the developer just made.
   */
  it('never queues a configuration to replay over the one it restates', async () => {
    const { hub, server } = await serving();
    let answer: Ensured = { failed: 'nothing is answering yet' };
    const client = connecting('board-1', () => Promise.resolve(answer));

    await until(() => client.trouble.length > 0, 'never reported the outage');

    client.transport.send({ type: 'configure', config: { installActivity: false } as never });
    client.transport.send({ type: 'watching', watching: true });

    answer = {
      hub: { record: recordOf(server), identity: { hub: 'ground-control', protocol: 1, fingerprint: 'abc123' } },
    } as Ensured;

    await until(() => hub.received.length > 0, 'never connected once the hub was there');
    await new Promise((done) => setTimeout(done, 100));

    // The `watching` survived the outage; the settings of that minute did not, and `afterHello` is what replaces them.
    expect(hub.received).toEqual([{ type: 'watching', watching: true }]);
    expect(client.restated).toBe(1);
  });

  it('sends nothing more once it has been disposed', async () => {
    const { hub, server } = await serving();
    const found = { hub: { record: recordOf(server), identity: { hub: 'ground-control', protocol: 1, fingerprint: 'abc123' } } };
    const client = connecting('board-1', () => Promise.resolve(found as Ensured));

    await until(() => hub.sends.size === 1, 'never connected');

    client.transport.dispose();
    client.transport.send({ type: 'refresh' });

    await until(() => hub.sends.size === 0, 'disposing left the stream open');
    await new Promise((done) => setTimeout(done, 100));

    expect(hub.received.filter((message) => message.type === 'refresh')).toEqual([]);
  });

  /** Disposed between the request going out and its headers coming back — the window a reload lands in. */
  it('does not register with the hub when it is disposed mid-connect', async () => {
    const { hub, server } = await serving();
    const found = { hub: { record: recordOf(server), identity: { hub: 'ground-control', protocol: 1, fingerprint: 'abc123' } } };
    const client = connecting('board-1', () => Promise.resolve(found as Ensured));

    // Immediately: the stream request is in flight and its response has not arrived.
    client.transport.dispose();

    await new Promise((done) => setTimeout(done, 300));

    expect(hub.sends.size).toBe(0);
    expect(client.hellos).toBe(0);
  });
});
