import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { dirKey, sessionLabel } from '@ground-control/core';
import type { HistoricalSession, OpenOutcome, OpenRefusal, OpenRoute, Session } from '@ground-control/core';
import { PLACEMENTS, resumeRefusal, strayFrom, verifyOpen } from '@ground-control/host-vscode';

/** The Claude placement in VS Code: its ids, and the commands that reach a session without side effects (§6, §7). */
const CLAUDE = PLACEMENTS['claude']!;
const VERIFY_TIMEOUT_MS = 2500;
const POLL_MS = 250;
const FOCUS_POLL_MS = 50;
const ACTIVATE_TIMEOUT_MS = 10_000;
/** How long to wait for another window to come forward — a cold one took 3.2 s when measured (`docs/mechanics.md` §8). */
const FOCUS_TIMEOUT_MS = 12_000;
const LANDING_TIMEOUT_MS = 20_000;
/** Each pass is a full roster read, so this is paced to cost a handful of them rather than one every quarter second. */
const LANDING_POLL_MS = 2000;

/**
 * How the resident half reads the machine: it asks the hub, which is the only thing here that reads it at all.
 * Null is a read that did not happen. Never an empty list — every caller here compares against what was running
 * before, and reading a failure as "nothing was running" turns the developer's own sessions into strays.
 */
export type Roster = () => Promise<readonly Session[] | null>;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Use this editor's CLI directly: a saved directory is an argument, never shell source. */
function runCode(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(vscode.env.appRoot, 'out', 'cli.js'), ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 20_000,
    }, () => resolve());
  });
}

/** A Claude panel's viewType is prefixed by the host, so this is a containment test rather than an equality one. */
function isClaudePanel(tab: vscode.Tab | undefined): boolean {
  const viewType = (tab?.input as { viewType?: unknown } | undefined)?.viewType;

  return typeof viewType === 'string' && viewType.includes(CLAUDE.webviewId);
}

function claudeTabCount(): number {
  return vscode.window.tabGroups.all.reduce(
    (count, group) => count + group.tabs.filter((tab) => isClaudePanel(tab)).length,
    0,
  );
}

function claudePanelActive(): boolean {
  return isClaudePanel(vscode.window.tabGroups.activeTabGroup.activeTab);
}

/**
 * Polled rather than slept on. A new tab and a reveal both reach `tabGroups` over an async event, so an immediate read
 * sees neither; polling also returns as soon as the tab is there instead of always paying the whole timeout.
 */
async function watchForTab(before: number): Promise<OpenOutcome> {
  for (let waited = 0; waited < VERIFY_TIMEOUT_MS; waited += POLL_MS) {
    if (verifyOpen(before, claudeTabCount(), claudePanelActive()) === 'opened') {
      return 'opened';
    }

    await delay(POLL_MS);
  }

  return verifyOpen(before, claudeTabCount(), claudePanelActive());
}

/** This window losing focus is the proof another one came forward, and it arrives far sooner than a fixed wait. */
async function focusLeft(timeoutMs: number): Promise<boolean> {
  for (let waited = 0; waited < timeoutMs; waited += FOCUS_POLL_MS) {
    if (!vscode.window.state.focused) {
      return true;
    }

    await delay(FOCUS_POLL_MS);
  }

  return false;
}

/** Whether the agent's own extension is here and activated, which is what performs a reveal in this window. */
export async function agentExtensionReady(): Promise<boolean> {
  const extension = vscode.extensions.getExtension(CLAUDE.extensionId);

  if (!extension) {
    return false;
  }

  if (extension.isActive) {
    return true;
  }

  // An activation that never settles is as good as absent, and leaves the click hanging if it is not given up on.
  return Promise.race([
    extension.activate().then(() => true),
    delay(ACTIVATE_TIMEOUT_MS).then(() => false),
  ]).catch(() => false);
}

/**
 * This window's own root, chosen the way a recorded one is (§21): its workspace file where it has one, else its first
 * folder. A multi-root window's folder equals no recorded root, so that alone would place every session elsewhere.
 */
