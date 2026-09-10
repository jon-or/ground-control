import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dirKey, routeKey, sessionLabel } from '@ground-control/core';
import type { HistoricalSession, OpenOutcome, OpenRefusal, OpenRoute, Session } from '@ground-control/core';
import { PLACEMENTS, handOverUri, resumeRefusal, stagedUpdate, stagedUpdateRefusal, strayFrom, verifyOpen, worktreePointer } from '@ground-control/host-vscode';
import type { AgentPlacement, CommandArg } from '@ground-control/host-vscode';
import { spawnEnvironment } from '@ground-control/hub';
import { routeAllowed, sessionAllowed } from './sessionScope.js';
import type { SessionChecker } from './sessionScope.js';
import { editorProfileRefusal } from './agentStorage.js';

const SCOPE_REFUSAL = 'This work is hidden by the current session settings. Refresh the board.';

async function checkSession(session: Session | HistoricalSession, root: string, history: boolean, check: SessionChecker): Promise<string | null> {
  const checked = await check(session.sessionId);
  if (!sessionAllowed(session, history, root) || checked?.allowed === false) return SCOPE_REFUSAL;
  if (!checked) return 'Live sessions could not be checked. Refresh the board and try again.';
  const profile = editorProfileRefusal(session.agent, checked.agentHome);
  if (profile) return profile;
  return (history ? !checked.targetActive && !checked.cardActive : checked.targetActive)
    ? null : 'This session can no longer be opened safely. Refresh the board.';
}

