import { LANE_ORDER } from '@ground-control/core';
import type { ClientHello, ClientMessage, HubMessage, LaneId } from '@ground-control/core';

/**
 * Chrome talks to a native host over stdio in length-prefixed frames: four bytes of length, then that many bytes of
 * UTF-8 JSON. A megabyte is what Chrome accepts back, so a frame over that is a bug on this side rather than
 * something to send and have the port closed for.
 */
export const FRAME_LIMIT_BYTES = 1024 * 1024;

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');

  if (body.length > FRAME_LIMIT_BYTES) {
    throw new Error(`A ${body.length} byte message is larger than Chrome will accept.`);
  }

  const header = Buffer.alloc(4);

  header.writeUInt32LE(body.length, 0);

  return Buffer.concat([header, body]);
}

/**
 * Reassembles frames from however stdin chunks them. One frame arrives across several reads and several arrive in
 * one, so neither the header nor the body can be assumed whole.
 */
export class FrameReader {
  #buffered: Buffer = Buffer.alloc(0);

  /** Every whole frame the new bytes completed. A frame that will not parse is dropped rather than thrown. */
  push(chunk: Buffer): unknown[] {
    this.#buffered = Buffer.concat([this.#buffered, chunk]);

    const messages: unknown[] = [];

    for (;;) {
      if (this.#buffered.length < 4) {
        return messages;
      }

      const length = this.#buffered.readUInt32LE(0);

      // Nothing sends a frame this large, so a header claiming one is a stream out of step with its frames. Reading
      // on would treat the rest of the port as one body that never completes.
      if (length > FRAME_LIMIT_BYTES) {
        this.#buffered = Buffer.alloc(0);

        return messages;
      }

      if (this.#buffered.length < 4 + length) {
        return messages;
      }

      const body = this.#buffered.subarray(4, 4 + length).toString('utf8');

      this.#buffered = this.#buffered.subarray(4 + length);

      try {
        messages.push(JSON.parse(body));
      } catch {
        // A frame that is not JSON is one message lost, not a port to tear down.
      }
    }
  }
}

/** What the bridge sends the browser. `trouble` is the bridge's own: the hub it relays is not answering. */
export type BridgeMessage = HubMessage | { type: 'trouble'; message: string | null };

/**
 * What the browser may ask for, and what it may not. The overlay watches and moves cards, and goes to a session by
 * navigating rather than through here (R36). A configuration carries paths the hub would spawn, stopping a session
 * and taking it over is the editor's (R15), and starting work on a card runs an agent against the developer's own
 * checkout (R39) — none of those is the browser's to send.
 */
export type BridgeAction = { send: ClientMessage } | { refused: string };

function isLane(value: unknown): value is LaneId {
  return typeof value === 'string' && (LANE_ORDER as readonly string[]).includes(value);
}

export function bridgeAction(raw: unknown): BridgeAction {
  if (typeof raw !== 'object' || raw === null) {
    return { refused: 'The overlay sent something that is not a message.' };
  }

  const message = raw as { type?: unknown; key?: unknown; lane?: unknown; watching?: unknown };

  if (message.type === 'refresh') {
    return { send: { type: 'refresh' } };
  }

  // The overlay's own sidebar. It reads the hub's log and sends nothing but whether it is open, so it widens
  // nothing the snapshot has not already carried — with the one exception `redactForBrowser` takes back out.
  if (message.type === 'watchLog') {
    return { send: { type: 'watchLog', watching: message.watching === true } };
  }

  if (message.type === 'watching') {
    return { send: { type: 'watching', watching: message.watching === true } };
  }

  if (message.type === 'move') {
    return typeof message.key === 'string' && isLane(message.lane)
      ? { send: { type: 'move', key: message.key, lane: message.lane } }
      : { refused: 'That card cannot be moved there.' };
  }

  if (message.type === 'open') {
    return { refused: 'The browser board goes to a session by opening its link, not by asking the hub.' };
  }

  // Refused by name rather than by the catch-all below, because this is the one message that would have a web page
  // start an agent in the developer's checkout. The overlay shows what a run came to and offers no control (R39).
  if (message.type === 'runAction' || message.type === 'stopAction') {
    return { refused: 'Starting and stopping work on a card is the editor board’s, not the browser’s.' };
  }

  return { refused: `The overlay may not send ${String(message.type)}.` };
}

/**
 * The one thing in `hub.log` a browser may not have. The hub records the `Origin` of every web page that reached
 * the loopback port and was refused, which is a slice of the developer's own browsing — and the overlay paints
 * into a page on github.com, whose own scripts can read what the sidebar writes. Everything else in that file the
 * snapshot already carries. The refusal itself stays, because a page probing the port is the thing worth seeing;
 * which page it was is not the browser's to be told.
 */
export function redactForBrowser(message: BridgeMessage): BridgeMessage {
  if (message.type !== 'log') {
    return message;
  }

  return {
    ...message,
    entries: message.entries.map((entry) =>
      ORIGIN.test(entry.message)
        ? { ...entry, message: entry.message.replace(ORIGIN, 'an Origin header (hidden)') }
        : entry,
    ),
  };
}

const ORIGIN = /an Origin header, .*$/;

/** The bridge as a client: no host, so no route is ever forwarded to it, and no resident half to perform one. */
export function bridgeHello(id: string, watching: boolean): ClientHello {
  return { id, hostId: null, workspaceRoot: null, residentRoutes: [], watching };
}

export interface BridgeStreams {
  onData(handler: (chunk: Buffer) => void): void;
  onEnd(handler: () => void): void;
  write(frame: Buffer): void;
}

export interface BridgeDeps {
  streams: BridgeStreams;
  send(message: ClientMessage): void;
  /** Torn down when Chrome closes the port: the bridge is Chrome's process and has nothing to do without it. */
  stop(): void;
}

/**
 * Relays one Chrome port. Chrome starts this process when the overlay connects and closes stdin when the last board
 * tab goes, which is what ends it — the hub it was talking to stays up for its own idle rule to end (R35).
 */
export function runBridge(deps: BridgeDeps): (message: BridgeMessage) => void {
  const reader = new FrameReader();

  const toChrome = (message: BridgeMessage): void => {
    try {
      deps.streams.write(encodeFrame(redactForBrowser(message)));
    } catch {
      // A frame Chrome will not take is one message lost. The next snapshot carries the same state.
    }
  };

  deps.streams.onData((chunk) => {
    for (const raw of reader.push(chunk)) {
      const action = bridgeAction(raw);

      if ('refused' in action) {
        toChrome({ type: 'notice', level: 'warning', message: action.refused });

        continue;
      }

      deps.send(action.send);
    }
  });

  deps.streams.onEnd(() => deps.stop());

  return toChrome;
}
