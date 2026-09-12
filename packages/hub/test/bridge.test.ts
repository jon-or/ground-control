import { describe, expect, it, vi } from 'vitest';
import type { ClientMessage, LogEntry, Snapshot } from '@ground-control/core';
import { FRAME_LIMIT_BYTES, FrameReader, bridgeAction, bridgeHello, encodeFrame, redactForBrowser, runBridge } from '../src/bridge.js';
import type { BridgeMessage, BridgeStreams } from '../src/bridge.js';

function frames(reader: FrameReader, ...chunks: Buffer[]): unknown[] {
  return chunks.flatMap((chunk) => reader.push(chunk));
}

const SNAPSHOT: Snapshot = {
  lanes: [],
  issues: null,
  sessions: null,
  openable: [],
  startable: [],
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

  /** Reject oversized frames instead of waiting indefinitely for their bodies. */
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

  /** Chrome opens sessions through editor URLs (R36). */
  it('refuses session opening and provides browser instructions', () => {
    expect(bridgeAction({ type: 'open', sessionId: 'a-session' })).toEqual({
      refused: 'Open sessions through their links in the overlay.',
    });
  });

  /**
   * Actions.runAction and stopAction apply every R39 safety check and limit; the hub additionally requires
   * actions.fromBrowser, a watching client, a daily allowance, and an enabled action before starting one.
   */
  it('forwards a card action, rebuilding the message so only the card key survives', () => {
    expect(
      bridgeAction({
        type: 'runAction',
        key: 'issue:17198',
        root: 'd:/anything',
        prompt: 'do something else',
        permissionMode: 'bypassPermissions',
      }),
    ).toEqual({ send: { type: 'runAction', key: 'issue:17198' } });
    expect(bridgeAction({ type: 'stopAction', key: 'issue:17198', root: 'd:/anything' })).toEqual({
      send: { type: 'stopAction', key: 'issue:17198' },
    });
  });

  it('refuses a card action that does not name a card, rather than forwarding it', () => {
    const refused = { refused: 'That card action cannot be run.' };

    expect(bridgeAction({ type: 'runAction', key: 42 })).toEqual(refused);
    expect(bridgeAction({ type: 'stopAction' })).toEqual(refused);
  });

  /** Forward only the card key; the hub resolves its checkout path (R41). */
  it('forwards a request to open a card’s checkout, dropping any path the page attached', () => {
    expect(bridgeAction({ type: 'openCheckout', key: 'issue:17198', root: 'd:/anything' })).toEqual({
      send: { type: 'openCheckout', key: 'issue:17198' },
    });
  });

  /**
   * Reading spends the developer's model allowance, so the page may ask but the hub decides: Triage.retriage
   * applies the same eligibility, concurrency, and cooldown checks it applies to an editor request (R38).
   */
  it('forwards a classification request, carrying the card key and nothing else', () => {
    expect(bridgeAction({ type: 'retriage', key: 'issue:17198' })).toEqual({
      send: { type: 'retriage', key: 'issue:17198' },
    });
  });

  it('refuses a retriage that does not name a card, rather than forwarding it', () => {
    expect(bridgeAction({ type: 'retriage', key: 42 })).toEqual({ refused: 'That card cannot be read.' });
    expect(bridgeAction({ type: 'retriage' })).toEqual({ refused: 'That card cannot be read.' });
  });

  it('refuses an openCheckout that does not name a card, rather than forwarding it', () => {
    expect(bridgeAction({ type: 'openCheckout', key: 42 })).toEqual({ refused: 'That card cannot be opened.' });
    expect(bridgeAction({ type: 'openCheckout' })).toEqual({ refused: 'That card cannot be opened.' });
  });

  /** A worktree run is a dispatch; the hub applies the browser opt-in and the limits it applies to runAction (R46). */
  it('forwards a request to make a card’s worktree, carrying the card key and nothing else', () => {
    expect(bridgeAction({ type: 'createWorktree', key: 'issue:17198', prompt: 'ignored' })).toEqual({
      send: { type: 'createWorktree', key: 'issue:17198' },
    });
  });

  it('refuses a createWorktree that does not name a card, rather than forwarding it', () => {
    expect(bridgeAction({ type: 'createWorktree', key: 42 })).toEqual({ refused: 'That card cannot have a worktree created for it.' });
    expect(bridgeAction({ type: 'createWorktree' })).toEqual({ refused: 'That card cannot have a worktree created for it.' });
  });

  // Reject page-supplied paths by message name (R36, R41).
  it('refuses to choose a card’s folder, which is the one message that would carry a path', () => {
    expect(bridgeAction({ type: 'setCheckout', key: 'issue:17198', root: 'd:/anything' })).toEqual({
      refused: 'Choose card checkouts in VS Code.',
    });
  });

  /** The page names a card and an agent; the hub resolves the checkout, the prompt, and the window (R42). */
  it('forwards a session start, dropping the readiness and root a page cannot know', () => {
    expect(
      bridgeAction({
        type: 'startSession',
        key: 'issue:17198',
        agent: 'claude',
        extensionReady: true,
        root: 'd:/anything',
        prompt: 'do something else',
      }),
    ).toEqual({ send: { type: 'startSession', key: 'issue:17198', agent: 'claude' } });
  });

  it('refuses a start that does not name both a card and an agent', () => {
    const refused = { refused: 'That session cannot be started.' };

    expect(bridgeAction({ type: 'startSession', key: 'issue:17198' })).toEqual(refused);
    expect(bridgeAction({ type: 'startSession', agent: 'claude' })).toEqual(refused);
    expect(bridgeAction({ type: 'startSession', key: 'issue:17198', agent: 42 })).toEqual(refused);
  });

  /**
   * The agent name is the one page-supplied string that reaches a hub log line and an editor notice, so it
   * is held to the shape of a registry id rather than to being a string at all.
   */
  it('refuses an agent name no registry could hold', () => {
    const refused = { refused: 'That session cannot be started.' };
    const key = 'issue:17198';

    expect(bridgeAction({ type: 'startSession', key, agent: 'Claude' })).toEqual(refused);
    expect(bridgeAction({ type: 'startSession', key, agent: 'claude code' })).toEqual(refused);
    expect(bridgeAction({ type: 'startSession', key, agent: '../claude' })).toEqual(refused);
    expect(bridgeAction({ type: 'startSession', key, agent: 'claude\nstarting a fake session' })).toEqual(refused);
    expect(bridgeAction({ type: 'startSession', key, agent: 'a'.repeat(33) })).toEqual(refused);
    expect(bridgeAction({ type: 'startSession', key, agent: '' })).toEqual(refused);
  });

  it('refuses to read a conversation, because the overlay runs on the page that already shows it (R36, R43)', () => {
    expect(bridgeAction({ type: 'readDetail', key: 'issue:17198', subject: 'issue' })).toEqual({
      refused: 'Read issues and pull requests on GitHub itself.',
    });
  });

  it('forwards a custody read with only the card key, because the page cannot fold the timeline itself', () => {
    expect(bridgeAction({ type: 'readCustody', key: 'issue:17198' })).toEqual({ send: { type: 'readCustody', key: 'issue:17198' } });
    expect(bridgeAction({ type: 'readCustody' })).toEqual({ refused: 'That card cannot be read.' });
  });

  it('refuses everything else by name', () => {
    expect(bridgeAction({ type: 'configure', config: {} })).toEqual({ refused: 'The overlay may not send configure.' });
    expect(bridgeAction({ type: 'hello' })).toEqual({ refused: 'The overlay may not send hello.' });
    expect(bridgeAction('refresh')).toEqual({ refused: 'Invalid overlay message.' });
    expect(bridgeAction(null)).toEqual({ refused: 'Invalid overlay message.' });
  });

  it('connects without resident route capabilities', () => {
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

    h.fromChrome({ type: 'move', key: 'issue-4501', lane: 'icebox' });

    expect(h.sent).toEqual([{ type: 'move', key: 'issue-4501', lane: 'icebox' }]);
    expect(h.written).toEqual([]);
  });

  it('reports refused browser messages', () => {
    const h = harness();

    h.fromChrome({ type: 'open', sessionId: 'a-session' });

    expect(h.sent).toEqual([]);
    expect(h.written).toEqual([
      {
        type: 'notice',
        level: 'warning',
        message: 'Open sessions through their links in the overlay.',
      },
    ]);
  });

  /** The hub sends a snapshot on watching. A second request could arrive out of order and display stale data. */
  it('forwards watching without an extra snapshot request', async () => {
    const h = harness();

    h.fromChrome({ type: 'watching', watching: true });
    await new Promise((done) => setTimeout(done, 10));

    expect(h.sent).toEqual([{ type: 'watching', watching: true }]);
    expect(h.written).toEqual([]);
  });

  it('encodes hub messages for the browser', () => {
    const h = harness();
    const message: BridgeMessage = { type: 'changed', snapshot: SNAPSHOT };

    h.toChrome(message);

    expect(h.written).toEqual([message]);
  });

  /** Exit the bridge when Chrome closes stdin after the last board tab closes. */
  it('stops when Chrome closes the port', () => {
    const h = harness();

    h.close();

    expect(h.stop).toHaveBeenCalledTimes(1);
  });
});

