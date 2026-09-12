import * as vscode from 'vscode';
import type { ClientHello, ClientMessage, HubConfig, HubMessage, Session, SessionCheck, Snapshot } from '@ground-control/core';
import { HubTransport } from '@ground-control/hub';
import type { Ensured } from '@ground-control/hub';
import { makeHubProcess } from './hubProcess.js';
import { boardLog, hubLog, showHubEntries } from './logging.js';
import { host } from './registry.js';
import { boardRoot, perform, refuse } from './resident.js';

/** The hub's answer to one readDetail or readCustody, forwarded to whichever board asked for it. */
export type DetailMessage = Extract<HubMessage, { type: 'detail' | 'custody' }>;

/**
 * Keep one client per extension host so configuration works after the board closes (R34) and the hub remains
 * available to browser clients (R35).
 */
export class HubClient {
  /** One per extension host, and the stream and the hello must name the same one or the hub refuses the hello. */
  readonly #id = `vscode-${process.pid}`;
  readonly #ensure: () => Promise<Ensured>;
  #transport: HubTransport;
  readonly #snapshots = new vscode.EventEmitter<Snapshot>();
  readonly #streaming = new vscode.EventEmitter<boolean>();
  readonly #details = new vscode.EventEmitter<DetailMessage>();

  #config: HubConfig | undefined;
  #watching = false;
  #watchingLog = false;
  #last: Snapshot | undefined;
  #hubLines = 0;

  constructor(home: string, bundle: string) {
    this.#ensure = makeHubProcess(home, bundle);
    this.#transport = this.#connect();
  }

  /** Keep the client ID stable across board reopenings to avoid repeating installation notices and retaining unused IDs (R25). */
  #connect(): HubTransport {
    return new HubTransport(this.#id, {
      ensure: this.#ensure,
      hello: () => this.#hello(),
      // Resend client settings and subscriptions after connecting; the hub may have restarted.
      afterHello: () => this.#restate(),
      onMessage: (message) => this.#onMessage(message),
      // Preserve transport log levels so connection failures remain visible at the editor default level.
      log: (level, message) => boardLog()[level](message),
      onTrouble: (message) => {
        if (message === null) {
          boardLog().info('hub connection restored');

          return;
        }

        boardLog().warn(message);
        void vscode.window.showWarningMessage(message);
      },
    });
  }

  /** What every board in this window renders, or undefined before the hub has answered for the first time. */
  get snapshot(): Snapshot | undefined {
    return this.#last;
  }

  readonly onSnapshot = this.#snapshots.event;

  /** Detail answers for whichever board asked; every open board sees them and ignores keys it did not request. */
  readonly onDetail = this.#details.event;

  /** Fired whenever the hub's log starts or stops arriving, so every board in this window paints the same button. */
  readonly onStreamingChanged = this.#streaming.event;

  get streamingHubLog(): boolean {
    return this.#watchingLog;
  }

  /** How many of the hub's lines have reached this window. The only report the stream arrived; nothing else reads it. */
  get hubLines(): number {
    return this.#hubLines;
  }

  /**
   * Toggle the hub-log subscription independently of board visibility. Starting reveals the channel; stopping
   * leaves the output panel open. The command also permits unsubscribing after the board closes (R40).
   */
  toggleHubLog(): boolean {
    const streaming = this.#watchLog(!this.#watchingLog);

    if (streaming) {
      hubLog().show(true);
    }

    return streaming;
  }

  /**
   * Send the complete settings. Request an installation acknowledgement only for user changes, not initial
   * connection.
   */
  configure(config: HubConfig, acknowledge = false): void {
    this.#config = config;
    this.#transport.send(acknowledge ? { type: 'configure', config, acknowledge } : { type: 'configure', config });
  }

  watching(value: boolean): void {
    this.#watching = value;
    this.#transport.send({ type: 'watching', watching: value });
  }

  send(message: ClientMessage): void {
    this.#transport.send(message);
  }

  roster(): Promise<readonly Session[] | null> {
    return this.#transport.roster();
  }

  sessionCheck(sessionId: string): Promise<SessionCheck | null> {
    return this.#transport.sessionCheck(sessionId);
  }

  /** Stop connecting while the state directory moves, so no restart budget is spent on a hub that refuses to start. */
  suspend(): void {
    this.#transport.dispose();
  }

  /** Reconnect through discovery after a move; hello restates settings and subscriptions. */
  resume(): void {
    this.#transport = this.#connect();
  }

  dispose(): void {
    this.#transport.dispose();
    this.#snapshots.dispose();
    this.#streaming.dispose();
    this.#details.dispose();
  }

  #hello(): ClientHello {
    return {
      id: this.#id,
      hostId: host.id,
      workspaceRoot: boardRoot(),
      residentRoutes: [...host.residentRoutes],
      watching: this.#watching,
    };
  }

  #restate(): void {
    if (this.#config) {
      this.#transport.send({ type: 'configure', config: this.#config });
    }

    // Resubscribe after hub restart. Announce repeated backfill only if the channel already received content;
    // a subscription requested while disconnected has no prior tail.
    if (this.#watchingLog) {
      if (this.#hubLines > 0) {
        hubLog().appendLine('--- reconnected; replaying recent hub logs ---');
      }

      this.#transport.send({ type: 'watchLog', watching: true });
    }
  }

  #watchLog(watching: boolean): boolean {
    if (watching === this.#watchingLog) {
      return watching;
    }

    this.#watchingLog = watching;
    this.#transport.send({ type: 'watchLog', watching });

    // Mark the end of streaming explicitly so retained output cannot be mistaken for a quiet subscription.
    if (!watching) {
      hubLog().appendLine('--- hub log streaming stopped ---');
    }

    boardLog().info(watching ? 'hub log streaming started' : 'hub log streaming stopped');
    this.#streaming.fire(watching);

    return watching;
  }

  #onMessage(message: HubMessage): void {
    switch (message.type) {
      case 'snapshot':
      case 'changed':
        this.#last = message.snapshot;
        this.#snapshots.fire(message.snapshot);

        return;

      // Handle resident routes on the client because the requesting board may close before the response.
      case 'perform':
        void perform(message.route, () => this.roster(), (id) => this.sessionCheck(id));

        return;

      case 'log':
        // Discard lines arriving after unsubscribe so they do not appear below the stopped message.
        if (!this.#watchingLog) {
          return;
        }

        this.#hubLines += message.entries.length;
        showHubEntries(message.entries);

        return;

      case 'detail':
      case 'custody':
        this.#details.fire(message);

        return;

      case 'notice':
        if (message.refusal) {
          void refuse(message.refusal, message.message);

          return;
        }

        void (message.level === 'error'
          ? vscode.window.showErrorMessage(message.message)
          : message.level === 'warning'
            ? vscode.window.showWarningMessage(message.message)
            : vscode.window.showInformationMessage(message.message));

        return;
    }
  }
}

let current: HubClient | undefined;

/** Started once per extension host, on activation, whether or not a board is ever opened in this window. */
export function startClient(home: string, bundle: string): HubClient {
  current ??= new HubClient(home, bundle);

  return current;
}

export function client(): HubClient | undefined {
  return current;
}

export function disposeClient(): void {
  current?.dispose();
  current = undefined;
}
