import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { dirKey, routeKey, sessionLabel } from '@ground-control/core';
import type { HistoricalSession, OpenOutcome, OpenRefusal, OpenRoute, Session } from '@ground-control/core';
import { PLACEMENTS, handOverUri, resumeRefusal, stagedUpdate, stagedUpdateRefusal, strayFrom, verifyOpen } from '@ground-control/host-vscode';
import type { AgentPlacement, CommandArg } from '@ground-control/host-vscode';
import { spawnEnvironment } from '@ground-control/hub';

/** Resident operations supported by each agent (M43). */
function placementOf(agent: string): AgentPlacement | null {
  return PLACEMENTS[agent] ?? null;
}
const VERIFY_TIMEOUT_MS = 2500;
const POLL_MS = 250;
const FOCUS_POLL_MS = 50;
const ACTIVATE_TIMEOUT_MS = 10_000;
/** How long to wait for another window to come forward — a cold one took 3.2 s when measured (`docs/mechanics.md` M8). */
const FOCUS_TIMEOUT_MS = 12_000;
const LANDING_TIMEOUT_MS = 20_000;
/** Limit polling frequency because each attempt reads the full roster. */
const LANDING_POLL_MS = 2000;

/**
 * Read the roster through the hub. Return null for failed reads; treating failure as an empty roster would
 * misidentify existing sessions as unexpected launches.
 */
export type Roster = () => Promise<readonly Session[] | null>;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Use this editor's CLI directly: a saved directory is an argument, never shell source. The environment is the hub's
 * sanitized one — `VSCODE_NLS_CONFIG` and `VSCODE_CODE_CACHE_PATH` name the build this window runs, and `cli.js` hands whatever it was given to the editor it launches (M49).
 */
function runCode(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(vscode.env.appRoot, 'out', 'cli.js'), ...args], {
      env: spawnEnvironment(), windowsHide: true, timeout: 20_000,
    }, (error, _stdout, stderr) => resolve(error === null ? null : stderr.trim() || error.message));
  });
}

/** A Claude panel's viewType is prefixed by the host, so this is a containment test rather than an equality one. */
function isAgentPanel(tab: vscode.Tab | undefined, placement: AgentPlacement): boolean {
  const viewType = (tab?.input as { viewType?: unknown } | undefined)?.viewType;

  return typeof viewType === 'string' && viewType.includes(placement.webviewId);
}

function agentTabCount(placement: AgentPlacement): number {
  return vscode.window.tabGroups.all.reduce(
    (count, group) => count + group.tabs.filter((tab) => isAgentPanel(tab, placement)).length,
    0,
  );
}

function agentPanelActive(placement: AgentPlacement): boolean {
  return isAgentPanel(vscode.window.tabGroups.activeTabGroup.activeTab, placement);
}

