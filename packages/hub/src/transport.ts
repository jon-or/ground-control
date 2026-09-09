import { request } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import type { ClientRequest } from 'node:http';
import type { ClientHello, ClientMessage, HubMessage, Session } from '@ground-control/core';
import type { HubRecord } from './discover.js';
import type { Ensured } from './ensure.js';

export interface TransportDeps {
  /** Find or start the hub on each reconnect. */
  ensure(): Promise<Ensured>;
  /** Build each hello from the current watching state. */
  hello(): ClientHello;
  onMessage(message: HubMessage): void;
  /** Restate client settings after each accepted hello, including hub restarts. */
  afterHello(): void;
  /** Report each outage and recovery once. */
  onTrouble(message: string | null): void;
  /** Log connection changes at the default level and individual messages at debug level. */
  log?(level: 'debug' | 'info' | 'warn', message: string): void;
  /** Request timeout, injectable for tests. */
  deadlineMs?: number;
}

/** Exponential reconnect delay, starting at one second and capped. */
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

/** Exceed the hub's 20-second heartbeat interval before declaring the stream disconnected. */
const STREAM_IDLE_MS = 60_000;

/** Use an absolute deadline so trickling bytes cannot prevent timeout. Allow time for GET /roster CLI reads (M2). */
const REQUEST_DEADLINE_MS = 15_000;

/** Bound the action queue while disconnected; replay after hello. */
const PENDING_LIMIT = 32;

/** Distinguish transport failures, which permit retries, from hub refusals. */
type Posted = 'ok' | 'refused' | 'unreachable';

/** Do not queue messages restated after hello: stale configure messages overwrite current settings and duplicate watchLog requests repeat log backfill. */
function restated(message: ClientMessage): boolean {
  return message.type === 'configure' || message.type === 'watchLog';
}

/** Maintain the event stream, action requests, and reconnection without storing board state. */
export class HubTransport {
  readonly #deps: TransportDeps;
  readonly #id: string;
  readonly #pending: ClientMessage[] = [];

  /** Retain the request before its response so disposal can abort connection attempts. */
  #stream: ClientRequest | undefined;
  #live = false;
  #record: HubRecord | undefined;
  #retryMs = FIRST_RETRY_MS;
  readonly #deadlineMs: number;
  #retry: NodeJS.Timeout | undefined;
  #troubled = false;
  #disposed = false;

  constructor(id: string, deps: TransportDeps) {
    this.#id = id;
    this.#deps = deps;
    this.#deadlineMs = deps.deadlineMs ?? REQUEST_DEADLINE_MS;
    void this.#connect();
  }

  /** Queue actions until reconnect so lane changes are retained. */
  send(message: ClientMessage): void {
    if (this.#disposed) {
      return;
    }

    if (!this.#live) {
      if (!restated(message) && this.#pending.length < PENDING_LIMIT) {
        this.#pending.push(message);
      }

      return;
    }

    void this.#deliver(message);
  }

  /** Read the roster for a local open route. Null means the read failed; an empty list would falsely imply no active sessions (R24). */
  async roster(): Promise<readonly Session[] | null> {
    const answer = (await this.#get('/roster')) as { sessions?: Session[] } | null;

    return answer?.sessions ?? null;
  }

  dispose(): void {
    this.#say('info', 'closing hub connection');
    this.#disposed = true;
    clearTimeout(this.#retry);
    this.#stream?.destroy();
    this.#stream = undefined;
    this.#live = false;
  }

  // — the connection —

  async #connect(): Promise<void> {
    if (this.#disposed || this.#stream !== undefined) {
      return;
    }

    const ensured = await this.#deps.ensure();

    // Ignore discovery results after disposal; leave the shared hub running.
    if (this.#disposed) {
      return;
    }

    if ('failed' in ensured) {
      this.#say('warn', `no hub to connect to: ${ensured.failed}`);
      this.#trouble(ensured.failed);
      this.#later();

      return;
    }

    this.#record = ensured.hub.record;
    this.#say('info', `opening a stream to 127.0.0.1:${ensured.hub.record.port}`);
    this.#open(ensured.hub.record);
  }

  #open(record: HubRecord): void {
    const outbound = request(
      {
        host: '127.0.0.1',
        port: record.port,
        method: 'GET',
        path: `/events?client=${encodeURIComponent(this.#id)}`,
        headers: {
          Host: `127.0.0.1:${record.port}`,
          Authorization: `Bearer ${record.token}`,
          Accept: 'text/event-stream',
        },
        agent: false,
      },
      (response) => {
        // Ignore replaced or disposed streams to avoid registering an untracked connection.
        if (this.#disposed || this.#stream !== outbound) {
          response.resume();
          outbound.destroy();

          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          this.#lost(`The hub refused this window's connection (${response.statusCode ?? 0}).`);

          return;
        }

        this.#live = true;
        void this.#sayHello();

        // Keep byte chunks for Node inspector compatibility (M28). StringDecoder preserves multibyte characters split across chunks.
        const decoder = new StringDecoder('utf8');

        let buffer = '';

        response.on('data', (chunk: Buffer) => {
          buffer += decoder.write(chunk);

          for (let cut = buffer.indexOf('\n\n'); cut !== -1; cut = buffer.indexOf('\n\n')) {
            this.#frame(buffer.slice(0, cut));
            buffer = buffer.slice(cut + 2);
          }
        });
        response.on('end', () => this.#lost('The hub closed this window’s connection.'));
        response.on('error', () => this.#lost('This window lost its connection to the hub.'));
      },
    );

    this.#stream = outbound;

    // The heartbeat interval is 20 seconds; longer silence triggers reconnection.
    outbound.setTimeout(STREAM_IDLE_MS, () => outbound.destroy());
    outbound.on('error', () => this.#lost('This window could not reach the hub.'));
    outbound.end();
  }

  /** Parse each event's JSON data; the event name is unused. */
  #frame(text: string): void {
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');

    if (data === '') {
      return;
    }

    try {
      const message = JSON.parse(data) as HubMessage;

      // Exclude log messages from transport logging; they already have their own output channel.
      if (message.type !== 'log') {
        this.#say('debug', `the hub sent ${message.type}`);
      }

      this.#deps.onMessage(message);
    } catch {
      // Ignore malformed frames instead of failing the extension host.
    }
  }

  /** Complete hello before treating the stream as connected. Failed registration must reconnect and retain queued actions. */
  async #sayHello(): Promise<void> {
    const said = await this.#deliver({ type: 'hello', hello: this.#deps.hello() });

    if (said !== 'ok') {
      this.#lost('The hub would not take this window as a client.');

      return;
    }

    this.#retryMs = FIRST_RETRY_MS;
    this.#say('info', `hub connected; ${this.#pending.length} action(s) queued`);
    this.#trouble(null);
    this.#deps.afterHello();

    // Send sequentially to preserve action order, including lane and visibility changes.
    while (this.#live && this.#pending.length > 0) {
      await this.#deliver(this.#pending.shift()!);
    }
  }

  /** Requeue transport failures and reconnect. Do not retry requests the hub refused. */
  async #deliver(message: ClientMessage): Promise<Posted> {
    const posted = await this.#post(message);

    this.#say(posted === 'ok' ? 'debug' : 'warn', `sent ${message.type}: ${posted}`);

    if (posted === 'unreachable' && message.type !== 'hello') {
      // Exclude restated messages here too when a previously live connection fails during send.
      if (!restated(message) && this.#pending.length < PENDING_LIMIT) {
        this.#pending.unshift(message);
      }

      this.#lost('This window lost its connection to the hub.');
    }

    return posted;
  }

