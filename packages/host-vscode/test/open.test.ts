import { describe, expect, it } from 'vitest';
import type { OpenPlan, OpenRequest, Session, SessionSurface } from '@ground-control/core';
import { basename } from '@ground-control/core';
import { SETTLING_MS, openableSessions, planOpen, strayFrom, verifyOpen } from '../src/open.js';
import { PLACEMENTS } from '../src/placements.js';
import { session } from './helpers.js';

/** One session in this window's checkout, another sharing it, and one in a different checkout: what routing is for. */
const live = session();
const twin = session({ sessionId: 'a1b2c3d4-0000-4000-8000-000000000001', title: 'the twin' });
const away = session({
  sessionId: 'a1b2c3d4-0000-4000-8000-000000000002',
  title: 'the other one',
  cwd: 'd:/work/repo',
  branch: 'main',
  issueNumber: null,
});
const roster: Session[] = [live, twin, away];

function tabIn(session: Session, root: string): SessionSurface {
  return { agent: session.agent, sessionId: session.sessionId, root, surface: 'tab' };
}

function sidebarIn(session: Session, root: string): SessionSurface {
  return { agent: session.agent, sessionId: session.sessionId, root, surface: 'sidebar' };
}

/**
 * A request that would reveal a tab in this window, so each test changes exactly the one thing it is about. `now` is
 * well past the settling window, which makes a session missing from the surfaces unplaceable rather than merely new.
 */
function request(session: Session, over: Partial<OpenRequest> = {}): OpenRequest {
  return {
    sessionId: session.sessionId,
    sessions: [session],
    surfaces: [tabIn(session, session.cwd)],
    liveRoots: [session.cwd],
    window: null,
    workspaceRoot: session.cwd,
    mayOpenWindow: true,
    extensionReady: true,
    now: session.startedAt + SETTLING_MS + 1,
    ...over,
  };
}

const decide = (req: OpenRequest): OpenPlan => planOpen(req, PLACEMENTS);

function refusalOf(plan: OpenPlan): string | undefined {
  return 'refusal' in plan ? plan.refusal : undefined;
}

function routeOf(plan: OpenPlan): string | undefined {
  return 'route' in plan ? plan.route : undefined;
}

describe('planOpen refuses, by name', () => {
  it('refuses a session that is no longer on the board', () => {
    const plan = decide(request(live, { sessions: [], surfaces: [] }));

    expect(refusalOf(plan)).toBe('unknown-session');
  });

  it('refuses another agent, because the command belongs to the Claude extension', () => {
    const other = { ...live, agent: 'codex' };

    expect(refusalOf(decide(request(other, { sessions: [other] })))).toBe('other-agent');
  });

  it('refuses when the Claude extension is not there', () => {
    expect(refusalOf(decide(request(live, { extensionReady: false })))).toBe('no-extension');
  });

  it('refuses a session no window is showing, which is one started from a terminal', () => {
    const plan = decide(request(live, { surfaces: [] }));

    expect(refusalOf(plan)).toBe('no-surface');
    expect('refusal' in plan && plan.message).toContain(live.cwd);
  });

  it('says a session is still settling when it is too young for VS Code to have recorded it', () => {
    const plan = decide(request(live, { surfaces: [], now: live.startedAt + SETTLING_MS - 1 }));

    expect(refusalOf(plan)).toBe('settling');
  });

  it('refuses a surface recorded by a window that has since closed', () => {
    const plan = decide(
      request(live, { surfaces: [tabIn(live, away.cwd)], workspaceRoot: live.cwd, liveRoots: [live.cwd] }),
    );

    expect(refusalOf(plan)).toBe('window-closed');
  });

  it('falls back to the agent’s own name for a session the developer has not titled', () => {
    const unnamed = session({ title: null, details: { name: 'repo-37' } });
    const plan = decide(request(unnamed, { sessions: [unnamed], surfaces: [] }));

    expect('refusal' in plan && plan.message).toContain('repo-37');
  });

  it('falls back to the short id where the agent gave one, as a session row does', () => {
    const background = session({ title: null, details: { shortId: 'ab12cd' } });
    const plan = decide(request(background, { sessions: [background], surfaces: [] }));

    expect('refusal' in plan && plan.message).toContain('ab12cd');
  });

  it('falls back last to the directory, never to a session id no row would ever show', () => {
    const nameless = session({ title: null, details: {} });
    const plan = decide(request(nameless, { sessions: [nameless], surfaces: [] }));

    expect('refusal' in plan && plan.message).toContain(basename(nameless.cwd));
    expect('refusal' in plan && plan.message).not.toContain(nameless.sessionId.slice(0, 8));
  });

  it('refuses another window when it may not bring one forward, naming the directory', () => {
    const plan = decide(
      request(live, { surfaces: [tabIn(live, away.cwd)], liveRoots: [away.cwd], mayOpenWindow: false }),
    );

    expect(refusalOf(plan)).toBe('elsewhere-not-allowed');
    expect('refusal' in plan && plan.message).toContain(away.cwd);
  });

  /** The permission is about moving the developer's focus, so it has nothing to say about the window they are in. */
  it('still opens a session in this window when it may not bring another forward', () => {
    expect(routeOf(decide(request(live, { mayOpenWindow: false })))).toBe('reveal-here');
  });

  it('refuses a window with no folder open, which `code` has no argument for', () => {
    const plan = decide(request(live, { surfaces: [], window: { folders: [] }, liveRoots: [] }));

    expect(refusalOf(plan)).toBe('unnamed-window');
  });

  /**
   * `code` on one folder of a multi-root window opens a second window on that folder alone, which is where a fire
   * would then land — so with no record naming the workspace file, there is no path to the window at all.
   */
  it('refuses a multi-root window no record names, rather than aiming at one of its folders', () => {
    const plan = decide(
      request(live, { surfaces: [], window: { folders: [away.cwd, live.cwd] }, liveRoots: [] }),
    );

    expect(refusalOf(plan)).toBe('unnamed-window');
  });
});

