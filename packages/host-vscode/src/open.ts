import { basename, dirKey, sessionLabel } from '@ground-control/core';
import type { CheckoutRequest, HostWindow, OpenOutcome, OpenPlan, OpenRequest, OpenRoute, Session, StartRequest, StartableAgent } from '@ground-control/core';
import type { AgentPlacement } from './placements.js';
import { repositoryWindowFor } from './worktree.js';

/** Allow 120 seconds for new sessions to appear in VS Code storage, which flushes every 63 seconds (M21). */
export const SETTLING_MS = 120_000;

/** Routes supported by the VS Code host. */
export const VSCODE_ROUTES: readonly OpenRoute['route'][] = [
  'resume-here',
  'resume-elsewhere',
  'reveal-here',
  'reveal-elsewhere',
  'sidebar-here',
  'sidebar-elsewhere',
  'unknown-surface-here',
  'unknown-surface-elsewhere',
  'open-checkout',
  'start-session',
];

/**
 * `executeCommand` resolves even when no tab opens (M8). Confirm a new tab or an active agent panel; revealing
 * an existing session adds no tab.
 */
export function verifyOpen(before: number, after: number, agentPanelActive: boolean): OpenOutcome {
  return after > before || agentPanelActive ? 'opened' : 'no-tab';
}

/** Unsaved windows use a generated `workspace.json`, which `code` opens as a file instead of a workspace. */
function reopenable(root: string): boolean {
  return basename(root).toLowerCase() !== 'workspace.json';
}

/** Identify a saved multi-root workspace. Lock files list its folders, not its workspace file. */
function workspaceFile(root: string): boolean {
  return root.toLowerCase().endsWith('.code-workspace');
}

/**
 * Choose the target window path. Prefer a recorded workspace file or matching folder; ignore stale folder
 * records.
 */
function windowRoot(recorded: string | null, window: HostWindow): string | null {
  if (recorded !== null && (workspaceFile(recorded) || window.folders.some((f) => dirKey(f) === dirKey(recorded)))) {
    return recorded;
  }

  // A folder identifies only a single-folder window. Passing a multi-root folder to `code` opens a separate
  // window.
  const [only, second] = window.folders;

  return only !== undefined && second === undefined ? only : null;
}

/** Host settings that change routing (R14, R44). */
export interface OpenSettings {
  mayOpenWindow: boolean;
  resumeWorktreesInRepositoryWindow: boolean;
}

