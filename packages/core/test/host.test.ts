import { describe, expect, it } from 'vitest';
import { routeKey } from '../src/host.js';
import type { OpenRoute } from '../src/host.js';
import type { Session } from '../src/types.js';

const session = { agent: 'claude', sessionId: 'a1b2c3d4-0000-4000-8000-000000000000' } as Session;

/** Deduplicate session routes by session ID and checkout/start routes by card and operation (R18). */
describe('what a route is held by while it is being performed', () => {
  it('is the session, for every route that reaches one', () => {
    const routes: OpenRoute[] = [
      { route: 'reveal-here', session, root: 'd:/work/repo' },
      { route: 'reveal-elsewhere', session, root: 'd:/work/repo' },
      { route: 'sidebar-here', session, root: 'd:/work/repo' },
      { route: 'unknown-surface-elsewhere', session, root: 'd:/work/repo' },
    ];

    for (const route of routes) {
      expect(routeKey(route)).toBe(session.sessionId);
    }
  });

  it('carries the card, for the routes that name no session', () => {
    expect(routeKey({ route: 'open-checkout', key: 'issue:19002', root: 'd:/work/repo', newWindow: true })).toContain('issue:19002');
    expect(routeKey({ route: 'start-session', key: 'issue:19002', agent: 'claude', root: 'd:/work/repo', prompt: null })).toContain('issue:19002');
  });

  it('tells two cards apart, so one being opened does not drop the other’s click', () => {
    const one: OpenRoute = { route: 'open-checkout', key: 'issue:1', root: 'd:/one', newWindow: false };
    const two: OpenRoute = { route: 'open-checkout', key: 'issue:2', root: 'd:/two', newWindow: false };

    expect(routeKey(one)).not.toBe(routeKey(two));
  });

  // Opening a checkout must not suppress a distinct start-session request while focus is pending.
  it('deduplicates checkout and start routes separately', () => {
    const open: OpenRoute = { route: 'open-checkout', key: 'issue:1', root: 'd:/one', newWindow: false };
    const start: OpenRoute = { route: 'start-session', key: 'issue:1', agent: 'claude', root: 'd:/one', prompt: null };

    expect(routeKey(open)).not.toBe(routeKey(start));
  });

  it('tells one card’s two agents apart, since neither start is the other', () => {
    const claude: OpenRoute = { route: 'start-session', key: 'issue:1', agent: 'claude', root: 'd:/one', prompt: null };
    const codex: OpenRoute = { route: 'start-session', key: 'issue:1', agent: 'codex', root: 'd:/one', prompt: null };

    expect(routeKey(claude)).not.toBe(routeKey(codex));
  });
});