  /** Reconnect after connection failure or stream loss, cleaning up established streams. */
  #lost(why: string): void {
    if (this.#disposed) {
      return;
    }

    this.#say('warn', `hub stream disconnected: ${why}`);
    this.#stream?.destroy();
    this.#stream = undefined;
    this.#live = false;
    this.#trouble(why);
    this.#later();
  }

  #later(): void {
    if (this.#disposed || this.#retry !== undefined) {
      return;
    }

    this.#say('info', `trying again in ${this.#retryMs}ms`);

    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      void this.#connect();
    }, this.#retryMs);

    this.#retryMs = Math.min(MAX_RETRY_MS, this.#retryMs * 2);
  }

  /** Write connection diagnostics to the client log even when no board is visible (R40). */
  #say(level: 'debug' | 'info' | 'warn', message: string): void {
    // Ignore requests completing after disposal; the client log may already be closed.
    if (this.#disposed) {
      return;
    }

    this.#deps.log?.(level, message);
  }

  /** Report outage and recovery once each, not per retry. */
  #trouble(message: string | null): void {
    if (message === null) {
      if (this.#troubled) {
        this.#troubled = false;
        this.#deps.onTrouble(null);
      }

      return;
    }

    if (!this.#troubled) {
      this.#troubled = true;
      this.#deps.onTrouble(message);
    }
  }

  // — requests —

  #post(message: ClientMessage): Promise<Posted> {
    const record = this.#record;

    if (record === undefined) {
      return Promise.resolve('unreachable');
    }

    const body = JSON.stringify(message);

    return new Promise((resolve) => {
      const outbound = request(
        {
          host: '127.0.0.1',
          port: record.port,
          method: 'POST',
          path: `/actions?client=${encodeURIComponent(this.#id)}`,
          headers: {
            Host: `127.0.0.1:${record.port}`,
            Authorization: `Bearer ${record.token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          // Disable socket pooling to avoid resets when the hub closes idle connections.
          agent: false,
        },
        (response) => {
          response.resume();
          response.on('end', () => done(response.statusCode === 200 ? 'ok' : 'refused'));
        },
      );

      const deadline = setTimeout(() => {
        outbound.destroy();
        done('unreachable');
      }, this.#deadlineMs);

      let settled = false;

      function done(posted: Posted): void {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(deadline);
        resolve(posted);
      }

      outbound.on('error', () => done('unreachable'));
      outbound.end(body);
    });
  }

  #get(path: string): Promise<unknown> {
    const record = this.#record;

    if (record === undefined) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const outbound = request(
        {
          host: '127.0.0.1',
          port: record.port,
          method: 'GET',
          path,
          headers: { Host: `127.0.0.1:${record.port}`, Authorization: `Bearer ${record.token}` },
          agent: false,
        },
        (response) => {
          const chunks: Buffer[] = [];

          response.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              done(response.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null);
            } catch {
              done(null);
            }
          });
        },
      );

      const deadline = setTimeout(() => {
        outbound.destroy();
        done(null);
      }, this.#deadlineMs);

      let settled = false;

      function done(answer: unknown): void {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(deadline);
        resolve(answer);
      }

      outbound.on('error', () => done(null));
      outbound.end();
    });
  }
}
