import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { PROTOCOL } from '@ground-control/core';
import type { Client, ClientHello, ClientMessage, HubMessage, Session, Snapshot } from '@ground-control/core';

/**
 * What the server needs of the hub, and nothing more. Narrow so the server's own tests drive a fake: whether a
 * request is refused has nothing to do with what the loop would have answered.
 */
export interface ServableHub {
  connect(hello: ClientHello, send: (message: HubMessage) => void): Client;
  disconnect(client: Client): void;
  receive(client: Client, message: ClientMessage): void;
  snapshot(): Snapshot;
  /** A fresh read of the sessions on this machine. The resident half polls it while it carries out an open route. */
  roster(): Promise<readonly Session[] | null>;
}

export interface ServerClock {
  setInterval(fn: () => void, ms: number): NodeJS.Timeout;
  clearInterval(handle: NodeJS.Timeout): void;
}

export interface HubServerDeps {
  hub: ServableHub;
  /** Identifies which hub this is: a client that finds a listener on the recorded port asks before it sends a token. */
  fingerprint: string;
  clock?: ServerClock;
  /** Called by `POST /shutdown`. Windows has no signal that reaches a console-less process, so this is the stop. */
  onShutdown(): void;
  /**
   * Where a refused request is recorded. A client that is turned away sees only a status, and the three refusals
   * before any route read as "this is not a hub" from there — so if the hub does not write them down, a board that
   * cannot reach the hub it can see leaves no evidence anywhere on the machine.
   */
  log(line: string): void;
}

export interface HubServer {
  readonly port: number;
  readonly token: string;
  /** How many clients have said hello over a stream that is still open. Zero is what the idle rule waits on. */
  clients(): number;
  /** When the last client went away, or null while one is connected. Observed, not sampled, so nothing is missed. */
  emptySince(): number | null;
  close(): Promise<void>;
}

/**
 * Proves a listener holds the token without disclosing it. The fingerprint says which home a hub is for, and a home
 * path is guessable, so on its own it lets any local process impersonate a hub the developer's own record points at.
 */
export function proofOf(token: string, nonce: string): string {
  return createHmac('sha256', token).update(nonce).digest('base64url');
}

/** A body larger than this is not a `ClientMessage` from any client of ours. */
export const BODY_LIMIT_BYTES = 64 * 1024;

/** Enough streams for every window a developer has open, and a bound on what one confused client can hold. */
export const MAX_EVENT_STREAMS = 8;

/** A comment line down each stream, so a proxy or a client's own idle timeout never mistakes quiet for dead. */
export const HEARTBEAT_MS = 20_000;

/**
 * What a minute of refusals may write. Any page the developer visits can make the hub refuse it — a `fetch` at the
 * loopback port is refused for its `Origin`, needing no preflight — and each refusal is a synchronous append on the
 * hub's own event loop. Without a bound, a page in a background tab is both an unbounded file and a slow board.
 */
export const REFUSALS_PER_MINUTE = 20;
const REFUSAL_WINDOW_MS = 60_000;

/** Enough of a target or a header to recognise it. The rest is whoever sent it choosing what the log looks like. */
const REFUSAL_DETAIL_LIMIT = 120;

function clipped(text: string): string {
  return text.length > REFUSAL_DETAIL_LIMIT ? `${text.slice(0, REFUSAL_DETAIL_LIMIT)}…` : text;
}

/**
 * Both bound the arrival of a request, not the life of a response, so an event stream held open for hours is not
 * theirs to close: a `GET /events` is complete the moment its headers land.
 */
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

const REAL_CLOCK: ServerClock = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle),
};

interface Stream {
  response: ServerResponse;
  client: Client | null;
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant time, after a length check, because comparing lengths first is the only part that may short-circuit. */
function tokenMatches(offered: string, token: string): boolean {
  const a = Buffer.from(offered);
  const b = Buffer.from(token);

  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization ?? '';

  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);

  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(text);
}

function refuse(response: ServerResponse, status: number, message: string): void {
  send(response, status, { error: message });
}

/** A declared length over the cap, refused before a byte is read. Every client of ours declares one. */
function declaresTooMuch(request: IncomingMessage): boolean {
  return Number(request.headers['content-length'] ?? 0) > BODY_LIMIT_BYTES;
}

