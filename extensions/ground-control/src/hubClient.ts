import * as vscode from 'vscode';
import type { ClientHello, ClientMessage, HubConfig, HubMessage, Session, Snapshot } from '@ground-control/core';
import { HubTransport } from '@ground-control/hub';
import { makeHubProcess } from './hubProcess.js';
import { host } from './registry.js';
import { boardRoot, perform, refuse } from './resident.js';

/**
 * This window's one client. It holds the connection, the configuration it has pushed, and whether a board is
 * watching — all of which outlive any board, because turning the signal off has to take effect with no board open
 * (R34) and because a window that opened a board once keeps the hub up for the browser overlay (R35).
 */
export class HubClient {
  /** One per extension host, and the stream and the hello must name the same one or the hub refuses the hello. */
  readonly #id = `vscode-${process.pid}`;
  readonly #transport: HubTransport;
  readonly #snapshots = new vscode.EventEmitter<Snapshot>();

  #config: HubConfig | undefined;
  #watching = false;
  #last: Snapshot | undefined;

  constructor(home: string, bundle: string) {
    const ensure = makeHubProcess(home, bundle);

    // Stable per extension host, not per board: the install notice is said once per client, and a fresh id on
    // every reopen would say it again and leave a mark nothing ever clears (R25).
    this.#transport = new HubTransport(this.#id, {
      ensure,
      hello: () => this.#hello(),
      // A hub this window just started knows nothing about it, and so does one that restarted under a reconnect.
      afterHello: () => this.#restate(),
      onMessage: (message) => this.#onMessage(message),
      onTrouble: (message) => {
        if (message !== null) {
          void vscode.window.showWarningMessage(message);
        }
      },
    });
  }

  /** What every board in this window renders, or undefined before the hub has answered for the first time. */
  get snapshot(): Snapshot | undefined {
    return this.#last;
  }

  readonly onSnapshot = this.#snapshots.event;

  /**
   * The settings this window holds, pushed whole. `acknowledge` asks for the activity install's outcome back, and is
   * set only where a developer changed the setting themselves — a push on connect passes in silence.
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

  dispose(): void {
    this.#transport.dispose();
    this.#snapshots.dispose();
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
  }

  #onMessage(message: HubMessage): void {
    switch (message.type) {
      case 'snapshot':
      case 'changed':
        this.#last = message.snapshot;
        this.#snapshots.fire(message.snapshot);

        return;

      // The routes only something inside this window can carry out. Handled here rather than on the board, because
      // the board that asked may be gone by the time the plan comes back.
      case 'perform':
        void perform(message.route, () => this.roster());

        return;

      case 'notice':
        if (message.refusal) {
          void refuse(message.refusal, message.message);

          return;
        }

        void (message.level === 'error'
          ? vscode.window.showErrorMessage(message.message)
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
