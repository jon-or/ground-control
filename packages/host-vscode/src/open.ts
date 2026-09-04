import { basename, dirKey, sessionLabel } from '@ground-control/core';
import type { HostWindow, OpenOutcome, OpenPlan, OpenRequest, OpenRoute, Session } from '@ground-control/core';
import type { AgentPlacement } from './placements.js';

/**
 * How long after a session starts its surface may still be missing from VS Code's store, which is flushed on a 63 s
 * cycle rather than on change: younger than this, a session is not yet placeable rather than unplaceable (§21).
 */
export const SETTLING_MS = 120_000;

/** Every route `planOpen` can return, which is the host's whole vocabulary for reaching a session. */
export const VSCODE_ROUTES: readonly OpenRoute['route'][] = [
  'reveal-here',
  'reveal-elsewhere',
  'sidebar-here',
  'sidebar-elsewhere',
  'unknown-surface-here',
  'unknown-surface-elsewhere',
];

/**
 * Whether an open in this window landed. `executeCommand` resolves either way (`docs/mechanics.md` §8), so a new tab
 * is the evidence — except for a session already open here, which is revealed: that adds no tab but does focus one.
 */
export function verifyOpen(before: number, after: number, claudePanelActive: boolean): OpenOutcome {
  return after > before || claudePanelActive ? 'opened' : 'no-tab';
}

/**
 * Whether `code` would reopen a root as the window it names. A window the developer never saved is backed by a
 * generated `workspace.json` under VS Code's own storage, which `code` opens as a file rather than as a workspace.
 */
function reopenable(root: string): boolean {
  return basename(root).toLowerCase() !== 'workspace.json';
}

/** A multi-root window's own name. A lock file lists the folders inside such a workspace and never the file itself. */
function workspaceFile(root: string): boolean {
  return root.toLowerCase().endsWith('.code-workspace');
}

/**
 * The path `code` is given for the window the join found. The record wins where it still describes that window, being
 * the only thing that names a multi-root one; a stale record would point `code` at a window the session is not in.
 */
function windowRoot(recorded: string | null, window: HostWindow): string | null {
  if (recorded !== null && (workspaceFile(recorded) || window.folders.some((f) => dirKey(f) === dirKey(recorded)))) {
    return recorded;
  }

  // Only a window with exactly one folder can be named by it: a folder of a multi-root window opens a second window
  // on that folder alone rather than raising the one already showing the session.
  const [only, second] = window.folders;

  return only !== undefined && second === undefined ? only : null;
}

/**
 * Where to open a session, or why the board will not. The window holding it decides where it opens, and the surface
 * decides how: asking for a session the sidebar holds as a tab opens a second agent on it rather than the first.
 */
export function planOpen(
  request: OpenRequest,
  placements: Readonly<Record<string, AgentPlacement>>,
  mayOpenWindow: boolean,
): OpenPlan {
  const session = request.sessions.find((candidate) => candidate.sessionId === request.sessionId);

  if (!session) {
    return {
      refusal: 'unknown-session',
      message: 'That session is no longer on the board. Refresh and try again.',
    };
  }

  if (!(session.agent in placements)) {
    return {
      refusal: 'other-agent',
      message: `Only Claude sessions open in a tab. This one was reported by ${session.agent}.`,
    };
  }

  if (!request.extensionReady) {
    return {
      refusal: 'no-extension',
      message: 'The Claude Code extension is not available. Install it, or reload the window if it already is.',
    };
  }

  const held = request.surfaces.find((surface) => surface.sessionId === session.sessionId);
  // A record `code` would not reopen as a window is no argument for one: a window the developer never saved is backed
  // by a generated `workspace.json`, which `code` opens as a file.
  const recorded = held !== undefined && reopenable(held.root) ? held.root : null;
  const root = request.window === null ? recorded : windowRoot(recorded, request.window);

  if (root === null) {
    if (request.window !== null) {
      return {
        refusal: 'unnamed-window',
        message: `${sessionLabel(session)} is in a VS Code window the board has no path to — it has no folder open, or several. Switch to that window yourself.`,
      };
    }

    return request.now - session.startedAt < SETTLING_MS
      ? {
          refusal: 'settling',
          message: `${sessionLabel(session)} started moments ago and VS Code has not recorded which window holds it yet. Try again in a minute.`,
        }
      : {
          refusal: 'no-surface',
          message: `${sessionLabel(session)} is running in ${session.cwd}, but no VS Code window is showing it — it was started from a terminal, or its tab has since been given another session.`,
        };
  }

  const here = request.workspaceRoot !== null && dirKey(root) === dirKey(request.workspaceRoot);

  // `code` on a folder no window has open opens a new one, where the session is not, so the fire would land on a
  // fresh agent. The join proves itself; a lock never names a `.code-workspace`, so that record answers for itself.
  const live =
    here ||
    request.window !== null ||
    workspaceFile(root) ||
    request.liveRoots.some((open) => dirKey(open) === dirKey(root));

  if (!live) {
    return {
      refusal: 'window-closed',
      message: `${sessionLabel(session)} was last seen in a window on ${root}, and no open window has that folder. Refresh the board, or open the session from the window running it.`,
    };
  }

  if (!here && !mayOpenWindow) {
    return {
      refusal: 'elsewhere-not-allowed',
      message: `${sessionLabel(session)} is open in the window on ${root}, and the board is not allowed to bring it forward.`,
    };
  }

  // Which window holds it is known and which surface is not. Firing would be a guess, and the wrong guess runs a
  // second agent on one transcript, so the developer is taken to the window instead (`docs/mechanics.md` §21).
  if (!held) {
    return here
      ? { route: 'unknown-surface-here', session, root }
      : { route: 'unknown-surface-elsewhere', session, root };
  }

  if (here) {
    return held.surface === 'tab'
      ? { route: 'reveal-here', session, root }
      : { route: 'sidebar-here', session, root };
  }

  return held.surface === 'tab'
    ? { route: 'reveal-elsewhere', session, root }
    : { route: 'sidebar-elsewhere', session, root };
}

/**
 * A session that started while an open was in flight. Revealing creates nothing, so anything new is evidence of a
 * miss: the URI follows the focused window, and a window that took focus first gets a fresh agent (§7).
 */
export function strayFrom(before: readonly Session[], after: readonly Session[]): Session | null {
  const had = new Set(before.map((session) => session.sessionId));

  return after.find((session) => !had.has(session.sessionId)) ?? null;
}

/**
 * The sessions the board offers to open. Every session of an agent placed in this host qualifies wherever it runs,
 * because which window holds it is read at the click rather than at the render.
 */
export function openableSessions(
  sessions: readonly Session[],
  placements: Readonly<Record<string, AgentPlacement>>,
): string[] {
  return sessions.filter((session) => session.agent in placements).map((session) => session.sessionId);
}
