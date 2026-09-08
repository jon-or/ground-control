import { describe, expect, it } from 'vitest';
import { routeKey } from '../src/host.js';
import type { OpenRoute } from '../src/host.js';
import type { Session } from '../src/types.js';

const session = { agent: 'claude', sessionId: 'a1b2c3d4-0000-4000-8000-000000000000' } as Session;

/**
 * What holds a route in flight, so a second click on the same thing is dropped (R18). A route is held by its
 * session where it has one and by its card where it does not, and reading the wrong field would leave the two
 * routes that spawn something with no guard at all.
 */
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

  it('is the card, for the route that opens a checkout and names no session', () => {
    expect(routeKey({ route: 'open-checkout', key: 'issue:19002', root: 'd:/work/repo', newWindow: true })).toBe('issue:19002');
  });

  it('tells two cards apart, so one being opened does not drop the other’s click', () => {
    const one: OpenRoute = { route: 'open-checkout', key: 'issue:1', root: 'd:/one', newWindow: false };
    const two: OpenRoute = { route: 'open-checkout', key: 'issue:2', root: 'd:/two', newWindow: false };

    expect(routeKey(one)).not.toBe(routeKey(two));
  });
});
