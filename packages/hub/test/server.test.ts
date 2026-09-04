import { request } from 'node:http';
import { connect } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL } from '@ground-control/core';
import type { Client, ClientHello, ClientMessage, HubMessage, Snapshot } from '@ground-control/core';
import { BODY_LIMIT_BYTES, HEARTBEAT_MS, MAX_EVENT_STREAMS, createHubServer } from '../src/server.js';
import type { HubServer, ServerClock } from '../src/server.js';

const CRLF = String.fromCharCode(13, 10);

const SNAPSHOT: Snapshot = {
  lanes: [],
  issues: null,
  sessions: null,
  openable: [],
  hooks: null,
  failures: [],
  needs: null,
  stale: false,
  fetchedAt: '2026-09-03T10:00:00.000Z',
};

function hello(id: string): ClientHello {
  return { id, hostId: 'vscode', workspaceRoot: null, residentRoutes: [], watching: true };
}

/** The loop's answers are not what these tests are about; what the server refuses is. */
function fakeHub() {
  const connected = new Map<string, (message: HubMessage) => void>();
  const received: { id: string; message: ClientMessage }[] = [];
  const disconnected: string[] = [];

  return {
    connected,
    received,
    disconnected,
    connect(who: ClientHello, send: (message: HubMessage) => void): Client {
      connected.set(who.id, send);

      return { id: who.id };
    },
    disconnect(client: Client): void {
      connected.delete(client.id);
      disconnected.push(client.id);
    },
    receive(client: Client, message: ClientMessage): void {
      received.push({ id: client.id, message });
    },
    snapshot: () => SNAPSHOT,
  };
}

/** A clock whose heartbeat only ticks when a test says so, and which records the cadence it was asked for. */
function fakeClock(): ServerClock & { beat(): void; cadence: number } {
  let fn: (() => void) | undefined;

  const clock = {
    cadence: 0,
    setInterval: (callback: () => void, ms: number) => {
      fn = callback;
      clock.cadence = ms;

      return 0 as unknown as NodeJS.Timeout;
    },
    clearInterval: () => {
      fn = undefined;
    },
    beat: () => fn?.(),
  };

  return clock;
}

/** Waits for a thing to become true rather than for a duration, so nothing here turns red on a loaded machine. */
async function until(what: () => boolean, within = 2000): Promise<void> {
  const deadline = Date.now() + within;

  while (!what()) {
    if (Date.now() > deadline) {
      throw new Error('that never happened');
    }

    await new Promise((done) => setTimeout(done, 5));
  }
}

interface Answer {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
}

interface Call {
  method?: string;
  path: string;
  token?: string | null;
  headers?: Record<string, string>;
  body?: string;
}

const open: { end(): void | Promise<void> }[] = [];

afterEach(async () => {
  while (open.length) {
    await open.pop()?.end();
  }
});

function call(server: HubServer, options: Call): Promise<Answer> {
  const headers: Record<string, string> = {
    Host: `127.0.0.1:${server.port}`,
    ...(options.token === null ? {} : { Authorization: `Bearer ${options.token ?? server.token}` }),
    ...options.headers,
  };

  return new Promise((resolve, reject) => {
    const outbound = request(
      { host: '127.0.0.1', port: server.port, method: options.method ?? 'GET', path: options.path, headers },
      (response) => {
        let body = '';

        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
      },
    );

    outbound.on('error', reject);
    outbound.end(options.body);
  });
}

function post(server: HubServer, path: string, message: unknown, options: Partial<Call> = {}): Promise<Answer> {
  return call(server, {
    method: 'POST',
    path,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: JSON.stringify(message),
    ...(options.token === undefined ? {} : { token: options.token }),
  });
}