/**
 * Null means the body ran past the cap without declaring it, and the connection has been dropped. Refusing in a
 * response would mean reading to the end first, which is the cost the cap exists to avoid.
 */
function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;

      if (size > BODY_LIMIT_BYTES) {
        resolve(null);
        request.destroy();

        return;
      }

      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => resolve(null));
  });
}

/**
 * The hub over loopback HTTP: the snapshot and the actions as requests, changes as Server-Sent Events. Every route
 * but `GET /hub` carries a bearer token, and no request carrying an `Origin` is answered at all — a web page can
 * reach loopback, and `configure` carries paths the hub will spawn. The browser board is reached through the bridge.
 */
export function createHubServer(deps: HubServerDeps): { server: Server; listen(): Promise<HubServer> } {
  const clock = deps.clock ?? REAL_CLOCK;
  const token = newToken();
  const streams = new Map<string, Stream>();

  /** The refusals written this minute, and when that minute began. Whoever is refused does not get to fill a disk. */
  let refusals = 0;
  let refusedSince = 0;

  let port = 0;

  const identity = { hub: 'ground-control', protocol: PROTOCOL, fingerprint: deps.fingerprint };

  let empty: number | null = Date.now();

  /** Observed on every change rather than sampled, so a board that opens and closes between two ticks is not missed. */
  function count(): void {
    const connected = [...streams.values()].filter((stream) => stream.client !== null).length;

    empty = connected > 0 ? null : (empty ?? Date.now());
  }

  function push(stream: Stream, event: string, data: unknown): void {
    // A hub holding a send callback for a stream that has already ended would take the process down: a write after
    // `end` raises on the response, and an unhandled raise there is fatal.
    if (stream.response.writableEnded) {
      return;
    }

    stream.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function drop(id: string): void {
    const stream = streams.get(id);

    if (!stream) {
      return;
    }

    streams.delete(id);

    if (stream.client) {
      deps.hub.disconnect(stream.client);
    }

    stream.response.end();
    count();
  }

  function openStream(id: string, request: IncomingMessage, response: ServerResponse): void {
    // A client replacing its own stream is not a ninth: a board whose connection dropped would otherwise be refused
    // by the streams already counted, including its own.
    if (!streams.has(id) && streams.size >= MAX_EVENT_STREAMS) {
      refuse(response, 503, 'Too many event streams are open.');

      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    response.write(': open\n\n');

    const stream: Stream = { response, client: null };

    drop(id);
    streams.set(id, stream);
    request.on('close', () => {
      if (streams.get(id) === stream) {
        drop(id);
      }
    });
  }

  function act(id: string, message: ClientMessage, response: ServerResponse): void {
    const stream = streams.get(id);

    if (!stream) {
      refuse(response, 409, 'Open an event stream for this client before sending it actions.');

      return;
    }

    if (message.type === 'hello') {
      if (message.hello.id !== id) {
        refuse(response, 400, 'The hello names a different client than the stream it arrived for.');

        return;
      }

      if (stream.client) {
        deps.hub.receive(stream.client, message);
      } else {
        stream.client = deps.hub.connect(message.hello, (outbound) => push(stream, outbound.type, outbound));
        count();
      }

      send(response, 200, { ok: true });

      return;
    }

    if (!stream.client) {
      refuse(response, 409, 'Say hello before sending any other action.');

      return;
    }

    deps.hub.receive(stream.client, message);
    send(response, 200, { ok: true });
  }

  /**
   * Refused, and written down. The answer stays what it was — a client is told no more than that it was turned away
   * — while the log carries the header that decided it, which is the only copy of that fact anywhere. What the
   * refused party chose is clipped and rationed: it is the one thing here that a web page gets to put in a file.
   */
  function turnAway(
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    message: string,
    detail = message,
  ): void {
    const now = Date.now();

    if (now - refusedSince > REFUSAL_WINDOW_MS) {
      refusedSince = now;
      refusals = 0;
    }

    refusals += 1;

    if (refusals <= REFUSALS_PER_MINUTE) {
      deps.log(`refused ${request.method ?? '?'} ${clipped(request.url ?? '?')}: ${detail}`);
    } else if (refusals === REFUSALS_PER_MINUTE + 1) {
      deps.log('refusing more than this log will carry; saying no more about it this minute');
    }

    refuse(response, status, message);
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Anything a browser sends carries this, and nothing the hub answers is for a browser.
    if (request.headers.origin !== undefined) {
      turnAway(
        request,
        response,
        403,
        'This hub does not answer requests from a browser.',
        `an Origin header, ${clipped(String(request.headers.origin))}`,
      );

      return;
    }

    const target = request.url ?? '/';

    // An absolute-form target is a proxy request; the `Host` check below reads the header, which such a request may
    // set to anything.
    if (!target.startsWith('/')) {
      turnAway(request, response, 400, 'Unsupported request target.');

      return;
    }

    if (request.headers.host !== `127.0.0.1:${port}`) {
      turnAway(
        request,
        response,
        403,
        'This hub answers only on its own loopback address.',
        `a Host of ${clipped(request.headers.host ?? 'nothing')}, not 127.0.0.1:${port}`,
      );

      return;
    }

    const url = new URL(target, `http://127.0.0.1:${port}`);
    const path = url.pathname;

    if (path === '/hub') {
      if (request.method !== 'GET') {
        refuse(response, 405, 'Use GET.');

        return;
      }

      const nonce = url.searchParams.get('nonce');

      send(response, 200, nonce ? { ...identity, proof: proofOf(token, nonce) } : identity);

      return;
    }

    if (!tokenMatches(bearer(request), token)) {
      refuse(response, 401, 'This hub needs the token from hub.json.');

      return;
    }

    if (path === '/snapshot' && request.method === 'GET') {
      send(response, 200, deps.hub.snapshot());

      return;
    }

    // A read, not an action, because the client that asks is carrying out a route rather than changing anything —
    // and it asks repeatedly while it waits for a session to land, which no event stream can answer.
    if (path === '/roster' && request.method === 'GET') {
      send(response, 200, { sessions: await deps.hub.roster() });

      return;
    }

    if (path === '/events' && request.method === 'GET') {
      const id = url.searchParams.get('client');

      if (!id) {
        refuse(response, 400, 'Name the client this stream is for.');

        return;
      }

      openStream(id, request, response);

      return;
    }

    if (request.method !== 'POST') {
      refuse(response, 405, 'Use POST.');

      return;
    }

    if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
      refuse(response, 415, 'Send application/json.');

      return;
    }

    if (declaresTooMuch(request)) {
      // Closed rather than kept alive: the body is never read, so the connection cannot carry another request.
      response.setHeader('Connection', 'close');
      refuse(response, 413, 'That body is larger than this hub accepts.');

      return;
    }

    const body = await readBody(request);

    if (body === null) {
      return;
    }

    if (path === '/shutdown') {
      send(response, 200, { ok: true });
      deps.onShutdown();

      return;
    }

    if (path !== '/actions') {
      refuse(response, 404, 'No such route.');

      return;
    }

    const id = url.searchParams.get('client');

    if (!id) {
      refuse(response, 400, 'Name the client this action is from.');

      return;
    }

    let message: ClientMessage;

    try {
      message = JSON.parse(body) as ClientMessage;
    } catch {
      refuse(response, 400, 'That body is not JSON.');

      return;
    }

    act(id, message, response);
  }

  const server = createServer((request, response) => {
    void route(request, response).catch(() => {
      if (!response.headersSent) {
        refuse(response, 500, 'The hub could not answer that.');
      }
    });
  });

  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;

  return {
    server,
    listen: () =>
      new Promise<HubServer>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();

          if (address === null || typeof address === 'string') {
            reject(new Error('The hub bound to something that is not a loopback port.'));

            return;
          }

          port = address.port;

          const beat = clock.setInterval(() => {
            for (const stream of streams.values()) {
              stream.response.write(': ping\n\n');
            }
          }, HEARTBEAT_MS);

          resolve({
            port,
            token,
            clients: () => [...streams.values()].filter((stream) => stream.client !== null).length,
            emptySince: () => empty,
            close: () =>
              new Promise<void>((done) => {
                clock.clearInterval(beat);

                for (const id of [...streams.keys()]) {
                  drop(id);
                }

                server.close(() => done());
                server.closeAllConnections();
              }),
          });
        });
      }),
  };
}