/** Poll tabGroups because opening and revealing tabs update asynchronously; return as soon as the tab appears. */
async function watchForTab(before: number, placement: AgentPlacement): Promise<OpenOutcome> {
  for (let waited = 0; waited < VERIFY_TIMEOUT_MS; waited += POLL_MS) {
    if (verifyOpen(before, agentTabCount(placement), agentPanelActive(placement)) === 'opened') {
      return 'opened';
    }

    await delay(POLL_MS);
  }

  return verifyOpen(before, agentTabCount(placement), agentPanelActive(placement));
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
export async function agentExtensionReady(agent = 'claude'): Promise<boolean> {
  const placement = placementOf(agent);
  const extension = placement === null ? undefined : vscode.extensions.getExtension(placement.extensionId);

  if (!extension) {
    return false;
  }

  if (extension.isActive) {
    return true;
  }

  // Bound activation time so the open request cannot hang indefinitely.
  return Promise.race([
    extension.activate().then(() => true),
    delay(ACTIVATE_TIMEOUT_MS).then(() => false),
  ]).catch(() => false);
}

/** Match recorded roots using the workspace file, or first folder for single-folder windows (M21). */
export function boardRoot(): string | null {
  const file = vscode.workspace.workspaceFile;

  return (file?.scheme === 'file' ? file.fsPath : undefined) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

/** Launches a root's window, or says why it was not launched. Coming forward is `focusLeft`, and takes seconds. */
async function raise(root: string, newWindow = false): Promise<string | null> {
  // Reject a staged editor update: mismatched builds use different pipes and could launch a second editor
  // restoring every window (M49).
  const staged = stagedUpdate(process.execPath, vscode.env.appRoot);

  if (staged !== null) {
    return stagedUpdateRefusal(staged, vscode.version);
  }

  const failure = await runCode(newWindow ? ['--new-window', root] : [root]);

  return failure === null ? null : `Could not open a window on ${root}: ${failure}`;
}

/** Focuses whichever of the agent's views this VS Code registered; the other rejects rather than doing nothing. */
async function focusSidebar(placement: AgentPlacement): Promise<boolean> {
  for (const command of placement.sidebarFocusCommands) {
    try {
      await vscode.commands.executeCommand(command);

      return true;
    } catch {
      continue;
    }
  }

  return false;
}

/** Convert resources to Uri for vscode.open; preserve absent positional arguments as undefined. */
function commandArg(arg: CommandArg): unknown {
  switch (arg.kind) {
    case 'uri':
      return vscode.Uri.parse(arg.value);
    case 'text':
      return arg.value;
    case 'absent':
      return undefined;
  }
}

/**
 * Reveal through the agent command: Claude takes a session ID; Codex takes its custom-editor resource URI
 * (M44).
 */
async function revealHere(session: { agent: string; sessionId: string }): Promise<string | null> {
  const placement = placementOf(session.agent);

  if (placement === null) {
    return `Opening ${session.agent} sessions in VS Code is not supported.`;
  }

  const before = agentTabCount(placement);
  const { command, args } = placement.reveal(session.sessionId);

  try {
    await vscode.commands.executeCommand(command, ...args.map(commandArg));
  } catch (error) {
    return `${command} failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  return (await watchForTab(before, placement)) === 'opened'
    ? null
    : `The ${session.agent} extension reported the session open but no tab appeared.`;
}

/** Check the session location asynchronously after opening and report verified failures (mechanics M7). */
async function confirmLanding(roster: Roster, root: string, before: readonly Session[], expectedSessionId?: string): Promise<void> {
  for (let waited = 0; waited < LANDING_TIMEOUT_MS; waited += LANDING_POLL_MS) {
    await delay(LANDING_POLL_MS);

    const now = await roster();

    // An unreadable roster cannot establish an incorrect launch; stop verification without claiming a failure
    // (R24).
    if (now === null) {
      return;
    }

    const resumed = expectedSessionId && now.find((s) => s.sessionId === expectedSessionId && !s.finished);
    if (resumed && dirKey(resumed.cwd) === dirKey(root)) return;
    const stray = strayFrom(before, now, expectedSessionId);

    if (stray) {
      void vscode.window.showErrorMessage(
        `A session started in ${stray.cwd} instead of ${root} after focus changed. Close the new tab in ${stray.cwd}.`,
      );

      return;
    }
  }
  if (expectedSessionId) {
    void vscode.window.showWarningMessage('The resumed session did not appear in its working directory. Refresh the board and try again.');
  }
}

/** Focus the target window before sending its URI, then verify the resulting session placement (mechanics M7). */
async function revealElsewhere(roster: Roster, session: Session | HistoricalSession, root: string, resume?: { expiresAt: number; newWindow: boolean }): Promise<string | null> {
  if (resume && Date.now() >= resume.expiresAt) return 'This resume request expired. Refresh the board and try again.';

  const raised = await raise(root, resume?.newWindow);
  if (raised !== null) return raised;

  // Wait for this window to lose focus before delivering the focus-routed URI.
  if (!(await focusLeft(FOCUS_TIMEOUT_MS))) return `Could not focus the window on ${root}. The session was not opened.`;

  // Read the roster immediately before launch so sessions started since rendering are not misidentified as
  // unexpected launches.
  const before = await roster();
  if (resume) {
    const refusal = resumeRefusal(session.sessionId, before);
    if (refusal) return refusal;
    if (Date.now() >= resume.expiresAt) return 'This resume request expired before its window was ready. Refresh the board and try again.';
  }

  const placement = placementOf(session.agent);

  if (placement === null) {
    return `Opening ${session.agent} sessions in VS Code is not supported.`;
  }

  // Use the agent URI when supported, otherwise route through Ground Control in the target window (mechanics
  // M45).
  const fired = await runCode(['--open-url', placement.openUri?.(session.sessionId) ?? handOverUri(session.sessionId, session.agent)]);

  if (fired !== null) {
    return `The ${session.agent} session could not be opened in the window on ${root}: ${fired}`;
  }

  // Verify unexpected launches only with a successful baseline roster read.
  if (before !== null) {
    void confirmLanding(roster, root, before, resume ? session.sessionId : undefined);
  }

  return null;
}

/**
 * Execute a planned route in this extension host and return any user-visible failure. In-process commands
 * target this window; external URIs depend on focus (mechanics M7, M8). Keep the route switch exhaustive.
 */
export async function performRoute(plan: OpenRoute, roster: Roster): Promise<string | null> {
  switch (plan.route) {
    case 'resume-here': {
      if (dirKey(boardRoot() ?? '') !== dirKey(plan.root)) return 'The workspace changed before this session could be resumed. Refresh the board.';
      const before = await roster();
      const refusal = resumeRefusal(plan.session.sessionId, before);
      if (refusal) return refusal;
      if (Date.now() >= plan.expiresAt) return 'This resume request expired. Refresh the board and try again.';
      const failure = await revealHere(plan.session);
      if (!failure && before !== null) void confirmLanding(roster, plan.root, before, plan.session.sessionId);
      return failure;
    }

    case 'resume-elsewhere':
      return revealElsewhere(roster, plan.session, plan.root, plan);

    case 'reveal-here':
      return revealHere(plan.session);

    case 'reveal-elsewhere':
      return revealElsewhere(roster, plan.session, plan.root);

    case 'sidebar-here': {
      const placement = placementOf(plan.session.agent);

      if (placement === null || !(await focusSidebar(placement))) {
        return `Could not open the ${plan.session.agent} sidebar. Open it from the activity bar.`;
      }

      // Explain that sidebar records may be up to a minute old, so the revealed view may show another session
      // (mechanics M21).
      void vscode.window.showInformationMessage(
        `The ${plan.session.agent} sidebar should be showing ${sessionLabel(plan.session)}.`,
      );

      return null;
    }

    case 'sidebar-elsewhere': {
      const raised = await raise(plan.root);
      if (raised !== null) return raised;

      // The sidebar has no reveal-by-ID operation; opening its session in a panel would create a second
      // transcript writer (mechanics M11).
      void vscode.window.showInformationMessage(
        `${sessionLabel(plan.session)} is in the ${plan.session.agent} sidebar of the window on ${plan.root}.`,
      );

      return null;
    }

    case 'unknown-surface-here':
      void vscode.window.showInformationMessage(
        `${sessionLabel(plan.session)} is in this window, but its tab or sidebar is unknown. Locate it manually to avoid starting a duplicate session.`,
      );

      return null;

    case 'unknown-surface-elsewhere': {
      const raised = await raise(plan.root);
      if (raised !== null) return raised;

      void vscode.window.showInformationMessage(
        `${sessionLabel(plan.session)} is in the window on ${plan.root}, but its tab or sidebar is unknown. Locate it in that window.`,
      );

      return null;
    }

    case 'open-checkout':
      // Report the launch result only; no subsequent URI requires focus verification.
      return raise(plan.root, plan.newWindow);

    case 'start-session':
      return startHere(plan.agent, plan.root, plan.prompt);
  }
}

/**
 * Recheck the workspace before starting: the agent uses this window directory, which may have changed since
 * hub planning (mechanics M51).
 */
async function startHere(agent: string, root: string, prompt: string | null): Promise<string | null> {
  const placement = placementOf(agent);

  if (placement?.start === undefined) {
    return `Starting ${agent} sessions in VS Code is not supported.`;
  }

  if (dirKey(boardRoot() ?? '') !== dirKey(root)) {
    return `This window is no longer on ${root}. Refresh the board and try again.`;
  }

  const { command, args } = placement.start(prompt);

  try {
    await vscode.commands.executeCommand(command, ...args.map(commandArg));
  } catch (error) {
    return `${command} failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  // Tab state cannot verify a new session: Claude can reuse the primary editor, and an already-active panel
  // satisfies agentPanelActive without a start.
  return null;
}

/** Offer settings access for refusals resolved by configuration (R34). */
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

/** Track pending opens to suppress duplicate clicks. */
const opening = new Set<string>();

/**
 * Execute one route per session or card. Duplicate opens could create concurrent transcript writers or
 * duplicate checkout windows (mechanics M11).
 */
export async function perform(route: OpenRoute, roster: Roster): Promise<void> {
  const held = routeKey(route);

  if (opening.has(held)) {
    return;
  }

  opening.add(held);

  try {
    const failure = await performRoute(route, roster);

    if (failure) {
      void vscode.window.showErrorMessage(failure);
    }
  } finally {
    opening.delete(held);
  }
}