/** An open event stream, with the frames it has received so far and a promise for the next one. */
function stream(server: HubServer, id: string): Promise<{ frames: string[]; next(): Promise<string>; end(): void }> {
  return new Promise((resolve, reject) => {
    const outbound = request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: `/events?client=${id}`,
        headers: { Host: `127.0.0.1:${server.port}`, Authorization: `Bearer ${server.token}` },
      },
      (response: IncomingMessage) => {
        const frames: string[] = [];
        let waiting: ((frame: string) => void) | undefined;
        let buffer = '';

        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          buffer += chunk;

          for (let cut = buffer.indexOf('\n\n'); cut !== -1; cut = buffer.indexOf('\n\n')) {
            const frame = buffer.slice(0, cut);

            buffer = buffer.slice(cut + 2);
            frames.push(frame);
            waiting?.(frame);
            waiting = undefined;
          }
        });

        const handle = {
          frames,
          next: () =>
            new Promise<string>((got) => {
              waiting = got;
            }),
          end: (): void => void outbound.destroy(),
        };

        open.push(handle);
        resolve(handle);
      },
    );

    outbound.on('error', reject);
    outbound.end();
  });
}

async function serving(clock?: ServerClock) {
  const hub = fakeHub();
  const stops: string[] = [];
  const created = createHubServer({
    hub,
    fingerprint: 'abc123',
    onShutdown: () => stops.push('asked'),
    ...(clock ? { clock } : {}),
  });
  const server = await created.listen();

  open.push({ end: () => server.close() });

  return { hub, server, stops };
}

describe('what the hub answers over loopback', () => {
  it('says what it is without a token, and says nothing else', async () => {
    const { server } = await serving();

    const answer = await call(server, { path: '/hub', token: null });

    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ hub: 'ground-control', protocol: PROTOCOL, fingerprint: 'abc123' });
    expect(answer.headers['x-content-type-options']).toBe('nosniff');
    expect(answer.headers['cache-control']).toBe('no-store');
  });

  it('hands the snapshot to a client with the token', async () => {
    const { server } = await serving();

    const answer = await call(server, { path: '/snapshot' });

    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual(SNAPSHOT);
  });

  it('refuses a wrong token, and a missing one', async () => {
    const { server } = await serving();

    expect((await call(server, { path: '/snapshot', token: 'not-the-token' })).status).toBe(401);
    expect((await call(server, { path: '/snapshot', token: null })).status).toBe(401);
    // Same length as a real token, so the length check is not what refuses it.
    expect((await call(server, { path: '/snapshot', token: 'x'.repeat(server.token.length) })).status).toBe(401);
  });
});