describe('planOpen routes by the surface holding the session', () => {
  it('reveals a tab in this window', () => {
    expect(routeOf(decide(request(live)))).toBe('reveal-here');
  });

  it('reveals a tab in the window that has it', () => {
    const plan = decide(request(live, { surfaces: [tabIn(live, away.cwd)], liveRoots: [away.cwd] }));

    expect(routeOf(plan)).toBe('reveal-elsewhere');
    expect('root' in plan && plan.root).toBe(away.cwd);
  });

  /** The pair that must not collapse: one session, one window, and the surface alone decides what may be fired. */
  it('opens the sidebar rather than a tab for a session the sidebar holds, in this window', () => {
    expect(routeOf(decide(request(live, { surfaces: [sidebarIn(live, live.cwd)] })))).toBe('sidebar-here');
  });

  it('opens the sidebar rather than a tab for a session the sidebar holds, in another window', () => {
    const plan = decide(request(live, { surfaces: [sidebarIn(live, away.cwd)], liveRoots: [away.cwd] }));

    expect(routeOf(plan)).toBe('sidebar-elsewhere');
    expect('root' in plan && plan.root).toBe(away.cwd);
  });

  it('routes elsewhere when this window has no root at all, rather than refusing', () => {
    const plan = decide(request(live, { workspaceRoot: null, liveRoots: [live.cwd] }));

    expect(routeOf(plan)).toBe('reveal-elsewhere');
  });

  /** The board window's root is compared to the recorded one as given, so a multi-root window must report its file. */
  it('reveals here when this window is a multi-root one, which is named by its workspace file', () => {
    const root = 'd:/git/team.code-workspace';
    const plan = decide(request(live, { surfaces: [tabIn(live, root)], workspaceRoot: root, liveRoots: [] }));

    expect(routeOf(plan)).toBe('reveal-here');
  });

  /** A multi-root window announces its folders and never its workspace file, so roots alone would never match it. */
  it('believes the window join over a root no lock file could ever name', () => {
    const root = 'd:/git/tier3.code-workspace';
    const plan = decide(
      request(live, {
        surfaces: [tabIn(live, root)],
        liveRoots: [],
        window: { folders: ['d:/git/tier3', 'd:/git/orez.wiki'] },
      }),
    );

    expect(routeOf(plan)).toBe('reveal-elsewhere');
    expect('root' in plan && plan.root).toBe(root);
  });

  it('sends `code` a folder rather than a workspace file it would open as a file', () => {
    const generated = 'c:/Users/dev/AppData/Roaming/Code/Workspaces/1788438555144/workspace.json';
    const plan = decide(
      request(live, {
        surfaces: [sidebarIn(live, generated)],
        window: { folders: [away.cwd] },
        liveRoots: [],
      }),
    );

    expect(routeOf(plan)).toBe('sidebar-elsewhere');
    expect('root' in plan && plan.root).toBe(away.cwd);
  });

  it('keeps a saved workspace file, which is exactly what `code` reopens that window with', () => {
    const saved = 'd:/git/team.code-workspace';
    const plan = decide(
      request(live, { surfaces: [tabIn(live, saved)], window: { folders: [away.cwd] }, liveRoots: [] }),
    );

    expect('root' in plan && plan.root).toBe(saved);
  });

  it('falls back to a folder from the join when nothing has recorded a surface yet', () => {
    const plan = decide(
      request(live, { surfaces: [], window: { folders: [away.cwd] }, liveRoots: [] }),
    );

    expect(routeOf(plan)).toBe('unknown-surface-elsewhere');
    expect('root' in plan && plan.root).toBe(away.cwd);
  });

  it('stays put for a session in this window whose surface nothing has recorded', () => {
    const plan = decide(
      request(live, { surfaces: [], window: { folders: [live.cwd] }, liveRoots: [] }),
    );

    expect(routeOf(plan)).toBe('unknown-surface-here');
  });

  /**
   * The record is stale where it names a window the join does not: the session moved, or that window has closed. Its
   * root would send `code` to open a window the session is not in, and the fire there would start a second agent.
   */
  it('takes the folder from the join over a recorded root that window does not have open', () => {
    const plan = decide(
      request(live, {
        surfaces: [tabIn(live, 'd:/git/closed-since')],
        window: { folders: [away.cwd] },
        liveRoots: [away.cwd],
      }),
    );

    expect(routeOf(plan)).toBe('reveal-elsewhere');
    expect('root' in plan && plan.root).toBe(away.cwd);
  });

  /** A lock file lists the folders inside a workspace and never the file, so roots alone can never confirm one. */
  it('accepts a workspace file the join could not confirm, rather than calling its window closed', () => {
    const saved = 'd:/git/team.code-workspace';
    const plan = decide(
      request(live, { surfaces: [tabIn(live, saved)], window: null, liveRoots: [away.cwd] }),
    );

    expect(routeOf(plan)).toBe('reveal-elsewhere');
    expect('root' in plan && plan.root).toBe(saved);
  });

  /** The generated file is not a root `code` reopens, and the window it came from offers no folder to use instead. */
  it('never hands `code` a generated workspace.json, even with nothing else to aim at', () => {
    const generated = 'c:/Users/dev/AppData/Roaming/Code/Workspaces/1788438555144/workspace.json';
    const plan = decide(
      request(live, { surfaces: [tabIn(live, generated)], window: { folders: [] }, liveRoots: [] }),
    );

    expect(refusalOf(plan)).toBe('unnamed-window');
    expect('root' in plan).toBe(false);
  });

  it('picks the named session out of a roster of many', () => {
    const plan = planOpen({
      sessionId: away.sessionId,
      sessions: roster,
      surfaces: roster.map((session) => tabIn(session, session.cwd)),
      liveRoots: roster.map((session) => session.cwd),
      window: null,
      workspaceRoot: live.cwd,
      mayOpenWindow: true,
      extensionReady: true,
      now: away.startedAt + SETTLING_MS + 1,
    }, PLACEMENTS);

    expect(routeOf(plan)).toBe('reveal-elsewhere');
    expect('session' in plan && plan.session.sessionId).toBe(away.sessionId);
  });
});

