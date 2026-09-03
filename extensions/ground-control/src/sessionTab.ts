import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { diskReaders, fetchSessions } from '@ground-control/core';
import type { OpenOutcome, OpenRefusal, OpenRoute, Session } from '@ground-control/core';
import {
  PLACEMENTS,
  liveRootsOf,
  planOpen,
  primeWindows,
  readWindowStores,
  readWindows,
  sessionName,
  strayFrom,
  surfacesFrom,
  verifyOpen,
} from '@ground-control/host-vscode';
import { mayOpenWindow, readSessionsConfig } from './config.js';
import { agents } from './registry.js';

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `code` is a shell script on every platform, so it is run through one — which means arguments are quoted by hand. */
function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(command, args, { shell: true, windowsHide: true, timeout: 20_000 }, () => resolve());
  });
}

function quoted(value: string): string {
  return `"${value.replace(/"/g, '')}"`;
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
async function agentExtensionReady(): Promise<boolean> {
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

/** The live roster, read the one way the board reads it, so a row here is the same `Session` a card was built from. */
async function roster(): Promise<Session[]> {
  return (await fetchSessions(readSessionsConfig(), agents, diskReaders())).sessions;
}

/**
 * This window's own root, chosen the way a recorded one is (§21): its workspace file where it has one, else its first
 * folder. A multi-root window's folder equals no recorded root, so that alone would place every session elsewhere.
 */
function boardRoot(): string | null {
  const file = vscode.workspace.workspaceFile;

  return (file?.scheme === 'file' ? file.fsPath : undefined) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

/** Brings the window on a root forward. Only ever called for a root a window is open on, which `planOpen` settles. */
async function raise(root: string): Promise<boolean> {
  await run('code', [quoted(root)]);

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
async function confirmLanding(root: string, before: readonly Session[]): Promise<void> {
  for (let waited = 0; waited < LANDING_TIMEOUT_MS; waited += LANDING_POLL_MS) {
    await delay(LANDING_POLL_MS);

    const stray = strayFrom(before, await roster());

    if (stray) {
      void vscode.window.showErrorMessage(
        `The session was aimed at the window on ${root}, but a new session started in ${stray.cwd} — another window took focus first. Close that tab.`,
      );

      return;
    }
  }
}

/**
 * Reveals a session whose tab is in another window. The URI reaches whichever window has focus and nothing else
 * (`docs/mechanics.md` §7), so focus is taken first, deliberately, and the fire is checked afterwards.
 */
async function revealElsewhere(session: Session, root: string): Promise<string | null> {
  if (!(await raise(root))) {
    return `Could not bring the window on ${root} forward, so nothing was opened. Is the \`code\` command on your PATH?`;
  }

  // Read here rather than taken from the render: anything already running when the fire went out is the developer's
  // own work, and reporting it as a stray would tell them to close a session they had just started themselves.
  const before = await roster();

  await run('code', ['--open-url', quoted(CLAUDE.openUri(session.sessionId))]);

  void confirmLanding(root, before);

  return null;
}

export interface Machine {
  /** The `User` directory of the running VS Code, which is where every window's persisted state lives. */
  userDir: string;
  /** The home directory Claude Code writes under, which is where the windows announce themselves. */
  home: string;
}

/**
 * Carries out one route, returning what to tell the developer when it did not land. The switch is exhaustive on
 * purpose: a route added to the plan and not handled here fails the typecheck rather than falling through to another.
 */
async function act(plan: OpenRoute): Promise<string | null> {
  switch (plan.route) {
    case 'reveal-here':
      return revealHere(plan.session.sessionId);

    case 'reveal-elsewhere':
      return revealElsewhere(plan.session, plan.root);

    case 'sidebar-here':
      if (!(await focusSidebar())) {
        return 'The Claude sidebar would not come forward. Open it from the activity bar.';
      }

      // Said out loud because the sidebar shows one session and the record of which is up to a minute old: the view
      // that comes forward may be showing different work than the row that was clicked (`docs/mechanics.md` §21).
      void vscode.window.showInformationMessage(
        `The Claude sidebar should be showing ${sessionName(plan.session)}.`,
      );

      return null;

    case 'sidebar-elsewhere':
      await raise(plan.root);

      // Nothing else is safe: the sidebar has no reveal-by-id, and opening a panel for a session it already holds is
      // a second process on one transcript (`docs/mechanics.md` §11).
      void vscode.window.showInformationMessage(
        `${sessionName(plan.session)} is in the Claude sidebar of the window on ${plan.root}.`,
      );

      return null;

    case 'unknown-surface-here':
      void vscode.window.showInformationMessage(
        `${sessionName(plan.session)} is somewhere in this window. VS Code has not recorded which tab or sidebar holds it, and guessing would run a second agent on it.`,
      );

      return null;

    case 'unknown-surface-elsewhere':
      await raise(plan.root);

      void vscode.window.showInformationMessage(
        `${sessionName(plan.session)} is in the window on ${plan.root}. VS Code has not recorded which tab or sidebar holds it, so this is as close as the board can take you.`,
      );

      return null;
  }
}

/** R34: the one refusal the developer fixes by changing a setting is offered the setting rather than told its name. */
async function refuse(refusal: OpenRefusal, message: string): Promise<void> {
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
 * Fills both caches an open needs — the process table and every window's persisted state — before the developer asks,
 * which is what leaves a click paying tens of milliseconds rather than the best part of a second.
 */
export function primeOpen(where: Machine): void {
  primeWindows();
  void readWindowStores(where.userDir, PLACEMENTS);
}

/**
 * Opens a session (R14), wherever it runs. Which window holds it comes from its own process, and which surface from
 * VS Code's per-window state — a tab is revealed by id, and a sidebar has no such command (`docs/mechanics.md` §21).
 */
export async function openSession(sessionId: string, sessions: readonly Session[], where: Machine): Promise<void> {
  const [windows, stores, extensionReady] = await Promise.all([
    readWindows(where.home, sessions.find((session) => session.sessionId === sessionId), PLACEMENTS),
    readWindowStores(where.userDir, PLACEMENTS),
    agentExtensionReady(),
  ]);

  const plan = planOpen({
    sessionId,
    sessions,
    surfaces: surfacesFrom(stores, PLACEMENTS),
    window: windows.holding,
    liveRoots: liveRootsOf(windows.live),
    workspaceRoot: boardRoot(),
    mayOpenWindow: mayOpenWindow(),
    extensionReady,
    now: Date.now(),
  }, PLACEMENTS);

  if ('refusal' in plan) {
    void refuse(plan.refusal, plan.message);

    return;
  }

  if (opening.has(plan.session.sessionId)) {
    return;
  }

  opening.add(plan.session.sessionId);

  try {
    const failure = await act(plan);

    if (failure) {
      void vscode.window.showErrorMessage(failure);
    }
  } finally {
    opening.delete(plan.session.sessionId);
  }
}
