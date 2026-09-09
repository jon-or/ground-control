import { describe, expect, it } from 'vitest';
import type { CheckoutRequest, OpenPlan, OpenRequest, Session, SessionSurface, StartRequest } from '@ground-control/core';
import { basename } from '@ground-control/core';
import { SETTLING_MS, openableSessions, planCheckout, planOpen, planStart, resumeRefusal, startableAgents, strayFrom, verifyOpen } from '../src/open.js';
import { PLACEMENTS } from '../src/placements.js';
import { session } from './helpers.js';

/** Sessions sharing the current checkout and in another checkout. */
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
 * Default to revealing a tab here. Use an age beyond the storage delay so missing surfaces are not treated as
 * new sessions.
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
  /** Reject background runs even when a recorded sidebar could otherwise route them into a duplicate process. */
  it('refuses editor routing for background runs', () => {
    const run = { ...live, attachId: 'c5d0c58f' };

    expect(refusalOf(decide(request(run)))).toBe('attach-only');
    // Finished turns can leave background processes running and prevent resume.
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

  it('refuses terminal sessions without a recorded window', () => {
    const plan = decide(request(live, { surfaces: [] }));

    expect(refusalOf(plan)).toBe('no-surface');
    expect('refusal' in plan && plan.message).toContain(live.cwd);
  });

  it('allows time for new sessions to appear in window storage', () => {
    const plan = decide(request(live, { surfaces: [], now: live.startedAt + SETTLING_MS - 1 }));

    expect(refusalOf(plan)).toBe('settling');
  });

  it('refuses a surface recorded by a window that has since closed', () => {
    const plan = decide(
      request(live, { surfaces: [tabIn(live, away.cwd)], workspaceRoot: live.cwd, liveRoots: [live.cwd] }),
    );

    expect(refusalOf(plan)).toBe('window-closed');
  });

  it('uses the agent name for untitled sessions', () => {
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

  it('names the target folder when window opening is disabled', () => {
    const plan = decide(
      request(live, { surfaces: [tabIn(live, away.cwd)], liveRoots: [away.cwd] }),
      false,
    );

    expect(refusalOf(plan)).toBe('elsewhere-not-allowed');
    expect('refusal' in plan && plan.message).toContain(away.cwd);
  });

  /** Window-opening permission does not restrict the current window. */
  it('still opens a session in this window when it may not bring another forward', () => {
    expect(routeOf(decide(request(live), false))).toBe('reveal-here');
  });

  it('refuses a window with no folder open, which `code` has no argument for', () => {
    const plan = decide(request(live, { surfaces: [], window: { folders: [] }, liveRoots: [] }));

    expect(refusalOf(plan)).toBe('unnamed-window');
  });

  /**
   * A multi-root folder path opens a separate window. Require its saved workspace path to target the existing
   * window.
   */
  it('refuses multi-root windows without a recorded workspace path', () => {
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

  /** Keep tab and sidebar routes distinct for the same session and window. */
  it('focuses an existing sidebar session in this window', () => {
    expect(routeOf(decide(request(live, { surfaces: [sidebarIn(live, live.cwd)] })))).toBe('sidebar-here');
  });

  it('focuses an existing sidebar session in another window', () => {
    const plan = decide(request(live, { surfaces: [sidebarIn(live, away.cwd)], liveRoots: [away.cwd] }));

    expect(routeOf(plan)).toBe('sidebar-elsewhere');
    expect('root' in plan && plan.root).toBe(away.cwd);
  });

  it('routes from a window without a workspace root', () => {
    const plan = decide(request(live, { workspaceRoot: null, liveRoots: [live.cwd] }));

    expect(routeOf(plan)).toBe('reveal-elsewhere');
  });

  /** The board window's root is compared to the recorded one as given, so a multi-root window must report its file. */
  it('recognizes the current multi-root workspace file', () => {
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

  it('uses a folder instead of generated workspace.json', () => {
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

  it('preserves saved workspace paths for window reuse', () => {
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

  /** Idempotent Codex reveal only needs the target window, including sessions in its unrecorded sidebar (M44). */
  it('reveals an unrecorded session anyway where the reveal is idempotent', () => {
    const thread = session({ agent: 'codex' });

    expect(routeOf(decide(request(thread, { surfaces: [], window: { folders: [thread.cwd] }, liveRoots: [] })))).toBe(
      'reveal-here',
    );

    const elsewhere = decide(request(thread, { surfaces: [], window: { folders: [away.cwd] }, liveRoots: [] }));

    expect(routeOf(elsewhere)).toBe('reveal-elsewhere');
    expect('root' in elsewhere && elsewhere.root).toBe(away.cwd);
  });

  it('refuses sessions outside known windows', () => {
    const plan = decide(request(session({ agent: 'codex' }), { surfaces: [], window: null, liveRoots: [] }));

    expect(refusalOf(plan)).toBe('no-surface');
  });

  /** Prefer process-based window evidence over stale recorded roots to avoid duplicate sessions. */
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
  it('accepts saved workspace files without matching lock records', () => {
    const saved = 'd:/git/team.code-workspace';
    const plan = decide(
      request(live, { surfaces: [tabIn(live, saved)], window: null, liveRoots: [away.cwd] }),
    );

    expect(routeOf(plan)).toBe('reveal-elsewhere');
    expect('root' in plan && plan.root).toBe(saved);
  });

  /** The generated file is not a root `code` reopens, and the window it came from offers no folder to use instead. */
  it('rejects generated workspace.json without a folder fallback', () => {
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

  it('accepts focus on an existing Claude tab without a new tab', () => {
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
    // Background processes can remain after a turn; resuming before process exit fails (M33).
    expect(resumeRefusal(live.sessionId, [{ ...live, finished: true, attachId: 'c5d0c58f' }])).toContain('Attach to it');
  });
});

describe('planning Codex resource opens', () => {
  const codex = session({ agent: 'codex', sessionId: '01a072f9-c43a-73e2-a4fd-3a63e73ad152' });

  it('reveals it in this window like any other placed agent', () => {
    expect(routeOf(decide(request(codex)))).toBe('reveal-here');
  });

  it('names the agent with the missing extension', () => {
    const plan = decide(request(codex, { extensionReady: false }));

    expect(refusalOf(plan)).toBe('no-extension');
    expect('refusal' in plan && plan.message).toContain('codex');
  });

  it('names an agent this editor has no placement for without claiming only Claude opens in a tab', () => {
    const plan = decide(request(session({ agent: 'gemini' })));

    expect(refusalOf(plan)).toBe('other-agent');
    expect('refusal' in plan && plan.message).toContain('gemini');
    // Refusals must account for both supported agents.
    expect('refusal' in plan && plan.message).not.toContain('Claude');
  });

  it('sends the developer to the window already showing it, the same as Claude', () => {
    const plan = decide(request(codex, { surfaces: [tabIn(codex, away.cwd)], liveRoots: [away.cwd] }));

    expect(routeOf(plan)).toBe('reveal-elsewhere');
    expect('root' in plan && plan.root).toBe(away.cwd);
  });
});

/** Checkout routing depends on open window roots, without session or surface state. */
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

  it('reuses a window already open on the folder', () => {
    expect(ask({ liveWindows: [{ folders: [ROOT] }] })).toMatchObject({ newWindow: false });
  });

  // A multi-root folder path opens a separate window instead of focusing the existing workspace.
  it('opens a separate window for a multi-root folder', () => {
    expect(ask({ liveWindows: [{ folders: [ROOT, 'd:/work/other'] }] })).toMatchObject({ newWindow: true });
  });

  it('refuses checkout opens targeting the current window', () => {
    expect(refusalOf(ask({ workspaceRoot: ROOT }))).toBe('already-here');
  });

  it('normalizes paths when comparing checkout windows', () => {
    expect(refusalOf(ask({ workspaceRoot: 'D:\\work\\repo.worktrees\\19002-refund-window' }))).toBe('already-here');
  });

  // R14: bringing another window forward is the developer's permission, and this raises one like any other route.
  it('refuses to bring a window forward where the developer withheld it', () => {
    expect(refusalOf(ask({}, false))).toBe('elsewhere-not-allowed');
  });

  it('opens a checkout from an empty window', () => {
    expect(routeOf(ask({ workspaceRoot: null }))).toBe('open-checkout');
  });
});

/**
 * Start only in the checkout's window. Agents inherit that directory and assign session IDs during creation
 * (M51).
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

  it('normalizes paths when comparing the current workspace', () => {
    expect(routeOf(ask({ workspaceRoot: 'D:\\work\\repo.worktrees\\19002-refund-window' }))).toBe('start-session');
  });

  // Require opening the checkout; enabling other-window permission does not permit starts elsewhere.
  it('requires opening the checkout before starting a session', () => {
    const plan = ask({ workspaceRoot: 'd:/work/repo' });

    expect(refusalOf(plan)).toBe('checkout-elsewhere');
    expect('message' in plan && plan.message).toContain('in VS Code, then start the session from its board.');
  });

  it('refuses session starts from an empty window', () => {
    expect(refusalOf(ask({ workspaceRoot: null }))).toBe('checkout-elsewhere');
  });

  it('refuses agents without a start command', () => {
    expect(refusalOf(ask({ agent: 'gemini' }))).toBe('no-agent');
  });

  it('refuses starts when the agent extension is unavailable', () => {
    expect(refusalOf(ask({ extensionReady: false }))).toBe('no-extension');
  });

  // Codex's start command accepts no arguments. Omit the prompt and expose that limitation to the menu (M51).
  it('drops the prompt for an agent whose only way in takes none', () => {
    expect(ask({ agent: 'codex' })).toMatchObject({ route: 'start-session', agent: 'codex', prompt: null });
  });
});

describe('startableAgents', () => {
  it('lists startable agents and prompt support', () => {
    expect(startableAgents(PLACEMENTS)).toEqual([
      { agent: 'claude', takesPrompt: true },
      { agent: 'codex', takesPrompt: false },
    ]);
  });

  it('returns no agents when no start commands are configured', () => {
    const { start: _dropped, ...noStart } = PLACEMENTS['claude']!;

    expect(startableAgents({ claude: noStart })).toEqual([]);
  });
});
