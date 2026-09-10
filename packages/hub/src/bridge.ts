import { LANE_ORDER } from '@ground-control/core';
import type { ClientHello, ClientMessage, HubMessage, LaneId } from '@ground-control/core';

/** Native messaging uses a four-byte length followed by UTF-8 JSON. Limit responses to Chrome's one-megabyte cap. */
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

/** Decode frames across arbitrary stdin chunks, including split headers and multiple frames per chunk. */
export class FrameReader {
  #buffered: Buffer = Buffer.alloc(0);

  /** Return completed frames; skip invalid JSON. */
  push(chunk: Buffer): unknown[] {
    this.#buffered = Buffer.concat([this.#buffered, chunk]);

    const messages: unknown[] = [];

    for (;;) {
      if (this.#buffered.length < 4) {
        return messages;
      }

      const length = this.#buffered.readUInt32LE(0);

      // Reject oversized headers instead of waiting indefinitely for the claimed body.
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
        // Skip invalid JSON without closing the port.
      }
    }
  }
}

/** Browser messages include relayed hub messages and local connection failures. */
export type BridgeMessage = HubMessage | { type: 'trouble'; message: string | null };

/**
 * Allow refresh, visibility, lane moves, log subscriptions, and checkout opening (R36). Session opening uses
 * editor URIs. Configuration, classification, path selection, and starting/stopping work remain editor-only.
 */
export type BridgeAction = { send: ClientMessage } | { refused: string };

function isLane(value: unknown): value is LaneId {
  return typeof value === 'string' && (LANE_ORDER as readonly string[]).includes(value);
}

export function bridgeAction(raw: unknown): BridgeAction {
  if (typeof raw !== 'object' || raw === null) {
    return { refused: 'Invalid overlay message.' };
  }

  const message = raw as { type?: unknown; key?: unknown; lane?: unknown; watching?: unknown };

  if (message.type === 'refresh') {
    return { send: { type: 'refresh' } };
  }

  // Explicit log subscription. redactForBrowser removes refused-request origins; other operational text remains.
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
    return { refused: 'Open sessions through their links in the overlay.' };
  }

  // The overlay does not control card actions (R39).
  if (message.type === 'runAction' || message.type === 'stopAction') {
    return { refused: 'Start or stop card actions in VS Code.' };
  }

  // Forward only the card key; the hub resolves the checkout path. Page-selected paths remain prohibited (R41).
  if (message.type === 'openCheckout') {
    return typeof message.key === 'string'
      ? { send: { type: 'openCheckout', key: message.key } }
      : { refused: 'That card cannot be opened.' };
  }

  // Explicitly reject path selection (R41) and agent starts (R42), which require an editor.
  if (message.type === 'setCheckout') {
    return { refused: 'Choose card checkouts in VS Code.' };
  }

  if (message.type === 'startSession') {
    return { refused: 'Start card sessions in VS Code.' };
  }

  // The overlay already runs on the page that renders these conversations (R36).
  if (message.type === 'readDetail') {
    return { refused: 'Read issues and pull requests on GitHub itself.' };
  }

  return { refused: `The overlay may not send ${String(message.type)}.` };
}

/**
 * Redact refused-request origins before displaying logs inside github.com. Page scripts can read the overlay
 * DOM. Other log text is preserved and may contain details beyond the snapshot; this is not general-purpose
 * log sanitization.
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

/** Register without a host or resident route capabilities. */
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
  /** Stop the bridge when Chrome closes its port. */
  stop(): void;
}

/** Relay one Chrome native port until stdin closes. The shared hub remains subject to its own idle timeout (R35). */
export function runBridge(deps: BridgeDeps): (message: BridgeMessage) => void {
  const reader = new FrameReader();

  const toChrome = (message: BridgeMessage): void => {
    try {
      deps.streams.write(encodeFrame(redactForBrowser(message)));
    } catch {
      // Skip unencodable frames; a later snapshot will contain current state.
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
