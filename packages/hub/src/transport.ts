import { request } from 'node:http';
import type { ClientRequest } from 'node:http';
import type { ClientHello, ClientMessage, HubMessage, Session } from '@ground-control/core';
import type { HubRecord } from './discover.js';
import type { Ensured } from './ensure.js';

export interface TransportDeps {
  /** Finds or starts the hub. Called again on every reconnect, because a hub that exited has to be started again. */
  ensure(): Promise<Ensured>;
  /** Built fresh per connection, so what it says about watching is what is true when the stream opens. */
  hello(): ClientHello;
  onMessage(message: HubMessage): void;
  /** Ran after every accepted hello, so a client can restate anything the hub forgot — a hub it just started knows nothing. */
  afterHello(): void;
  /** Said once per outage, and once when it clears. A board that cannot reach its hub shows nothing otherwise. */
  onTrouble(message: string | null): void;
  /** How long a request may take before it is treated as a hub that is gone. Injected only so a test can wait. */
  deadlineMs?: number;
}

/** Doubling from a second, capped where a developer who walked away is not making a request a second forever. */
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

/** Longer than the hub's 20 s heartbeat, so quiet is only ever read as dead when the heartbeat has stopped too. */
const STREAM_IDLE_MS = 60_000;

/**
 * Absolute, not a socket's inactivity timer: a listener that trickles bytes faster than that timer resets it forever.
 * Wide enough for `GET /roster`, which spawns an agent CLI before it can answer (`mechanics.md` §2).
 */
const REQUEST_DEADLINE_MS = 15_000;

/** Actions taken while the stream was down, replayed after the next hello. Bounded: a queue is not a spool. */
const PENDING_LIMIT = 32;

/** A request the hub never received, as against one it received and refused. Only the first is worth trying again. */
type Posted = 'ok' | 'refused' | 'unreachable';

/**
 * This window's connection to the hub: an event stream in, actions out, and a reconnect when either goes. The
 * transport holds no board state — what it carries is the protocol, and what it decides is only when to try again.
 */
export class HubTransport {
  readonly #deps: TransportDeps;
  readonly #id: string;
  readonly #pending: ClientMessage[] = [];

  /** The stream request, held from before its response so that disposing mid-connect has something to abort. */
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

  /** Queued while the stream is down and sent after the next hello, so a card moved mid-reconnect is not dropped. */
  send(message: ClientMessage): void {
    if (this.#disposed) {
      return;
    }

    // A configuration is never queued: the client restates it after every hello, and a queued one is by then the
    // settings of some earlier minute — replayed on top, it would undo the change the developer just made.
    if (!this.#live) {
      if (message.type !== 'configure' && this.#pending.length < PENDING_LIMIT) {
        this.#pending.push(message);
      }

      return;
    }

    void this.#deliver(message);
  }

  /**
   * A fresh read of the machine, for a route being carried out here. Null is a read that did not happen — never an
   * empty list, which its caller would take for "nothing is running" and act on (R24).
   */
  async roster(): Promise<readonly Session[] | null> {
    const answer = (await this.#get('/roster')) as { sessions?: Session[] } | null;

    return answer?.sessions ?? null;
  }

  dispose(): void {
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

    // Disposed while the hub was being found or started. Whatever it started is the next window's to connect to.
    if (this.#disposed) {
      return;
    }

    if ('failed' in ensured) {
      this.#trouble(ensured.failed);
      this.#later();

      return;
    }

    this.#record = ensured.hub.record;
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
        // Not the stream this transport is on any more: disposed, or replaced by a reconnect. Answering now would
        // register this window with the hub again and hold a stream nothing here would ever close.
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

        let buffer = '';

        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          buffer += chunk;

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

    // The hub writes a heartbeat every 20 s, so silence past this is a hub that is gone rather than a quiet one.
    outbound.setTimeout(STREAM_IDLE_MS, () => outbound.destroy());
    outbound.on('error', () => this.#lost('This window could not reach the hub.'));
    outbound.end();
  }

  /** One event. Every message the hub sends is the frame's own JSON, so the event name is not read. */
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
      this.#deps.onMessage(JSON.parse(data) as HubMessage);
    } catch {
      // A frame this client cannot parse is a hub speaking something else, which the protocol check at connect is
      // what guards; dropping the frame beats taking the extension host down over it.
    }
  }

  /**
   * The hub knows nothing of a client until its hello, so a stream without one is not a connection. A hello that
   * did not land goes back through `#lost`: the alternative is a transport that looks healthy, is registered
   * nowhere, and never drains what it queued.
   */
  async #sayHello(): Promise<void> {
    const said = await this.#deliver({ type: 'hello', hello: this.#deps.hello() });

    if (said !== 'ok') {
      this.#lost('The hub would not take this window as a client.');

      return;
    }

    this.#retryMs = FIRST_RETRY_MS;
    this.#trouble(null);
    this.#deps.afterHello();

    // One at a time: fired together they arrive in whatever order the sockets settle in, and two of these are a
    // lane placement and a visibility, where the last one to land is the one that sticks.
    while (this.#live && this.#pending.length > 0) {
      await this.#deliver(this.#pending.shift()!);
    }
  }

  /**
   * Sends one action, and treats a hub that never received it as a connection that has gone: the message goes back
   * on the queue and the reconnect delivers it. A hub that received and refused it is not retried — nothing about
   * sending it again would change the answer.
   */
  async #deliver(message: ClientMessage): Promise<Posted> {
    const posted = await this.#post(message);

    if (posted === 'unreachable' && message.type !== 'hello') {
      if (this.#pending.length < PENDING_LIMIT) {
        this.#pending.unshift(message);
      }

      this.#lost('This window lost its connection to the hub.');
    }

    return posted;
  }

  /**
   * A stream that went away. Called for a connection that was never established as well, which is the same to a
   * developer and the same to the backoff — but only the established case has anything to tear down.
   */
  #lost(why: string): void {
    if (this.#disposed) {
      return;
    }

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

    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      void this.#connect();
    }, this.#retryMs);

    this.#retryMs = Math.min(MAX_RETRY_MS, this.#retryMs * 2);
  }

  /** Said on the way in and on the way out, and never twice: an outage is one message, not one per retry. */
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
          // Never a pooled socket: the hub closes an idle one after five seconds, and an action dispatched onto it
          // as it goes fails with a reset that no client is told to retry.
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
          let body = '';

          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          response.on('end', () => {
            try {
              done(response.statusCode === 200 ? JSON.parse(body) : null);
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