export function boardRoot(): string | null {
  const file = vscode.workspace.workspaceFile;

  return (file?.scheme === 'file' ? file.fsPath : undefined) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

/** Brings a root forward, opening its window when a historical resume needs one. */
async function raise(root: string, newWindow = false): Promise<boolean> {
  await runCode(newWindow ? ['--new-window', root] : [root]);

  return focusLeft(FOCUS_TIMEOUT_MS);
}

/** Focuses whichever of the two Claude views this VS Code registered; the other rejects rather than doing nothing. */
async function focusSidebar(): Promise<boolean> {
  for (const command of CLAUDE.sidebarFocusCommands) {
    try {
      await vscode.commands.executeCommand(command);

      return true;
    } catch {
      continue;
    }
  }

  return false;
}

async function revealHere(sessionId: string): Promise<string | null> {
  const before = claudeTabCount();

  try {
    await vscode.commands.executeCommand(CLAUDE.revealCommand, sessionId);
  } catch (error) {
    return `${CLAUDE.revealCommand} failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  return (await watchForTab(before)) === 'opened'
    ? null
    : 'The Claude Code extension reported the session open but no tab appeared.';
}

/**
 * Watches, after the fact, for the session to appear where it was aimed. Not awaited: the developer has already been
 * taken to the window, and the only thing worth interrupting them for is a fire that missed (`docs/mechanics.md` §7).
 */
async function confirmLanding(roster: Roster, root: string, before: readonly Session[], expectedSessionId?: string): Promise<void> {
  for (let waited = 0; waited < LANDING_TIMEOUT_MS; waited += LANDING_POLL_MS) {
    await delay(LANDING_POLL_MS);

    const now = await roster();

    // A read that did not happen says nothing about where the session landed, and this watch exists only to
    // interrupt the developer when it went wrong. Giving up quietly is the honest end (R24).
    if (now === null) {
      return;
    }

    const resumed = expectedSessionId && now.find((s) => s.sessionId === expectedSessionId && !s.finished);
    if (resumed && dirKey(resumed.cwd) === dirKey(root)) return;
    const stray = strayFrom(before, now, expectedSessionId);

    if (stray) {
      void vscode.window.showErrorMessage(
        `The session was aimed at the window on ${root}, but a new session started in ${stray.cwd} — another window took focus first. Close that tab.`,
      );

      return;
    }
  }
  if (expectedSessionId) {
    void vscode.window.showWarningMessage('The historical session did not appear in its working directory. Refresh the board before trying again.');
  }
}

/**
 * Reveals a session whose tab is in another window. The URI reaches whichever window has focus and nothing else
 * (`docs/mechanics.md` §7), so focus is taken first, deliberately, and the fire is checked afterwards.
 */
async function revealElsewhere(roster: Roster, session: Session | HistoricalSession, root: string, resume?: { expiresAt: number; newWindow: boolean }): Promise<string | null> {
  if (resume && Date.now() >= resume.expiresAt) return 'This resume request expired. Refresh the board and try again.';
  if (!(await raise(root, resume?.newWindow))) {
    return `Could not bring the window on ${root} forward, so nothing was opened. Is the \`code\` command on your PATH?`;
  }

  // Read here rather than taken from the render: anything already running when the fire went out is the developer's
  // own work, and reporting it as a stray would tell them to close a session they had just started themselves.
  const before = await roster();
  if (resume) {
    const refusal = resumeRefusal(session.sessionId, before);
    if (refusal) return refusal;
    if (Date.now() >= resume.expiresAt) return 'This resume request expired before its window was ready. Refresh the board and try again.';
  }

  await runCode(['--open-url', CLAUDE.openUri(session.sessionId)]);

  // Only with something to compare against. Without it the watch below would call every session already running a
  // stray, which is worse than saying nothing: the fire itself is unaffected either way.
  if (before !== null) {
    void confirmLanding(roster, root, before, resume ? session.sessionId : undefined);
  }

  return null;
}

/**
 * Carries out one route in this window, returning what to tell the developer when it did not land. Every route the
 * host can plan is one only a client inside the host can perform: each fires a URI or a command, and both follow
 * focus (`docs/mechanics.md` §7, §8), which a headless process has no way to confirm.
 *
 * The switch is exhaustive on purpose: a route added to the plan and not handled here fails the typecheck rather
 * than falling through to another.
 */
export async function performRoute(plan: OpenRoute, roster: Roster): Promise<string | null> {
  switch (plan.route) {
    case 'resume-here': {
      if (dirKey(boardRoot() ?? '') !== dirKey(plan.root)) return 'The workspace changed before this session could be resumed. Refresh the board.';
      const before = await roster();
      const refusal = resumeRefusal(plan.session.sessionId, before);
      if (refusal) return refusal;
      if (Date.now() >= plan.expiresAt) return 'This resume request expired. Refresh the board and try again.';
      const failure = await revealHere(plan.session.sessionId);
      if (!failure && before !== null) void confirmLanding(roster, plan.root, before, plan.session.sessionId);
      return failure;
    }

    case 'resume-elsewhere':
      return revealElsewhere(roster, plan.session, plan.root, plan);

    case 'reveal-here':
      return revealHere(plan.session.sessionId);

    case 'reveal-elsewhere':
      return revealElsewhere(roster, plan.session, plan.root);

    case 'sidebar-here':
      if (!(await focusSidebar())) {
        return 'The Claude sidebar would not come forward. Open it from the activity bar.';
      }

      // Said out loud because the sidebar shows one session and the record of which is up to a minute old: the view
      // that comes forward may be showing different work than the row that was clicked (`docs/mechanics.md` §21).
      void vscode.window.showInformationMessage(
        `The Claude sidebar should be showing ${sessionLabel(plan.session)}.`,
      );

      return null;

    case 'sidebar-elsewhere':
      await raise(plan.root);

      // Nothing else is safe: the sidebar has no reveal-by-id, and opening a panel for a session it already holds is
      // a second process on one transcript (`docs/mechanics.md` §11).
      void vscode.window.showInformationMessage(
        `${sessionLabel(plan.session)} is in the Claude sidebar of the window on ${plan.root}.`,
      );

      return null;

    case 'unknown-surface-here':
      void vscode.window.showInformationMessage(
        `${sessionLabel(plan.session)} is somewhere in this window. VS Code has not recorded which tab or sidebar holds it, and guessing would run a second agent on it.`,
      );

      return null;

    case 'unknown-surface-elsewhere':
      await raise(plan.root);

      void vscode.window.showInformationMessage(
        `${sessionLabel(plan.session)} is in the window on ${plan.root}. VS Code has not recorded which tab or sidebar holds it, so this is as close as the board can take you.`,
      );

      return null;
  }
}

/** R34: the one refusal the developer fixes by changing a setting is offered the setting rather than told its name. */
export async function refuse(refusal: OpenRefusal, message: string): Promise<void> {
  if (refusal !== 'elsewhere-not-allowed') {
    void vscode.window.showWarningMessage(message);

    return;
  }

  const grant = 'Allow other windows';

  if ((await vscode.window.showWarningMessage(message, grant)) === grant) {
    await vscode.workspace
      .getConfiguration('groundControl')
      .update('openWindowsForSessions', true, vscode.ConfigurationTarget.Global);
  }
}

/** Ids being opened, so a second click on a row whose tab is already on its way is dropped rather than repeated. */
const opening = new Set<string>();

/**
 * Carries out a route the hub planned, and says what went wrong when it did not land. One at a time per session:
 * a second fire at a tab already on its way is a second agent on one transcript (`docs/mechanics.md` §11).
 */
export async function perform(route: OpenRoute, roster: Roster): Promise<void> {
  if (opening.has(route.session.sessionId)) {
    return;
  }

  opening.add(route.session.sessionId);

  try {
    const failure = await performRoute(route, roster);

    if (failure) {
      void vscode.window.showErrorMessage(failure);
    }
  } finally {
    opening.delete(route.session.sessionId);
  }
}
