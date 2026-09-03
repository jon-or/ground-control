import { describe, expect, it } from 'vitest';
import type { MachineReaders, OpenRequest } from '@ground-control/core';
import { VSCODE_HOST_ID, makeVscodeHost } from '../src/adapter.js';
import { VSCODE_ROUTES } from '../src/open.js';
import { PLACEMENTS } from '../src/placements.js';
import { session } from './helpers.js';

const held = session();

function request(over: Partial<OpenRequest> = {}): OpenRequest {
  return {
    sessionId: held.sessionId,
    sessions: [held],
    surfaces: [{ agent: held.agent, sessionId: held.sessionId, root: held.cwd, surface: 'tab' }],
    window: null,
    liveRoots: [held.cwd],
    workspaceRoot: held.cwd,
    mayOpenWindow: true,
    extensionReady: true,
    now: held.startedAt + 1,
    ...over,
  };
}

describe('the vscode host adapter', () => {
  it('names itself by the id the hosts setting carries', () => {
    expect(makeVscodeHost().id).toBe(VSCODE_HOST_ID);
  });

  /**
   * The rule the split rests on: a route the hub can neither perform nor forward is a click that does nothing. Every
   * route this host can plan fires a URI or a command, and both follow focus, so all of them are the client's.
   */
  it('offers every route it can plan as one a resident client must perform', () => {
    const host = makeVscodeHost();
    const resident = new Set(host.residentRoutes);

    for (const route of VSCODE_ROUTES) {
      expect(resident.has(route), route).toBe(true);
    }
  });

  it('performs nothing itself and hands nothing back, rather than claiming to', () => {
    const host = makeVscodeHost();

    expect(host.open).toBeUndefined();
    expect(host.release).toBeUndefined();
  });

  it('plans the route the surface holding the session names', () => {
    const plan = makeVscodeHost().plan(request());

    expect('route' in plan && plan.route).toBe('reveal-here');
  });

  it('refuses a session whose agent this host has no placement for', () => {
    const codex = { ...held, agent: 'codex' };
    const plan = makeVscodeHost().plan(request({ sessions: [codex], surfaces: [] }));

    expect('refusal' in plan && plan.refusal).toBe('other-agent');
  });

  /** A placement table with no row for the session's agent, so the refusal is the table's and not one id's. */
  it('plans against the placements it was built with', () => {
    const empty = makeVscodeHost({});

    expect('refusal' in empty.plan(request()) && (empty.plan(request()) as { refusal: string }).refusal).toBe(
      'other-agent',
    );
    expect('route' in makeVscodeHost(PLACEMENTS).plan(request())).toBe(true);
  });
});

/**
 * The three that touch the machine are pass-throughs to the readers this package excludes from its floor by name.
 * What is worth proving is the wiring: that each reads under what `configure` accepted rather than under a default.
 */
describe('what it reads the machine for', () => {
  const nowhere = { userDir: '/nowhere/User' };

  const deps: MachineReaders = {
    readText: () => null,
    mtime: () => null,
    listDir: () => null,
    readTail: () => null,
    home: '/nowhere/home',
  };

  it('finds no surface under a user directory that holds no windows', async () => {
    const host = makeVscodeHost();
    host.configure(nowhere);

    expect(await host.surfaces(deps)).toEqual([]);
  });

  it('finds no window under a home no agent has announced itself in', async () => {
    expect(await makeVscodeHost().windows(held, deps)).toEqual({ live: [], holding: null });
  });

  it('warms its reads without being asked for anything', () => {
    const host = makeVscodeHost();
    host.configure(nowhere);

    expect(() => host.prime(deps)).not.toThrow();
  });
});

describe('its configuration', () => {
  it('starts at the defaults a board spanning worktrees needs, with nothing a browser can set in motion', () => {
    expect(makeVscodeHost().settings()).toEqual({ mayOpenWindow: true, allowBrowserOpen: false });
  });

  it('takes what the developer set', () => {
    const host = makeVscodeHost();

    expect(host.configure({ userDir: 'd:/portable/User', mayOpenWindow: false })).toBeNull();
    expect(host.settings()).toEqual({ userDir: 'd:/portable/User', mayOpenWindow: false, allowBrowserOpen: false });
  });

  it('reads an absent entry as the defaults rather than as a refusal', () => {
    const host = makeVscodeHost();

    expect(host.configure(undefined)).toBeNull();
    expect(host.settings().mayOpenWindow).toBe(true);
  });

  it.each([
    ['a value that is not an object', 'vscode'],
    ['a permission that is not a boolean', { mayOpenWindow: 'yes' }],
    ['an empty user directory, which would read the filesystem root', { userDir: '' }],
    ['a key it does not know, which is a typo the developer cannot otherwise see', { mayOpenWindows: true }],
  ])('refuses %s, naming the setting to fix', (_case, raw) => {
    const host = makeVscodeHost();
    const failure = host.configure(raw);

    expect(failure).toMatchObject({ subject: VSCODE_HOST_ID, kind: 'bad-config' });
    expect(failure?.remedy).toContain('groundControl.hosts');
  });

  it('keeps what it last accepted when a later value is refused', () => {
    const host = makeVscodeHost();

    host.configure({ mayOpenWindow: false });
    host.configure({ mayOpenWindow: 'yes' });

    expect(host.settings().mayOpenWindow).toBe(false);
  });
});
