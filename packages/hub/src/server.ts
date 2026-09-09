import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { PROTOCOL } from '@ground-control/core';
import type { Client, ClientHello, ClientMessage, HubMessage, Logger, Session, SessionCheck, Snapshot } from '@ground-control/core';

/** Minimal hub contract for routing and isolated server tests. */
export interface ServableHub {
  connect(hello: ClientHello, send: (message: HubMessage) => void): Client;
  disconnect(client: Client): void;
  receive(client: Client, message: ClientMessage): void;
  snapshot(): Snapshot;
  /** Read current sessions while the client completes an open route. */
  roster(): Promise<readonly Session[] | null>;
  /** Current authorization and duplicate checks without exposing hidden roster details. */
  sessionCheck?(sessionId: string): Promise<SessionCheck | null>;
}

export interface ServerClock {
  setInterval(fn: () => void, ms: number): NodeJS.Timeout;
  clearInterval(handle: NodeJS.Timeout): void;
}

export interface HubServerDeps {
  hub: ServableHub;
  /** Identify the listener before clients send authentication tokens. */
  fingerprint: string;
  clock?: ServerClock;
  /** POST /shutdown stops a console-less Windows hub, which cannot receive console signals. */
  onShutdown(): void;
  /** Log refusal details; clients receive only an HTTP status. */
  log: Logger;
}

export interface HubServer {
  readonly port: number;
  readonly token: string;
  /** Number of registered clients with open streams; zero permits idle shutdown. */
  clients(): number;
  /** Record the last disconnect time, or null while connected, without polling. */
  emptySince(): number | null;
  close(): Promise<void>;
}

/** Prove token possession without disclosure. A home fingerprint alone is guessable and cannot authenticate the hub. */
export function proofOf(token: string, nonce: string): string {
  return createHmac('sha256', token).update(nonce).digest('base64url');
}

/** Maximum accepted client message size. */
export const BODY_LIMIT_BYTES = 64 * 1024;

/** Bound concurrent streams per hub. */
export const MAX_EVENT_STREAMS = 8;

/** Send SSE comment heartbeats to prevent idle connection timeouts. */
export const HEARTBEAT_MS = 20_000;

/** Bound refusal logs per minute. Pages can send loopback requests, so unlimited synchronous logging could fill the disk and delay the hub. */
export const REFUSALS_PER_MINUTE = 20;
const REFUSAL_WINDOW_MS = 60_000;

/** Bound untrusted request target and header values in logs. */
const REFUSAL_DETAIL_LIMIT = 120;

function clipped(text: string): string {
  return text.length > REFUSAL_DETAIL_LIMIT ? `${text.slice(0, REFUSAL_DETAIL_LIMIT)}…` : text;
}

/** Bound request arrival, not response lifetime; completed GET /events requests may keep streaming. */
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

/** Use constant-time comparison after verifying equal lengths. */
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

/** Reject oversized declared bodies before reading them. */
function declaresTooMuch(request: IncomingMessage): boolean {
  return Number(request.headers['content-length'] ?? 0) > BODY_LIMIT_BYTES;
}

/** Null means an undeclared body exceeded the cap and its connection was dropped without reading the remainder. */
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

/** Serve loopback HTTP and SSE. Require bearer tokens except for GET /hub. Reject Origin headers because configure contains executable paths; Chrome uses the native bridge. */
export function createHubServer(deps: HubServerDeps): { server: Server; listen(): Promise<HubServer> } {
  const clock = deps.clock ?? REAL_CLOCK;
  const token = newToken();
  const streams = new Map<string, Stream>();

  /** Track refusal count and interval to enforce the log limit. */
  let refusals = 0;
  let refusedSince = 0;

  let port = 0;

  const identity = { hub: 'ground-control', protocol: PROTOCOL, fingerprint: deps.fingerprint };

  let empty: number | null = Date.now();

  /** Track every connection change so brief connections are not missed between ticks. */
  function count(): void {
    const connected = [...streams.values()].filter((stream) => stream.client !== null).length;

    empty = connected > 0 ? null : (empty ?? Date.now());
  }

  function push(stream: Stream, event: string, data: unknown): void {
    // Stop sending after stream closure; unhandled writes after end can terminate the process.
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
    // Replacing an existing client stream does not consume an additional slot.
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

  /** Log refusal details without disclosing them to the requester. Clip and rate-limit untrusted values. */
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
      deps.log.warn(`refused ${request.method ?? '?'} ${clipped(request.url ?? '?')}: ${detail}`, 'server');
    } else if (refusals === REFUSALS_PER_MINUTE + 1) {
      deps.log.warn('request refusal log limit reached; suppressing further entries this minute', 'server');
    }

    refuse(response, status, message);
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Reject direct browser requests; the overlay uses the native bridge.
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

    // Reject proxy-form targets, which can provide an unrelated Host header.
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

    // Read the current roster during route execution; clients may poll while waiting for a session to appear.
    if (path === '/roster' && request.method === 'GET') {
      send(response, 200, { sessions: await deps.hub.roster() });

      return;
    }

    if (path === '/session-check' && request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId || sessionId.length > 200 || !/^[a-z0-9_-]+$/i.test(sessionId) || url.searchParams.getAll('sessionId').length !== 1) {
        refuse(response, 400, 'Supply one valid session ID.');
        return;
      }
      send(response, 200, await deps.hub.sessionCheck?.(sessionId) ?? null);
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
      // Close the connection because an unread body prevents reuse.
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
