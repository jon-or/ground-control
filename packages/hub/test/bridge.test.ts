import { describe, expect, it, vi } from 'vitest';
import type { ClientMessage, Snapshot } from '@ground-control/core';
import { FRAME_LIMIT_BYTES, FrameReader, bridgeAction, bridgeHello, encodeFrame, runBridge } from '../src/bridge.js';
import type { BridgeMessage, BridgeStreams } from '../src/bridge.js';

function frames(reader: FrameReader, ...chunks: Buffer[]): unknown[] {
  return chunks.flatMap((chunk) => reader.push(chunk));
}

const SNAPSHOT: Snapshot = {
  lanes: [],
  issues: null,
  sessions: null,
  openable: [],
  hooks: null,
  failures: [],
  stale: false,
  needs: null,
  fetchedAt: '2026-09-04T12:00:00Z',
};

describe('Chrome native-messaging frames', () => {
  it('writes a length in front of the JSON, which is what Chrome reads', () => {
    const frame = encodeFrame({ type: 'refresh' });
    const body = JSON.stringify({ type: 'refresh' });

    expect(frame.readUInt32LE(0)).toBe(Buffer.byteLength(body));
    expect(frame.subarray(4).toString('utf8')).toBe(body);
  });

  it('refuses to send more than Chrome will take', () => {
    expect(() => encodeFrame({ padding: 'x'.repeat(FRAME_LIMIT_BYTES) })).toThrow(/larger than Chrome will accept/);
  });

  it('reads a frame that arrived across several chunks', () => {
    const frame = encodeFrame({ type: 'refresh' });
    const reader = new FrameReader();

    expect(frames(reader, frame.subarray(0, 2))).toEqual([]);
    expect(frames(reader, frame.subarray(2, 6))).toEqual([]);
    expect(frames(reader, frame.subarray(6))).toEqual([{ type: 'refresh' }]);
  });

  it('reads several frames that arrived in one chunk', () => {
    const reader = new FrameReader();
    const both = Buffer.concat([encodeFrame({ type: 'refresh' }), encodeFrame({ type: 'watching', watching: true })]);

    expect(frames(reader, both)).toEqual([{ type: 'refresh' }, { type: 'watching', watching: true }]);
  });

  it('drops a frame that is not JSON and reads the next one', () => {
    const reader = new FrameReader();
    const bad = Buffer.alloc(4 + 3);

    bad.writeUInt32LE(3, 0);
    bad.write('not', 4);

    expect(frames(reader, Buffer.concat([bad, encodeFrame({ type: 'refresh' })]))).toEqual([{ type: 'refresh' }]);
  });

  /** A header this large is a stream out of step with its frames; reading on waits forever for a body that is not coming. */
  it('gives up on a header claiming more than any frame carries', () => {
    const reader = new FrameReader();
    const absurd = Buffer.alloc(4);

    absurd.writeUInt32LE(FRAME_LIMIT_BYTES + 1, 0);

    expect(frames(reader, absurd, encodeFrame({ type: 'refresh' }))).toEqual([{ type: 'refresh' }]);
  });
});