describe('the folder comparison tolerates how a path was reported', () => {
  it('treats a differently cased drive letter and a trailing separator as the same window', () => {
    const root = `${live.cwd.toUpperCase()}/`;
    const plan = decide(request(live, { surfaces: [tabIn(live, root)], liveRoots: [root] }));

    expect(routeOf(plan)).toBe('reveal-here');
  });

  it('matches a live root recorded with the other separator', () => {
    const plan = decide(
      request(live, {
        surfaces: [tabIn(live, away.cwd)],
        liveRoots: [away.cwd.split('/').join('\\')],
      }),
    );

    expect(routeOf(plan)).toBe('reveal-elsewhere');
  });
});

describe('openableSessions', () => {
  it('offers every Claude session, wherever it runs, because the surface is read at the click', () => {
    expect(openableSessions(roster, PLACEMENTS).sort()).toEqual(roster.map((session) => session.sessionId).sort());
  });

  it('leaves out a session another CLI reported, since the command is the Claude extension\u2019s', () => {
    const mixed = [live, twin, { ...away, agent: 'codex' }];

    expect(openableSessions(mixed, PLACEMENTS).sort()).toEqual([live.sessionId, twin.sessionId].sort());
  });
});

describe('strayFrom', () => {
  it('names a session that appeared while an open was in flight, because a reveal creates none', () => {
    const after = [...roster, { ...live, sessionId: 'brand-new' }];

    expect(strayFrom(roster, after)?.sessionId).toBe('brand-new');
  });

  it('names nothing when the roster did not grow', () => {
    expect(strayFrom(roster, roster)).toBeNull();
  });
});

describe('verifyOpen', () => {
  it('reports opened when the window gained a tab', () => {
    expect(verifyOpen(1, 2, false)).toBe('opened');
  });

  it('reports opened on an unchanged count when a Claude tab is now focused, which is a reveal', () => {
    expect(verifyOpen(2, 2, true)).toBe('opened');
  });

  it('reports no-tab when nothing appeared and nothing was focused', () => {
    expect(verifyOpen(0, 0, false)).toBe('no-tab');
  });

  it('reports no-tab when a tab was already there and neither the count nor the focus moved', () => {
    expect(verifyOpen(3, 3, false)).toBe('no-tab');
  });

  it('reports no-tab when the count fell, which no open can cause', () => {
    expect(verifyOpen(3, 1, false)).toBe('no-tab');
  });
});