describe('what the hub refuses outright', () => {
  /** A page on any site can reach loopback, and `configure` carries paths the hub will spawn. */
  it('answers nothing that carries an Origin, token or not', async () => {
    const { server } = await serving();

    const withToken = await call(server, { path: '/snapshot', headers: { Origin: 'https://github.com' } });
    const identity = await call(server, { path: '/hub', token: null, headers: { Origin: 'https://github.com' } });

    expect(withToken.status).toBe(403);
    expect(identity.status).toBe(403);
    expect(identity.body).not.toContain('ground-control');
  });

  it('answers only on its own loopback address', async () => {
    const { server } = await serving();

    const answer = await call(server, { path: '/snapshot', headers: { Host: 'evil.example.com' } });

    expect(answer.status).toBe(403);
  });

  it('refuses a body that is not JSON, and one that is not application/json', async () => {
    const { server, hub } = await serving();

    const wrongType = await call(server, {
      method: 'POST',
      path: '/actions?client=one',
      headers: { 'Content-Type': 'text/plain' },
      body: '{"type":"refresh"}',
    });
    const notJson = await call(server, {
      method: 'POST',
      path: '/actions?client=one',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    });

    expect(wrongType.status).toBe(415);
    expect(notJson.status).toBe(400);
    expect(hub.received).toEqual([]);
  });

  it('refuses a body that declares more than the cap before reading it', async () => {
    const { server, hub } = await serving();

    const answer = await call(server, {
      method: 'POST',
      path: '/actions?client=one',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'move', key: 'x'.repeat(BODY_LIMIT_BYTES), lane: 'doing' }),
    });

    expect(answer.status).toBe(413);
    expect(hub.received).toEqual([]);
    // The body was never read, so the connection cannot carry another request on it.
    expect(answer.headers.connection).toBe('close');
  });

  /** A chunked body declares nothing, so the cap is the read itself and the connection is what goes. */
  it('drops a body that runs past the cap without declaring it', async () => {
    const { server, hub } = await serving();

    const outcome = await new Promise<string>((resolve) => {
      const outbound = request(
        {
          host: '127.0.0.1',
          port: server.port,
          method: 'POST',
          path: '/actions?client=one',
          headers: {
            Host: `127.0.0.1:${server.port}`,
            Authorization: `Bearer ${server.token}`,
            'Content-Type': 'application/json',
            'Transfer-Encoding': 'chunked',
          },
        },
        (response) => resolve(`answered ${response.statusCode}`),
      );

      outbound.on('error', (error: NodeJS.ErrnoException) => resolve(`dropped ${error.code}`));
      outbound.write('x'.repeat(BODY_LIMIT_BYTES + 1));
      outbound.end();
    });

    expect(outcome).toBe('dropped ECONNRESET');
    expect(hub.received).toEqual([]);
  });

  /** A proxy-style target carries its own host, and the `Host` check below it would read whatever it declared. */
  it('refuses a request target that is not a path', async () => {
    const { server } = await serving();

    const answer = await new Promise<string>((resolve) => {
      const socket = connect(server.port, '127.0.0.1', () => {
        socket.write(
          ['GET http://evil.example.com/snapshot HTTP/1.1', `Host: 127.0.0.1:${server.port}`, '', ''].join(CRLF),
        );
      });

      let text = '';

      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        text += chunk;

        if (text.includes(CRLF + CRLF)) {
          socket.destroy();
          resolve(text);
        }
      });
      socket.on('error', () => resolve(''));
    });

    expect(answer.split(CRLF)[0]).toBe('HTTP/1.1 400 Bad Request');
  });

  it('refuses a route it does not have, and a method it does not take there', async () => {
    const { server } = await serving();

    expect((await post(server, '/nothing', {})).status).toBe(404);
    expect((await post(server, '/hub', {})).status).toBe(405);
    expect((await call(server, { path: '/snapshot', method: 'DELETE' })).status).toBe(405);
  });

  it('holds no more streams than the bound', async () => {
    const { server } = await serving();

    for (let index = 0; index < MAX_EVENT_STREAMS; index++) {
      await stream(server, `client-${index}`);
    }

    const answer = await call(server, { path: '/events?client=one-too-many' });

    expect(answer.status).toBe(503);

    // One of the eight reconnecting is not a ninth, and must not be turned away by its own open stream.
    const again = await stream(server, 'client-0');

    await until(() => again.frames.length > 0);
    expect(again.frames).toEqual([': open']);
  });

  it('needs a client named on a stream and on an action', async () => {
    const { server } = await serving();

    expect((await call(server, { path: '/events' })).status).toBe(400);
    expect((await post(server, '/actions', { type: 'refresh' })).status).toBe(400);
  });
});

