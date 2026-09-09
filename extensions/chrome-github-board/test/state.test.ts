import { describe, expect, it } from 'vitest';
import type { Snapshot } from '@ground-control/core';
import {
  LOG_LIMIT,
  applyMessage,
  disconnection,
  initialState,
  isBoardPath,
  makeLogSpool,
  retryDelay,
} from '../src/state.js';

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

describe('which pages the overlay paints', () => {
  it('matches organization and user project boards', () => {
    expect(isBoardPath('/orgs/example-org/projects/3')).toBe(true);
    expect(isBoardPath('/orgs/example-org/projects/3/views/1')).toBe(true);
    expect(isBoardPath('/users/dev-1/projects/7')).toBe(true);
  });

  /**
   * Check board paths after soft navigation because Chrome does not reinject content scripts; leave non-board
   * pages unchanged.
   */
  it('is nothing else on the site', () => {
    expect(isBoardPath('/example-org/example-repo/issues/4501')).toBe(false);
    expect(isBoardPath('/example-org/example-repo/pull/12')).toBe(false);
    expect(isBoardPath('/orgs/example-org/repositories')).toBe(false);
    expect(isBoardPath('/orgs/example-org/projects')).toBe(false);
    expect(isBoardPath('/')).toBe(false);
    expect(isBoardPath('/notifications')).toBe(false);
  });
});

describe('what a message from the worker changes', () => {
  it('starts out saying nothing has answered', () => {
    expect(initialState()).toEqual({ snapshot: null, trouble: 'Waiting for the Ground Control hub.', notice: null });
  });

  it('takes a snapshot, and takes a change the same way', () => {
    expect(applyMessage(initialState(), { type: 'snapshot', snapshot: SNAPSHOT }).snapshot).toBe(SNAPSHOT);
    expect(applyMessage(initialState(), { type: 'changed', snapshot: SNAPSHOT }).snapshot).toBe(SNAPSHOT);
  });

  /** Cached snapshots do not establish liveness; only the worker can clear connection trouble (R24). */
  it('leaves the trouble line to the worker rather than clearing it on a snapshot', () => {
    const troubled = applyMessage(initialState(), { type: 'trouble', message: 'Disconnected from Ground Control.' });
    const after = applyMessage(troubled, { type: 'snapshot', snapshot: SNAPSHOT });

    expect(after.trouble).toBe('Disconnected from Ground Control.');
    expect(after.snapshot).toBe(SNAPSHOT);
  });

  it('clears the trouble line when the worker says the hub answered', () => {
    const troubled = applyMessage(initialState(), { type: 'trouble', message: 'Disconnected from Ground Control.' });

    expect(applyMessage(troubled, { type: 'trouble', message: null }).trouble).toBeNull();
  });

  /** The bridge refuses what the browser may not ask for, and a refusal nobody keeps is a click that did nothing. */
  it('keeps the last notice until another arrives', () => {
    const refused = applyMessage(initialState(), { type: 'notice', message: 'Taking a session over happens here.' });

    expect(refused.notice).toBe('Taking a session over happens here.');
    expect(applyMessage(refused, { type: 'snapshot', snapshot: SNAPSHOT }).notice).toBe(
      'Taking a session over happens here.',
    );
    expect(applyMessage(refused, { type: 'notice', message: 'Something else.' }).notice).toBe('Something else.');
  });

  it('ignores a message it does not know, rather than blanking what it holds', () => {
    const held = applyMessage(initialState(), { type: 'snapshot', snapshot: SNAPSHOT });

    expect(applyMessage(held, { type: 'perform' })).toBe(held);
  });
});