describe('what the browser may ask the hub for', () => {
  it('passes a refresh and a watch through', () => {
    expect(bridgeAction({ type: 'refresh' })).toEqual({ send: { type: 'refresh' } });
    expect(bridgeAction({ type: 'watching', watching: true })).toEqual({ send: { type: 'watching', watching: true } });
    expect(bridgeAction({ type: 'watching' })).toEqual({ send: { type: 'watching', watching: false } });
  });

  it('passes a move to a lane the board has', () => {
    expect(bridgeAction({ type: 'move', key: 'issue-4501', lane: 'review' })).toEqual({
      send: { type: 'move', key: 'issue-4501', lane: 'review' },
    });
  });

  it('refuses a move to a lane the board does not have', () => {
    expect(bridgeAction({ type: 'move', key: 'issue-4501', lane: 'nowhere' })).toEqual({
      refused: 'That card cannot be moved there.',
    });
    expect(bridgeAction({ type: 'move', key: 4501, lane: 'review' })).toEqual({
      refused: 'That card cannot be moved there.',
    });
  });

  /** Taking a session over needs the editor (R14, R36), and a configuration carries paths the hub would spawn. */
  it('refuses to open a session, and says where that happens instead', () => {
    expect(bridgeAction({ type: 'open', sessionId: 'a-session' })).toEqual({
      refused: 'Taking a session over happens in the editor. Open the board in VS Code.',
    });
  });

  it('refuses everything else by name', () => {
    expect(bridgeAction({ type: 'configure', config: {} })).toEqual({ refused: 'The overlay may not send configure.' });
    expect(bridgeAction({ type: 'hello' })).toEqual({ refused: 'The overlay may not send hello.' });
    expect(bridgeAction('refresh')).toEqual({ refused: 'The overlay sent something that is not a message.' });
    expect(bridgeAction(null)).toEqual({ refused: 'The overlay sent something that is not a message.' });
  });

  it('connects as a client that is resident in nothing, so no route is ever forwarded to it', () => {
    expect(bridgeHello('chrome-1', true)).toEqual({
      id: 'chrome-1',
      hostId: null,
      workspaceRoot: null,
      residentRoutes: [],
      watching: true,
    });
  });
});

describe('relaying one Chrome port', () => {
  function harness() {
    let onData = (_chunk: Buffer): void => {};
    let onEnd = (): void => {};

    const written: unknown[] = [];
    const sent: ClientMessage[] = [];
    const stop = vi.fn();

    const streams: BridgeStreams = {
      onData: (handler) => {
        onData = handler;
      },
      onEnd: (handler) => {
        onEnd = handler;
      },
      write: (frame) => {
        written.push(JSON.parse(frame.subarray(4).toString('utf8')));
      },
    };

    const toChrome = runBridge({ streams, send: (message) => sent.push(message), stop });

    return {
      written,
      sent,
      stop,
      toChrome,
      fromChrome: (message: unknown) => onData(encodeFrame(message)),
      close: () => onEnd(),
    };
  }

  it('sends what the browser asked for on to the hub', () => {
    const h = harness();

    h.fromChrome({ type: 'move', key: 'issue-4501', lane: 'done' });

    expect(h.sent).toEqual([{ type: 'move', key: 'issue-4501', lane: 'done' }]);
    expect(h.written).toEqual([]);
  });

  it('tells the browser what it refused rather than dropping it', () => {
    const h = harness();

    h.fromChrome({ type: 'open', sessionId: 'a-session' });

    expect(h.sent).toEqual([]);
    expect(h.written).toEqual([
      {
        type: 'notice',
        level: 'warning',
        message: 'Taking a session over happens in the editor. Open the board in VS Code.',
      },
    ]);
  });

  /**
   * A tab that comes back is sent a snapshot by the hub itself, on the `watching` it just received. Asking for one
   * here as well put two on the wire over different sockets, in no order, and the overlay painted whichever landed
   * last — which could be the older of the two.
   */
  it('relays a watch and asks for nothing else', async () => {
    const h = harness();

    h.fromChrome({ type: 'watching', watching: true });
    await new Promise((done) => setTimeout(done, 10));

    expect(h.sent).toEqual([{ type: 'watching', watching: true }]);
    expect(h.written).toEqual([]);
  });

  it('frames what the hub says on its way to the browser', () => {
    const h = harness();
    const message: BridgeMessage = { type: 'changed', snapshot: SNAPSHOT };

    h.toChrome(message);

    expect(h.written).toEqual([message]);
  });

  /** Chrome closes stdin when the last board tab goes. The bridge is Chrome's process; it has nothing left to do. */
  it('stops when Chrome closes the port', () => {
    const h = harness();

    h.close();

    expect(h.stop).toHaveBeenCalledTimes(1);
  });
});