describe('what the overlay may ask about the log, and what it is told back', () => {
  const AT = '2026-09-06T19:01:24.114Z';

  function entry(message: string): LogEntry {
    return { at: AT, level: 'warn', source: 'hub', scope: 'server', message };
  }

  it('lets the overlay say its sidebar is open, and say it is closed again', () => {
    expect(bridgeAction({ type: 'watchLog', watching: true })).toEqual({ send: { type: 'watchLog', watching: true } });
    expect(bridgeAction({ type: 'watchLog', watching: false })).toEqual({ send: { type: 'watchLog', watching: false } });
  });

  it('reads anything but a true watching as closed, rather than refusing the message', () => {
    expect(bridgeAction({ type: 'watchLog', watching: 'yes' })).toEqual({ send: { type: 'watchLog', watching: false } });
  });

  // Redact refused Origins because GitHub page scripts can read the overlay DOM.
  it('takes the page out of a refused-request line before the browser sees it', () => {
    const redacted = redactForBrowser({
      type: 'log',
      entries: [entry('refused GET /snapshot: an Origin header, https://somesite.example')],
    });

    expect(redacted).toEqual({
      type: 'log',
      entries: [entry('refused GET /snapshot: an Origin header (hidden)')],
    });
  });

  it('keeps the refusal itself, because a page probing the port is the thing worth seeing', () => {
    const redacted = redactForBrowser({ type: 'log', entries: [entry('refused GET /hub: an Origin header, https://a.example')] });

    expect(redacted.type === 'log' && redacted.entries[0]!.message).toContain('refused GET /hub');
  });

  it('leaves every other line of the log alone', () => {
    const lines = [entry('a Host of evil.example, not 127.0.0.1:51844'), entry('github read 14 cards in 812ms')];
    const redacted = redactForBrowser({ type: 'log', entries: lines });

    expect(redacted).toEqual({ type: 'log', entries: lines });
  });

  it('leaves a message that is not the log alone', () => {
    const notice = { type: 'notice', level: 'warning', message: 'an Origin header, https://a.example' } as const;

    expect(redactForBrowser(notice)).toEqual(notice);
  });
});
