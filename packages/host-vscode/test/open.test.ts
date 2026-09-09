import { describe, expect, it } from 'vitest';
import type { CheckoutRequest, OpenPlan, OpenRequest, Session, SessionSurface, StartRequest } from '@ground-control/core';
import { basename } from '@ground-control/core';
import { SETTLING_MS, openableSessions, planCheckout, planOpen, planStart, resumeRefusal, startableAgents, strayFrom, verifyOpen } from '../src/open.js';
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
    extensionReady: true,
    now: session.startedAt + SETTLING_MS + 1,
    ...over,
  };
}

const decide = (req: OpenRequest, mayOpenWindow = true): OpenPlan => planOpen(req, PLACEMENTS, mayOpenWindow);

function refusalOf(plan: OpenPlan): string | undefined {
  return 'refusal' in plan ? plan.refusal : undefined;
}

function routeOf(plan: OpenPlan): string | undefined {
  return 'route' in plan ? plan.route : undefined;
}

describe('planOpen refuses, by name', () => {
  /**
   * The route that produced the failure this exists to stop: a detached run resolved to whatever surface the agent's
   * sidebar happened to record, and opening it there started a second process on one conversation.
   */
  it('refuses a detached run rather than routing it to a window', () => {
    const run = { ...live, attachId: 'c5d0c58f' };

    expect(refusalOf(decide(request(run)))).toBe('attach-only');
    // Finished changes nothing: the process goes on holding the conversation, which is what a resume runs into.
    expect(refusalOf(decide(request({ ...run, finished: true })))).toBe('attach-only');
  });

  it('refuses a session that is no longer on the board', () => {
    const plan = decide(request(live, { sessions: [], surfaces: [] }));

    expect(refusalOf(plan)).toBe('unknown-session');
  });

  it('refuses another agent, because this host has no placement for it', () => {
    const other = { ...live, agent: 'gemini' };

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
      request(live, { surfaces: [tabIn(live, away.cwd)], liveRoots: [away.cwd] }),
      false,
    );

    expect(refusalOf(plan)).toBe('elsewhere-not-allowed');
    expect('refusal' in plan && plan.message).toContain(away.cwd);
  });

  /** The permission is about moving the developer's focus, so it has nothing to say about the window they are in. */
  it('still opens a session in this window when it may not bring another forward', () => {
    expect(routeOf(decide(request(live), false))).toBe('reveal-here');
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
   * M44: a Codex reveal names the thread and re-activates whatever already holds it, so the window the join found is
   * enough. It is also the only way to reach a thread left in Codex's sidebar, which records no id to read back.
   */
  it('reveals an unrecorded session anyway where the reveal is idempotent', () => {
    const thread = session({ agent: 'codex' });

    expect(routeOf(decide(request(thread, { surfaces: [], window: { folders: [thread.cwd] }, liveRoots: [] })))).toBe(
      'reveal-here',
    );

    const elsewhere = decide(request(thread, { surfaces: [], window: { folders: [away.cwd] }, liveRoots: [] }));

    expect(routeOf(elsewhere)).toBe('reveal-elsewhere');
    expect('root' in elsewhere && elsewhere.root).toBe(away.cwd);
  });

  it('refuses a session of that agent that no window is running, which is one started outside every window', () => {
    const plan = decide(request(session({ agent: 'codex' }), { surfaces: [], window: null, liveRoots: [] }));

    expect(refusalOf(plan)).toBe('no-surface');
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
      extensionReady: true,
      now: away.startedAt + SETTLING_MS + 1,
    }, PLACEMENTS, true);

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
    const mixed = [live, twin, { ...away, agent: 'gemini' }];

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

describe('resuming historical sessions', () => {
  const historicalSession = { agent: 'claude', sessionId: live.sessionId, cwd: live.cwd, title: 'Previous work', branch: live.branch, issueNumber: live.issueNumber, repository: 'github.com/org/repo', updatedAt: 100 };
  const pastRequest = (over: Partial<OpenRequest> = {}) => request(live, { sessions: [], surfaces: [], liveRoots: [], historicalSession, ...over });
  it('resumes in the saved directory, including a new window when none is open', () => {
    expect(decide(pastRequest())).toMatchObject({ route: 'resume-here', root: live.cwd, session: historicalSession });
    expect(decide(pastRequest({ workspaceRoot: '/other' }))).toMatchObject({ route: 'resume-elsewhere', root: live.cwd, newWindow: true });
    expect(decide(pastRequest({ workspaceRoot: '/other', liveWindows: [{ folders: [live.cwd] }] }))).toMatchObject({ newWindow: false });
    expect(decide(pastRequest({ workspaceRoot: '/other', liveWindows: [{ folders: [live.cwd, '/second'] }] }))).toMatchObject({ newWindow: true });
    expect(refusalOf(decide(pastRequest({ workspaceRoot: '/other' }), false))).toBe('elsewhere-not-allowed');
    expect(refusalOf(decide(pastRequest({ extensionReady: false })))).toBe('no-extension');
    expect(refusalOf(decide(pastRequest({ historicalSession: { ...historicalSession, agent: 'other' } })))).toBe('other-agent');
  });
  it('reveals the live session when a historical card has become stale, including sidebar routing', () => {
    expect(routeOf(decide(pastRequest({ sessions: [live], surfaces: [sidebarIn(live, live.cwd)] })))).toBe('sidebar-here');
    expect(routeOf(decide(pastRequest({ sessions: [{ ...live, finished: true }] })))).toBe('resume-here');
  });
  it('does not confuse a requested resume with an unintended fresh session', () => {
    expect(strayFrom([], [live], live.sessionId)).toBeNull();
    expect(strayFrom([], [live, twin], live.sessionId)).toBe(twin);
  });
  it('requires a complete inactive roster immediately before firing', () => {
    expect(resumeRefusal(live.sessionId, null)).toContain('Could not verify');
    expect(resumeRefusal(live.sessionId, [live])).toContain('already active');
    expect(resumeRefusal(live.sessionId, [])).toBeNull();
    expect(resumeRefusal(live.sessionId, [{ ...live, finished: true }])).toBeNull();
    // A `--bg` run stays listed after its turn and its process keeps holding the conversation, so finished is not
    // gone - resuming one exits 1 (`mechanics.md` M33).
    expect(resumeRefusal(live.sessionId, [{ ...live, finished: true, attachId: 'c5d0c58f' }])).toContain('Attach to it');
  });
});

describe('planning a Codex session, which opens as a resource rather than a webview', () => {
  const codex = session({ agent: 'codex', sessionId: '01a072f9-c43a-73e2-a4fd-3a63e73ad152' });

  it('reveals it in this window like any other placed agent', () => {
    expect(routeOf(decide(request(codex)))).toBe('reveal-here');
  });

  it('names the agent whose extension is missing, rather than always naming Claude', () => {
    const plan = decide(request(codex, { extensionReady: false }));

    expect(refusalOf(plan)).toBe('no-extension');
    expect('refusal' in plan && plan.message).toContain('codex');
  });

  it('names an agent this editor has no placement for without claiming only Claude opens in a tab', () => {
    const plan = decide(request(session({ agent: 'gemini' })));

    expect(refusalOf(plan)).toBe('other-agent');
    expect('refusal' in plan && plan.message).toContain('gemini');
    // Two agents open in a tab now, so a refusal that says only one does is a refusal that misleads.
    expect('refusal' in plan && plan.message).not.toContain('Claude');
  });

  it('sends the developer to the window already showing it, the same as Claude', () => {
    const plan = decide(request(codex, { surfaces: [tabIn(codex, away.cwd)], liveRoots: [away.cwd] }));

    expect(routeOf(plan)).toBe('reveal-elsewhere');
    expect('root' in plan && plan.root).toBe(away.cwd);
  });
});

/**
 * A window on a card's checkout, and no agent in it. Nothing here reads a session or a surface: what decides the
 * route is which windows are open and whether one of them is nameable by that folder.
 */
describe('opening a card’s checkout', () => {
  const ROOT = 'd:/work/repo.worktrees/19002-refund-window';

  function ask(over: Partial<CheckoutRequest> = {}, mayOpenWindow = true): OpenPlan {
    return planCheckout({ key: 'issue:19002', root: ROOT, workspaceRoot: 'd:/work/repo', liveWindows: [], ...over }, mayOpenWindow);
  }

  it('opens a new window where no open one has that folder', () => {
    const plan = ask();

    expect(routeOf(plan)).toBe('open-checkout');
    expect('newWindow' in plan && plan.newWindow).toBe(true);
    expect('root' in plan && plan.root).toBe(ROOT);
  });

  it('is keyed by the card, since there is no session id to hold it by', () => {
    const plan = ask();

    expect('key' in plan && plan.key).toBe('issue:19002');
  });

  it('raises the window that already has the folder rather than opening a second', () => {
    expect(ask({ liveWindows: [{ folders: [ROOT] }] })).toMatchObject({ newWindow: false });
  });

  // `code` given one folder of a multi-root window opens a second window on that folder alone, so the window
  // showing the checkout is not the one that would come forward.
  it('opens a new window rather than naming a folder of a multi-root one', () => {
    expect(ask({ liveWindows: [{ folders: [ROOT, 'd:/work/other'] }] })).toMatchObject({ newWindow: true });
  });

  it('refuses a window this one is already on, which would open nothing and look broken', () => {
    expect(refusalOf(ask({ workspaceRoot: ROOT }))).toBe('already-here');
  });

  it('compares that against the developer’s own path spelling rather than byte for byte', () => {
    expect(refusalOf(ask({ workspaceRoot: 'D:\\work\\repo.worktrees\\19002-refund-window' }))).toBe('already-here');
  });

  // R14: bringing another window forward is the developer's permission, and this raises one like any other route.
  it('refuses to bring a window forward where the developer withheld it', () => {
    expect(refusalOf(ask({}, false))).toBe('elsewhere-not-allowed');
  });

  it('lets a board with no root of its own open one, which is what a window with no folder is', () => {
    expect(routeOf(ask({ workspaceRoot: null }))).toBe('open-checkout');
  });
});

/**
 * A new session on a card. The whole of the routing is whether this window is the checkout's: an agent takes its
 * directory from the window it starts in, and nothing can name a session that does not exist yet (M51).
 */
describe('starting a session on a card', () => {
  const ROOT = 'd:/work/repo.worktrees/19002-refund-window';

  function ask(over: Partial<StartRequest> = {}): OpenPlan {
    return planStart(
      { key: 'issue:19002', agent: 'claude', root: ROOT, prompt: 'fix #19002', workspaceRoot: ROOT, extensionReady: true, ...over },
      PLACEMENTS,
    );
  }

  it('starts in this window when it is already the checkout’s, carrying the card and the prompt', () => {
    expect(ask()).toEqual({ route: 'start-session', key: 'issue:19002', agent: 'claude', root: ROOT, prompt: 'fix #19002' });
  });

  it('compares this window’s root against the developer’s own path spelling', () => {
    expect(routeOf(ask({ workspaceRoot: 'D:\\work\\repo.worktrees\\19002-refund-window' }))).toBe('start-session');
  });

  // The refusal that names the other verb: R14's setting does not fix this one, and opening the checkout does.
  it('refuses a start in a window that is not on the checkout, and says to open it first', () => {
    const plan = ask({ workspaceRoot: 'd:/work/repo' });

    expect(refusalOf(plan)).toBe('checkout-elsewhere');
    expect('message' in plan && plan.message).toContain('in VS Code, then start the session from its board.');
  });

  it('refuses a start from a window with no folder at all, which is no checkout either', () => {
    expect(refusalOf(ask({ workspaceRoot: null }))).toBe('checkout-elsewhere');
  });

  it('refuses an agent with no way in, which is the whole of what no-agent means', () => {
    expect(refusalOf(ask({ agent: 'gemini' }))).toBe('no-agent');
  });

  it('refuses where the agent’s own extension is not in this window to be asked', () => {
    expect(refusalOf(ask({ extensionReady: false }))).toBe('no-extension');
  });

  // M51: `chatgpt.newCodexPanel` takes no arguments, so a prompt handed to it would be dropped silently. Dropping
  // it here is what lets the menu item say the session starts bare.
  it('drops the prompt for an agent whose only way in takes none', () => {
    expect(ask({ agent: 'codex' })).toMatchObject({ route: 'start-session', agent: 'codex', prompt: null });
  });
});

describe('startableAgents', () => {
  it('names every agent with a start row, and whether its start carries the prompt', () => {
    expect(startableAgents(PLACEMENTS)).toEqual([
      { agent: 'claude', takesPrompt: true },
      { agent: 'codex', takesPrompt: false },
    ]);
  });

  it('names none out of a table whose agents have no way in', () => {
    const { start: _dropped, ...noStart } = PLACEMENTS['claude']!;

    expect(startableAgents({ claude: noStart })).toEqual([]);
  });
});