describe('trying the worker again', () => {
  it('doubles from a second and stops at half a minute', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(retryDelay)).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
  });

  it('tries again when the worker is what went away', () => {
    expect(disconnection({ id: 'kmhcihpebfmpgmihbkipmjlmmioameka' })).toEqual({
      retry: true,
      trouble: 'The overlay lost its connection to Ground Control.',
    });
  });

  /** An invalidated extension context requires a page reload; retrying the old content script cannot reconnect. */
  it('gives up and asks for a tab reload when the extension is what went away', () => {
    expect(disconnection({})).toEqual({
      retry: false,
      trouble: 'Ground Control was reloaded. Reload this tab to restore the overlay.',
    });
    expect(disconnection(undefined).retry).toBe(false);
  });
});

/** The browser client's half of R40: what decides whether the hub's log is read at all. */
describe('the log spool', () => {
  const line = (source: 'browser' | 'hub', message: string) => ({
    at: '2026-09-06T12:00:00.000Z',
    level: 'info',
    source,
    message,
  });

  it('asks the hub only when the first sidebar opens, and never again while one is open', () => {
    const spool = makeLogSpool();
    const a = {};
    const b = {};

    expect(spool.watching()).toBe(false);
    expect(spool.view(a, true).tell).toBe(true);
    // The second tab is not a second subscription: telling the hub again would have it backfill over the first.
    expect(spool.view(b, true).tell).toBeNull();
    expect(spool.view(a, true).tell).toBeNull();
    expect(spool.watching()).toBe(true);
  });

  it('unsubscribes when the last sidebar closes', () => {
    const spool = makeLogSpool();
    const a = {};
    const b = {};

    spool.view(a, true);
    spool.view(b, true);

    expect(spool.view(a, false).tell).toBeNull();
    expect(spool.watching()).toBe(true);
    expect(spool.view(b, false).tell).toBe(false);
    expect(spool.watching()).toBe(false);
    // Closing one that was never open changes nothing, which is what a disconnect of a tab with no sidebar is.
    expect(spool.view(a, false).tell).toBeNull();
  });

  it('keeps the browser half after the last sidebar closes, and drops the hub half', () => {
    const spool = makeLogSpool();
    const a = {};

    spool.view(a, true);
    spool.hold([line('browser', 'the port opened'), line('hub', 'listening on 127.0.0.1:5001')]);

    expect(spool.held().map((entry) => entry.source)).toEqual(['browser', 'hub']);

    spool.view(a, false);

    // Clear hub history before reopening to avoid duplicate backfill; retain browser logs because they have
    // no durable copy.
    expect(spool.held().map((entry) => entry.message)).toEqual(['the port opened']);
  });

  it('hands a newly opened sidebar what it missed, and does not count it as watching until it has', () => {
    const spool = makeLogSpool();
    const a = {};
    const b = {};

    spool.hold([line('browser', 'before anyone looked')]);

    expect(spool.view(a, true).backlog.map((entry) => entry.message)).toEqual(['before anyone looked']);

    spool.hold([line('hub', 'a card moved')]);

    // What the second tab gets is the spool's whole run, not just what arrived after it asked.
    expect(spool.view(b, true).backlog.map((entry) => entry.message)).toEqual(['before anyone looked', 'a card moved']);
    // And a tab already watching is handed nothing: it has been receiving them live.
    expect(spool.view(a, true).backlog).toEqual([]);
  });

  it('holds the newest lines and drops the oldest, so a board left open all day does not grow without bound', () => {
    const spool = makeLogSpool(3);

    spool.hold([line('browser', '1'), line('browser', '2')]);
    spool.hold([line('browser', '3'), line('browser', '4')]);

    expect(spool.held().map((entry) => entry.message)).toEqual(['2', '3', '4']);
  });

  it('retains the full hub backlog alongside browser logs', () => {
    expect(LOG_LIMIT).toBeGreaterThan(1024);
  });
});

/** Two files hold this number, so the pair is pinned: the smaller one silently drops the other's oldest lines. */
it('caps the sidebar and the spool at the same number of lines', async () => {
  const drawing = (await import('../src/overlay.js')) as { LOG_LIMIT: number };

  expect(drawing.LOG_LIMIT).toBe(LOG_LIMIT);
});
