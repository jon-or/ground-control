import { describe, expect, it } from 'vitest';
import type { Snapshot } from '@ground-control/core';
import { applyMessage, initialState, isBoardPath, retryDelay } from '../src/state.js';

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

describe('which pages the overlay paints', () => {
  it('is a project board, whoever owns it', () => {
    expect(isBoardPath('/orgs/example-org/projects/3')).toBe(true);
    expect(isBoardPath('/orgs/example-org/projects/3/views/1')).toBe(true);
    expect(isBoardPath('/users/dev-1/projects/7')).toBe(true);
  });

  /**
   * The content script is injected across github.com, because reaching a board by clicking through the site is a
   * soft navigation and Chrome injects nothing for one. Every other page on it must be left alone.
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
    expect(initialState()).toEqual({ snapshot: null, trouble: 'Ground Control has not answered yet.', notice: null });
  });

  it('takes a snapshot, and takes a change the same way', () => {
    expect(applyMessage(initialState(), { type: 'snapshot', snapshot: SNAPSHOT }).snapshot).toBe(SNAPSHOT);
    expect(applyMessage(initialState(), { type: 'changed', snapshot: SNAPSHOT }).snapshot).toBe(SNAPSHOT);
  });

  /**
   * A snapshot handed to a tab may be a replay from `chrome.storage.session` — a real reading, and an old one. A
   * tab that cleared the line on receiving one would show hours-old badges under a banner saying all was well (R24).
   */
  it('leaves the trouble line to the worker rather than clearing it on a snapshot', () => {
    const troubled = applyMessage(initialState(), { type: 'trouble', message: 'Ground Control is not running.' });
    const after = applyMessage(troubled, { type: 'snapshot', snapshot: SNAPSHOT });

    expect(after.trouble).toBe('Ground Control is not running.');
    expect(after.snapshot).toBe(SNAPSHOT);
  });

  it('clears the trouble line when the worker says the hub answered', () => {
    const troubled = applyMessage(initialState(), { type: 'trouble', message: 'Ground Control is not running.' });

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
});