/** Route by window and surface. Opening a sidebar session as a tab would start a duplicate agent. */
export function planOpen(
  request: OpenRequest,
  placements: Readonly<Record<string, AgentPlacement>>,
  { mayOpenWindow, resumeWorktreesInRepositoryWindow }: OpenSettings,
): OpenPlan {
  const session = request.sessions.find((candidate) => candidate.sessionId === request.sessionId);

  // Reject detached runs before routing. Resuming while the background process exists exits 1, even after its
  // turn finishes (M33).
  if (session?.attachId != null) {
    return {
      refusal: 'attach-only',
      message: `${sessionLabel(session)} is a background run. Attach from its row in VS Code to avoid starting a duplicate process.`,
    };
  }

  const historical = request.historicalSession;
  if ((!session || session.finished) && historical?.sessionId === request.sessionId) {
    if (!(historical.agent in placements)) return { refusal: 'other-agent', message: `This editor cannot resume ${historical.agent} sessions.` };
    if (!request.extensionReady) return { refusal: 'no-extension', message: `Install or enable the ${historical.agent} extension to resume this session.` };
    // Redirect the window, not the working directory: the session still runs in its own checkout (R44). A
    // window already on that checkout resumes it directly (R14).
    const inCheckout = request.workspaceRoot !== null && dirKey(request.workspaceRoot) === dirKey(historical.cwd);
    const repository =
      resumeWorktreesInRepositoryWindow && !inCheckout && historical.agent === 'claude' ? repositoryWindowFor(historical.cwd) : null;
    const root = repository ?? historical.cwd;
    const here = request.workspaceRoot !== null && dirKey(request.workspaceRoot) === dirKey(root);
    if (!here && !mayOpenWindow) return { refusal: 'elsewhere-not-allowed', message: `Resuming this session needs a window on ${root}. Allow other windows to continue.` };
    const base = { session: historical, root, expiresAt: request.now + 30_000, ...(repository === null ? {} : { worktree: historical.cwd }) };
    if (here) return { route: 'resume-here', ...base };
    const matching = request.liveWindows?.filter((w) => w.folders.some((f) => dirKey(f) === dirKey(root))) ?? [];
    return { route: 'resume-elsewhere', ...base, newWindow: matching.length === 0 || matching.some((w) => w.folders.length !== 1) };
  }

  if (!session) {
    return {
      refusal: 'unknown-session',
      message: 'That session is no longer on the board. Refresh and try again.',
    };
  }

  const placement = placements[session.agent];

  if (placement === undefined) {
    return {
      refusal: 'other-agent',
      message: `This editor cannot open ${session.agent} sessions.`,
    };
  }

  if (!request.extensionReady) {
    return {
      refusal: 'no-extension',
      message: `The ${session.agent} extension is not available. Install it, or reload the window if it already is.`,
    };
  }

  const held = request.surfaces.find((surface) => surface.sessionId === session.sessionId);
  // Exclude generated `workspace.json` paths, which `code` opens as files.
  const recorded = held !== undefined && reopenable(held.root) ? held.root : null;
  const root = request.window === null ? recorded : windowRoot(recorded, request.window);

  if (root === null) {
    if (request.window !== null) {
      return {
        refusal: 'unnamed-window',
        message: `${sessionLabel(session)} is in a VS Code window with no single folder path. Switch to that window manually.`,
      };
    }

    return request.now - session.startedAt < SETTLING_MS
      ? {
          refusal: 'settling',
          message: `${sessionLabel(session)} just started. Its window is not yet recorded. Try again in a minute.`,
        }
      : {
          refusal: 'no-surface',
          message: `${sessionLabel(session)} is running in ${session.cwd}, but no VS Code tab or sidebar is recorded for it.`,
        };
  }

  const here = request.workspaceRoot !== null && dirKey(root) === dirKey(request.workspaceRoot);

  // Require an open window to avoid starting a duplicate agent. Saved multi-root records suffice because lock
  // files do not identify workspace files.
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
      message: `${sessionLabel(session)} is open in ${root}. Allow other windows to focus it.`,
    };
  }

  // A receiving window must open locally or refuse. Forwarding again can send the session between two windows
  // indefinitely (M45).
  if (!here && request.handedOver === true) {
    return {
      refusal: 'elsewhere-not-allowed',
      message: `Could not focus ${root}. Open ${sessionLabel(session)} from that window.`,
    };
  }

  // Only idempotent reveal is safe when the window is known but its surface is not. Guessing for Claude can
  // start a duplicate agent (M21, M44).
  if (!held) {
    if (!placement.idempotentReveal) {
      return here
        ? { route: 'unknown-surface-here', session, root }
        : { route: 'unknown-surface-elsewhere', session, root };
    }

    return here ? { route: 'reveal-here', session, root } : { route: 'reveal-elsewhere', session, root };
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
 * Find unexpected sessions created during an open. A reveal should create none; focus changes can send the URI
 * to another window and start an agent (M7).
 */
export function strayFrom(before: readonly Session[], after: readonly Session[], expectedSessionId?: string): Session | null {
  const previousSessionIds = new Set(before.map((session) => session.sessionId));

  return after.find((session) => session.sessionId !== expectedSessionId && !previousSessionIds.has(session.sessionId)) ?? null;
}

/** Require a complete roster read before resuming to exclude active copies of the session. */
export function resumeRefusal(sessionId: string, roster: readonly Session[] | null): string | null {
  if (roster === null) return 'Could not verify whether this session is active. Refresh the board and try again.';
  if (roster.some((s) => s.sessionId === sessionId && !s.finished)) return 'This session is already active. Refresh the board to open it.';
  // A background process may remain after its turn finishes. Resuming while it exists exits 1 (M33).
  if (roster.some((s) => s.sessionId === sessionId && s.attachId !== null)) return 'This is a background run. Attach to it from its board row.';
  return null;
}

/**
 * Choose a checkout window using the same reuse rule as resume. Passing a folder from a multi-root workspace to
 * `code` opens a separate window.
 */
export function planCheckout(request: CheckoutRequest, mayOpenWindow: boolean): OpenPlan {
  const { key, root } = request;

  if (request.workspaceRoot !== null && dirKey(request.workspaceRoot) === dirKey(root)) {
    return { refusal: 'already-here', message: `This window is already open on ${root}.` };
  }

  if (!mayOpenWindow) {
    return {
      refusal: 'elsewhere-not-allowed',
      message: `Opening ${root} requires another window. Allow other windows to continue.`,
    };
  }

  const matching = request.liveWindows.filter((window) => window.folders.some((folder) => dirKey(folder) === dirKey(root)));

  return { route: 'open-checkout', key, root, newWindow: matching.length === 0 || matching.some((window) => window.folders.length !== 1) };
}

/**
 * Allow a new session only in the requesting window at the selected checkout. The agent assigns its ID during
 * creation, so there is no existing session ID to route elsewhere (mechanics M51). Open the checkout first
 * when another window is required.
 */
export function planStart(request: StartRequest, placements: Readonly<Record<string, AgentPlacement>>): OpenPlan {
  const { key, agent, root, prompt } = request;
  const placement = placements[agent];

  if (placement?.start === undefined) {
    return { refusal: 'no-agent', message: `This editor cannot start ${agent} sessions.` };
  }

  if (!request.extensionReady) {
    return {
      refusal: 'no-extension',
      message: `The ${agent} extension is not available. Install it, or reload the window if it already is.`,
    };
  }

  if (request.workspaceRoot === null || dirKey(request.workspaceRoot) !== dirKey(root)) {
    return {
      refusal: 'checkout-elsewhere',
      message: `Open ${root} in VS Code, then start the session from its board.`,
    };
  }

  return { route: 'start-session', key, agent, root, prompt: placement.startTakesPrompt ? prompt : null };
}

/** Offer sessions supported by this host. Resolve their windows when clicked. */
export function openableSessions(
  sessions: readonly Pick<Session, 'agent' | 'sessionId'>[],
  placements: Readonly<Record<string, AgentPlacement>>,
): string[] {
  return sessions.filter((session) => session.agent in placements).map((session) => session.sessionId);
}

/** List agents with a start command; availability does not depend on the card. */
export function startableAgents(placements: Readonly<Record<string, AgentPlacement>>): StartableAgent[] {
  return Object.entries(placements)
    .filter(([, placement]) => placement.start !== undefined)
    .map(([agent, placement]) => ({ agent, takesPrompt: placement.startTakesPrompt }));
}