describe('a client on the wire', () => {
  it('connects with a hello over its own stream, and gets what the hub sends it', async () => {
    const { server, hub } = await serving();

    const events = await stream(server, 'board-1');
    const frame = events.next();

    expect((await post(server, '/actions?client=board-1', { type: 'hello', hello: hello('board-1') })).status).toBe(200);

    hub.connected.get('board-1')!({ type: 'changed', snapshot: SNAPSHOT });

    expect(await frame).toContain('event: changed');
    expect(JSON.parse((await frame).split('data: ')[1] ?? '{}')).toEqual({ type: 'changed', snapshot: SNAPSHOT });
  });

  it('refuses an action from a client that has not said hello, and a hello for another client', async () => {
    const { server, hub } = await serving();

    expect((await post(server, '/actions?client=board-1', { type: 'refresh' })).status).toBe(409);

    await stream(server, 'board-1');

    expect((await post(server, '/actions?client=board-1', { type: 'refresh' })).status).toBe(409);
    expect((await post(server, '/actions?client=board-1', { type: 'hello', hello: hello('other') })).status).toBe(400);
    expect(hub.received).toEqual([]);
  });

  it('forwards every later action under the client the stream belongs to', async () => {
    const { server, hub } = await serving();

    await stream(server, 'board-1');
    await post(server, '/actions?client=board-1', { type: 'hello', hello: hello('board-1') });
    await post(server, '/actions?client=board-1', { type: 'move', key: 'issue:1', lane: 'doing' });

    expect(hub.received).toEqual([{ id: 'board-1', message: { type: 'move', key: 'issue:1', lane: 'doing' } }]);
    expect(server.clients()).toBe(1);
  });

  /** A window that closed is a client the hub must stop counting, or nothing is ever idle (R35). */
  it('disconnects a client whose stream goes away', async () => {
    const { server, hub } = await serving();

    const events = await stream(server, 'board-1');

    await post(server, '/actions?client=board-1', { type: 'hello', hello: hello('board-1') });
    expect(server.clients()).toBe(1);

    events.end();
    await until(() => hub.disconnected.length > 0);

    expect(hub.disconnected).toEqual(['board-1']);
    expect(server.clients()).toBe(0);
    expect(server.emptySince()).not.toBeNull();
  });

  it('sends the snapshot down the stream the hub hands it to', async () => {
    const { server, hub } = await serving();

    const events = await stream(server, 'board-1');
    const frame = events.next();

    await post(server, '/actions?client=board-1', { type: 'hello', hello: hello('board-1') });
    hub.connected.get('board-1')!({ type: 'snapshot', snapshot: SNAPSHOT });

    expect(await frame).toContain('event: snapshot');
    expect(JSON.parse((await frame).split('data: ')[1] ?? '{}')).toEqual({ type: 'snapshot', snapshot: SNAPSHOT });
  });

  it('sends a heartbeat down every open stream', async () => {
    const clock = fakeClock();
    const { server } = await serving(clock);

    const events = await stream(server, 'board-1');
    const frame = events.next();

    clock.beat();

    expect(await frame).toBe(': ping');
    expect(clock.cadence).toBe(HEARTBEAT_MS);
  });

  /** A window reopening its board replaces its stream, and the hub must be told the one behind it went. */
  it('drops the client behind a stream a second one replaces', async () => {
    const { server, hub } = await serving();

    const first = await stream(server, 'board-1');

    await post(server, '/actions?client=board-1', { type: 'hello', hello: hello('board-1') });

    const second = await stream(server, 'board-1');

    await until(() => hub.disconnected.length > 0);
    expect(hub.disconnected).toEqual(['board-1']);
    expect(server.clients()).toBe(0);

    await post(server, '/actions?client=board-1', { type: 'hello', hello: hello('board-1') });
    hub.connected.get('board-1')!({ type: 'changed', snapshot: SNAPSHOT });

    await until(() => second.frames.length > 1);
    expect(second.frames.at(-1)).toContain('event: changed');
    expect(first.frames).toEqual([': open']);
  });

  /** A board saying hello twice has changed what it is, not reconnected: what that means is the hub's to decide. */
  it('forwards a second hello rather than connecting twice', async () => {
    const { server, hub } = await serving();

    await stream(server, 'board-1');
    await post(server, '/actions?client=board-1', { type: 'hello', hello: hello('board-1') });
    await post(server, '/actions?client=board-1', { type: 'hello', hello: hello('board-1') });

    expect(hub.received).toEqual([{ id: 'board-1', message: { type: 'hello', hello: hello('board-1') } }]);
    expect(server.clients()).toBe(1);
  });

  it('stops when a client with the token asks it to', async () => {
    const { server, stops } = await serving();

    expect((await post(server, '/shutdown', {})).status).toBe(200);
    expect((await post(server, '/shutdown', {}, { token: 'wrong' })).status).toBe(401);
    expect(stops).toEqual(['asked']);
  });
});