/** Resident operations supported by each agent (M43). Own keys only: a link can name `constructor`. */
function placementOf(agent: string): AgentPlacement | null {
  return Object.hasOwn(PLACEMENTS, agent) ? PLACEMENTS[agent] ?? null : null;
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
  const env = spawnEnvironment();

  // A launched window would inherit a held redirect for its whole life. Dropping the project directory alone
  // disables it and keeps a configuration directory the developer set (R44).
  if (pointing) {
    delete env['CLAUDE_CODE_PROJECT_DIR_NAME'];
  }

  return new Promise((resolve) => {
    execFile(process.execPath, [join(vscode.env.appRoot, 'out', 'cli.js'), ...args], {
      env, windowsHide: true, timeout: 20_000,
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

/** Hold the override past the tab so the panel reads the worktree's sessions, and no longer (M52). */
const PROJECT_DIR_SETTLE_MS = 2000;

function assign(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

/** One redirect at a time: overlapping holds would restore each other's values and leak the override. */
let pointing = false;

/** Longer than a hold, which is bounded by the tab plus the settle delay. */
const POINTER_WAIT_MS = 8000;

const POINTER_BUSY = 'Another worktree session is still opening in this window. Refresh the board and try again.';

/** Wait out a redirect rather than refusing: a resume has seconds of deadline to spend. */
async function pointerFree(): Promise<boolean> {
  for (let waited = 0; pointing && waited < POINTER_WAIT_MS; waited += POLL_MS) {
    await delay(POLL_MS);
  }

  return !pointing;
}

/**
 * Point Claude's project directory at a worktree so this window lists its session, and return how to put it
 * back. The Claude extension shares this host and reads these on each list, by resolved path (M52).
 */
function pointAtWorktree(sessionId: string, worktree: string): { restore: () => void } | string {
  // Callers wait for a hold, then await a roster read, so re-check before assigning.
  if (pointing) {
    return POINTER_BUSY;
  }

  let checkout;

  try {
    checkout = realpathSync(worktree);
  } catch {
    return `${worktree} is not readable. Its session cannot be resumed from another window.`;
  }

  const pointer = worktreePointer(sessionId, checkout, homedir(), process.env, existsSync);

  if (typeof pointer === 'string') {
    return pointer;
  }

  const previous = Object.fromEntries(Object.keys(pointer).map((name) => [name, process.env[name]]));

  pointing = true;
  Object.assign(process.env, pointer);

  return {
    restore: () => {
      for (const [name, value] of Object.entries(previous)) {
        assign(name, value);
      }

      pointing = false;
    },
  };
}

/**
 * Reveal through the agent command: Claude takes a session ID; Codex takes its custom-editor resource URI
 * (M44). `worktree` resumes a session whose checkout is not this window's folder (R44).
 */
async function revealHere(session: { agent: string; sessionId: string }, worktree?: string): Promise<string | null> {
  const placement = placementOf(session.agent);

  if (placement === null) {
    return `Opening ${session.agent} sessions in VS Code is not supported.`;
  }

  const pointer = worktree === undefined ? null : pointAtWorktree(session.sessionId, worktree);

  if (typeof pointer === 'string') {
    return pointer;
  }

  // Restore whatever the reveal does, including a throw before the command is built.
  try {
    return await reveal(session, placement, pointer !== null);
  } finally {
    pointer?.restore();
  }
}

async function reveal(
  session: { agent: string; sessionId: string },
  placement: AgentPlacement,
  redirected: boolean,
): Promise<string | null> {
  const before = agentTabCount(placement);
  const { command, args } = placement.reveal(session.sessionId);

  try {
    await vscode.commands.executeCommand(command, ...args.map(commandArg));
  } catch (error) {
    return `${command} failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  const outcome = await watchForTab(before, placement);

  // The panel reads its list after the tab appears, so restoring at the tab is too early.
  if (outcome === 'opened' && redirected) {
    await delay(PROJECT_DIR_SETTLE_MS);
  }

  return outcome === 'opened' ? null : `The ${session.agent} extension reported the session open but no tab appeared.`;
}

/**
 * Check the session location asynchronously after opening and report verified failures (mechanics M7). `cwd`
 * is where the session must run, which is the worktree rather than the window folder for a redirect (R44).
 */
async function confirmLanding(roster: Roster, cwd: string, before: readonly Session[], expectedSessionId?: string): Promise<void> {
  for (let waited = 0; waited < LANDING_TIMEOUT_MS; waited += LANDING_POLL_MS) {
    await delay(LANDING_POLL_MS);

    const now = await roster();

    // An unreadable roster cannot establish an incorrect launch; stop verification without claiming a failure
    // (R24).
    if (now === null) {
      return;
    }

    const resumed = expectedSessionId && now.find((s) => s.sessionId === expectedSessionId && !s.finished);
    if (resumed && dirKey(resumed.cwd) === dirKey(cwd)) return;
    const stray = strayFrom(before, now, expectedSessionId);

    if (stray) {
      void vscode.window.showErrorMessage(
        `A session started in ${stray.cwd} instead of ${cwd} after focus changed. Close the new tab in ${stray.cwd}.`,
      );

      return;
    }
  }
  if (expectedSessionId) {
    void vscode.window.showWarningMessage('The resumed session did not appear in its working directory. Refresh the board and try again.');
  }
}

/** Focus the target window before sending its URI, then verify the resulting session placement (mechanics M7). */
async function revealElsewhere(roster: Roster, check: SessionChecker, session: Session | HistoricalSession, root: string, resume?: { expiresAt: number; newWindow: boolean; resumeToken?: string; worktree?: string }): Promise<string | null> {
  if (!sessionAllowed(session, resume !== undefined, root)) return SCOPE_REFUSAL;
  if (resume && Date.now() >= resume.expiresAt) return 'This resume request expired. Refresh the board and try again.';

  const raised = await raise(root, resume?.newWindow);
  if (!sessionAllowed(session, resume !== undefined, root)) return SCOPE_REFUSAL;
  if (raised !== null) return raised;

  // Wait for this window to lose focus before delivering the focus-routed URI.
  const left = await focusLeft(FOCUS_TIMEOUT_MS);
  if (!sessionAllowed(session, resume !== undefined, root)) return SCOPE_REFUSAL;
  if (!left) return `Could not focus the window on ${root}. The session was not opened.`;

  // Read the roster immediately before launch so sessions started since rendering are not misidentified as
  // unexpected launches.
  const before = await roster();
  const checked = await checkSession(session, root, resume !== undefined, check);
  if (checked) return checked;
  if (resume) {
    const refusal = resumeRefusal(session.sessionId, before);
    if (refusal) return refusal;
    if (Date.now() >= resume.expiresAt) return 'This resume request expired before its window was ready. Refresh the board and try again.';
  }

  const placement = placementOf(session.agent);

  if (placement === null) {
    return `Opening ${session.agent} sessions in VS Code is not supported.`;
  }

  // The target resident must check its own agent profile before executing an editor command.
  const fired = await runCode(['--open-url', handOverUri(session.sessionId, session.agent, resume?.resumeToken, vscode.env.uriScheme)]);

  if (fired !== null) {
    return `The ${session.agent} session could not be opened in the window on ${root}: ${fired}`;
  }

  // Verify unexpected launches only with a successful baseline roster read.
  if (before !== null) {
    void confirmLanding(roster, resume?.worktree ?? root, before, resume ? session.sessionId : undefined);
  }

  return null;
}

/**
 * Execute a planned route in this extension host and return any user-visible failure. In-process commands
 * target this window; external URIs depend on focus (mechanics M7, M8). Keep the route switch exhaustive.
 */
export async function performRoute(plan: OpenRoute, roster: Roster, check: SessionChecker): Promise<string | null> {
  const failure = await performAllowedRoute(plan, roster, check);
  return failure !== null && !routeAllowed(plan) ? SCOPE_REFUSAL : failure;
}

async function performAllowedRoute(plan: OpenRoute, roster: Roster, check: SessionChecker): Promise<string | null> {
  if (!routeAllowed(plan)) return SCOPE_REFUSAL;
  if (plan.route === 'start-session') {
    const profile = editorProfileRefusal(plan.agent, plan.agentHome);
    if (profile) return profile;
  }
  if ('session' in plan) {
    const checked = await checkSession(plan.session, plan.root, plan.route.startsWith('resume-'), check);
    if (checked) return checked;
  }
  switch (plan.route) {
    case 'resume-here': {
      if (dirKey(boardRoot() ?? '') !== dirKey(plan.root)) return 'The workspace changed before this session could be resumed. Refresh the board.';
      // Wait before the deadline check, so waiting cannot push the reveal past it.
      if (plan.worktree !== undefined && !(await pointerFree())) {
        return POINTER_BUSY;
      }
      const before = await roster();
      const checked = await checkSession(plan.session, plan.root, true, check);
      if (checked) return checked;
      const refusal = resumeRefusal(plan.session.sessionId, before);
      if (refusal) return refusal;
      if (Date.now() >= plan.expiresAt) return 'This resume request expired. Refresh the board and try again.';
      const failure = await revealHere(plan.session, plan.worktree);
      if (!failure && before !== null) void confirmLanding(roster, plan.worktree ?? plan.root, before, plan.session.sessionId);
      return failure;
    }

    case 'resume-elsewhere':
      return revealElsewhere(roster, check, plan.session, plan.root, plan);

    case 'reveal-here':
      return revealHere(plan.session);

    case 'reveal-elsewhere':
      return revealElsewhere(roster, check, plan.session, plan.root);

    case 'sidebar-here': {
      const placement = placementOf(plan.session.agent);

      const focused = placement !== null && await focusSidebar(placement);
      if (!routeAllowed(plan)) return SCOPE_REFUSAL;
      if (!focused) {
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
      if (!routeAllowed(plan)) return SCOPE_REFUSAL;
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
      if (!routeAllowed(plan)) return SCOPE_REFUSAL;
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
 * Recheck the workspace and the agent extension before starting: the agent uses this window directory, which
 * may have changed since hub planning, and a browser request states neither (mechanics M51).
 */
async function startHere(agent: string, root: string, prompt: string | null): Promise<string | null> {
  const placement = placementOf(agent);

  if (placement?.start === undefined) {
    return `Starting ${agent} sessions in VS Code is not supported.`;
  }

  if (dirKey(boardRoot() ?? '') !== dirKey(root)) {
    return `This window is no longer on ${root}. Refresh the board and try again.`;
  }

  // A browser request carries no readiness, and this window is the one that needs the extension (M51).
  // Last, because it can spend the activation timeout on a start the free checks above would have refused.
  if (!(await agentExtensionReady(agent))) {
    return `The ${agent} extension is not available. Install it, or reload the window if it already is.`;
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
export async function perform(route: OpenRoute, roster: Roster, check: SessionChecker): Promise<void> {
  const held = routeKey(route);

  if (opening.has(held)) {
    return;
  }

  opening.add(held);

  try {
    const failure = await performRoute(route, roster, check);

    if (failure) {
      void vscode.window.showErrorMessage(failure);
    }
  } finally {
    opening.delete(held);
  }
}
