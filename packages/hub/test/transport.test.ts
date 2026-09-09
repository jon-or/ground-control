import { IncomingMessage, createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client, ClientHello, ClientMessage, HubMessage, Session, SessionCheck, Snapshot } from '@ground-control/core';
import { createHubServer } from '../src/server.js';
import type { HubServer } from '../src/server.js';
import { HubTransport } from '../src/transport.js';
import type { Ensured } from '../src/ensure.js';
import type { HubRecord } from '../src/discover.js';
import { captureLog } from './helpers.js';

const SNAPSHOT = {
  lanes: [],
  issues: null,
  sessions: null,
  openable: [],
  startable: [],
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
  attachId: null,
  details: {},
} as Session;

/** The real server, on a real loopback port, which `testing.md` allows for a listener the test itself started. */
function fakeHub() {
  const sends = new Map<string, (message: HubMessage) => void>();
  const received: ClientMessage[] = [];
  const checking: { value: unknown; ids: string[] } = { value: null, ids: [] };

  return {
    sends,
    received,
    checking,
    // Malformed values deliberately model an untrusted or incompatible HTTP peer.
    sessionCheck: async (id: string) => { checking.ids.push(id); return checking.value as SessionCheck | null; },
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
  const created = createHubServer({ hub, fingerprint: 'abc123', onShutdown: () => {}, log: captureLog().log });
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
  said: string[];
  hellos: number;
  restated: number;
  ensures: number;
}

function connecting(id: string, ensure: () => Promise<Ensured>, deadlineMs?: number): Watched {
  const shape: Watched = {
    transport: undefined as unknown as HubTransport,
    inbox: [],
    trouble: [],
    said: [],
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
    log: (level, message) => shape.said.push(`${level} ${message}`),
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

/** Keep response chunks as Buffers for Node inspector byteLength reporting. Stream-level string decoding causes inspector failures (M28). */
describe('how a client reads a socket', () => {
  it('never decodes a response stream, on the event stream or on a read', async () => {
    const { hub, server } = await serving();
    const found = { hub: { record: recordOf(server), identity: { hub: 'ground-control', protocol: 1, fingerprint: 'abc123' } } };
    const decoded: string[] = [];
    const original = IncomingMessage.prototype.setEncoding;

    IncomingMessage.prototype.setEncoding = function patched(this: IncomingMessage, encoding) {
      decoded.push(String(encoding));

      return original.call(this, encoding);
    };
    shut.push(() => {
      IncomingMessage.prototype.setEncoding = original;
    });

    const client = connecting('board-1', () => Promise.resolve(found as Ensured));

    await until(() => hub.sends.size === 1, 'the hello never reached the hub');

    hub.sends.get('board-1')!({ type: 'changed', snapshot: SNAPSHOT });

    await until(() => client.inbox.length > 0, 'the hub sent a snapshot and the client never saw it');

    expect(await client.transport.roster()).toEqual([SESSION]);
    expect(decoded).toEqual([]);
  });
});

describe('what a client does over the wire', () => {
  it('accepts boolean session-check decisions and fails closed on malformed or failed responses', async () => {
    const { hub, server } = await serving();
    const found = { hub: { record: recordOf(server), identity: { hub: 'ground-control', protocol: 1, fingerprint: 'abc123' } } };
    const client = connecting('board-1', () => Promise.resolve(found as Ensured));
    await until(() => client.restated > 0, 'never connected');
    hub.checking.value = { allowed: true, targetActive: false, cardActive: true };
    expect(await client.transport.sessionCheck('session-1')).toEqual({ allowed: true, targetActive: false, cardActive: true });
    expect(hub.checking.ids).toEqual(['session-1']);
    hub.checking.value = { allowed: true, targetActive: false, cardActive: false, agentHome: 'D:\\Profiles\\Selected' };
    expect(await client.transport.sessionCheck('session-1')).toEqual({ allowed: true, targetActive: false, cardActive: false, agentHome: 'D:/Profiles/Selected' });
    for (const agentHome of ['', 'relative', '/root\nother', false, null]) {
      hub.checking.value = { allowed: true, targetActive: false, cardActive: false, agentHome };
      expect(await client.transport.sessionCheck('session-1')).toBeNull();
    }
    hub.checking.value = { allowed: false, targetActive: false, cardActive: false, agentHome: '/private/profile' };
    expect(await client.transport.sessionCheck('session-1')).toBeNull();
    hub.checking.value = { allowed: false, targetActive: false, cardActive: false };
    expect(await client.transport.sessionCheck('session-2')).toEqual({ allowed: false, targetActive: false, cardActive: false });
    for (const bad of [null, true, [], {}, { allowed: 'true', targetActive: false, cardActive: false },
      { allowed: true, targetActive: 0, cardActive: false }, { allowed: true, targetActive: false, cardActive: null }]) {
      hub.checking.value = bad;
      expect(await client.transport.sessionCheck('session-1')).toBeNull();
    }
    const calls = hub.checking.ids.length;
    expect(await client.transport.sessionCheck('private/path')).toBeNull();
    expect(hub.checking.ids).toHaveLength(calls);
    await server.close();
    expect(await client.transport.sessionCheck('session-1')).toBeNull();
  });
  it('registers the stream and receives hub messages', async () => {
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

  /** Return null on read failure; an empty array would falsely imply no active sessions (R24). */
  it('returns the roster or null on read failure', async () => {
    const { server } = await serving();
    const found = { hub: { record: recordOf(server), identity: { hub: 'ground-control', protocol: 1, fingerprint: 'abc123' } } };
    const client = connecting('board-1', () => Promise.resolve(found as Ensured));

    await until(() => client.restated > 0, 'never connected');
    expect((await client.transport.roster())?.map((one) => one.sessionId)).toEqual(['a1']);

    await server.close();

    expect(await client.transport.roster()).toBeNull();
  });

  /** Reconnect after stream closure, including manual shutdown and idle exit. */
  it('reconnects and registers after hub shutdown', async () => {
    const first = await serving();
    let current = first;

    const client = connecting('board-1', () =>
      Promise.resolve({
        hub: { record: recordOf(current.server), identity: { hub: 'ground-control', protocol: 1, fingerprint: 'abc123' } },
      } as Ensured),
    );

    await until(() => client.hellos === 1, 'never connected');
    await until(() => client.restated === 1, 'the initial hello was never acknowledged');

    await first.server.close();
    current = await serving();

    await until(() => client.hellos === 2, 'the hub went away and the client never came back');
    await until(() => current.hub.sends.size === 1, 'it reconnected without saying hello to the new hub');
    await until(() => client.restated === 2, 'the reconnect hello was never acknowledged');
  });

  /** An outage is one message, not one per retry, and the developer is told when it clears. */
  it('reports each outage and recovery once', async () => {
    const client = connecting('board-1', () => Promise.resolve({ failed: 'nothing is answering yet' }));

    await until(() => client.trouble.length > 0, 'a client that cannot reach its hub said nothing');
    await until(() => client.ensures > 1, 'it gave up after one try');

    expect(client.trouble).toEqual(['nothing is answering yet']);
  });

  /** Reconnect after failed hello; an unregistered stream cannot deliver queued actions. */
  it('treats a refused hello as a lost connection rather than a working one', async () => {
    const { hub, server } = await serving();
    const found = { hub: { record: recordOf(server), identity: { hub: 'ground-control', protocol: 1, fingerprint: 'abc123' } } };

    let hellos = 0;
    let restated = 0;

    // Use a mismatched client ID to reject hello and verify another connection attempt.
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

  /** Use an absolute request deadline so a silent listener cannot block route handling indefinitely. */
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

  /** Restate current configuration after hello; replaying queued settings could overwrite newer values. */
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

    // Replay watching but restate current settings through afterHello.
    expect(hub.received).toEqual([{ type: 'watching', watching: true }]);
    expect(client.restated).toBe(1);
  });

  it('stops sending after disposal', async () => {
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

describe('client connection diagnostics (R40)', () => {
  it('logs connection and message events while unwatched', async () => {
    const { hub, server } = await serving();
    const found = { hub: { record: recordOf(server), identity: { hub: 'ground-control', protocol: 1, fingerprint: 'abc123' } } };
    const client = connecting('board-1', () => Promise.resolve(found as Ensured));

    await until(() => hub.sends.size === 1, 'never connected');

    client.transport.send({ type: 'refresh' });
    hub.sends.get('board-1')!({ type: 'snapshot', snapshot: SNAPSHOT });

    await until(() => hub.received.some((message) => message.type === 'refresh'), 'never sent');
    await until(() => client.inbox.length > 0, 'the snapshot never arrived');

    expect(client.said).toContain(`info opening a stream to 127.0.0.1:${server.port}`);
    expect(client.said).toContain('info hub connected; 0 action(s) queued');
    expect(client.said).toContain('debug sent hello: ok');
    expect(client.said).toContain('debug sent refresh: ok');
    expect(client.said).toContain('debug the hub sent snapshot');
  });

  /** Exclude hub log frames from transport diagnostics to avoid duplicate log traffic. */
  it('excludes log messages from transport diagnostics', async () => {
    const { hub, server } = await serving();
    const found = { hub: { record: recordOf(server), identity: { hub: 'ground-control', protocol: 1, fingerprint: 'abc123' } } };
    const client = connecting('board-1', () => Promise.resolve(found as Ensured));

    await until(() => hub.sends.size === 1, 'never connected');

    hub.sends.get('board-1')!({
      type: 'log',
      entries: [{ at: '2026-09-06T12:00:00.000Z', level: 'info', source: 'hub', message: 'listening' }],
    });

    await until(() => client.inbox.some((message) => message.type === 'log'), 'the log never arrived');

    expect(client.said.filter((line) => line.includes('log'))).toEqual([]);
  });

  it('logs connection failure and retry delay', async () => {
    const client = connecting('board-1', () => Promise.resolve({ failed: 'the hub would not start' } as Ensured));

    await until(() => client.said.length >= 2, 'never gave up');

    expect(client.said).toContain('warn no hub to connect to: the hub would not start');
    expect(client.said).toContain('info trying again in 1000ms');
  });
});

describe('what is never queued while the stream is down', () => {
  /** Restate watchLog after hello without queueing it, or reconnect would duplicate log backfill. */
  it('drops a watchLog sent while the stream is down rather than replaying it behind the restate', async () => {
    const { hub, server } = await serving();
    const found = { hub: { record: recordOf(server), identity: { hub: 'ground-control', protocol: 1, fingerprint: 'abc123' } } };

    let reachable = false;
    const client = connecting('board-1', () =>
      Promise.resolve(reachable ? (found as Ensured) : ({ failed: 'not yet' } as Ensured)),
    );

    await until(() => client.said.includes('warn no hub to connect to: not yet'), 'never tried');

    client.transport.send({ type: 'watchLog', watching: true });
    client.transport.send({ type: 'refresh' });

    reachable = true;

    await until(() => hub.received.some((message) => message.type === 'refresh'), 'the queue never drained');
    await new Promise((done) => setTimeout(done, 150));

    // Replay refresh; the client separately restates its log subscription.
    expect(hub.received.filter((message) => message.type === 'watchLog')).toEqual([]);
  });
});
