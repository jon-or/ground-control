import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { dirKey, routeKey, sessionLabel } from '@ground-control/core';
import type { HistoricalSession, OpenOutcome, OpenRefusal, OpenRoute, Session } from '@ground-control/core';
import { PLACEMENTS, handOverUri, resumeRefusal, stagedUpdate, stagedUpdateRefusal, strayFrom, verifyOpen } from '@ground-control/host-vscode';
import type { AgentPlacement, CommandArg } from '@ground-control/host-vscode';
import { spawnEnvironment } from '@ground-control/hub';

/** How a session's own agent is reached here. An agent with no row is one this host was never taught (§43). */
function placementOf(agent: string): AgentPlacement | null {
  return PLACEMENTS[agent] ?? null;
}
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

/**
 * Use this editor's CLI directly: a saved directory is an argument, never shell source. The environment is the hub's
 * sanitized one — `VSCODE_NLS_CONFIG` and `VSCODE_CODE_CACHE_PATH` name the build this window runs, and `cli.js` hands whatever it was given to the editor it launches (§49).
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

/**
 * Polled rather than slept on. A new tab and a reveal both reach `tabGroups` over an async event, so an immediate read
 * sees neither; polling also returns as soon as the tab is there instead of always paying the whole timeout.
 */
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

/** Launches a root's window, or says why it was not launched. Coming forward is `focusLeft`, and takes seconds. */
async function raise(root: string, newWindow = false): Promise<string | null> {
  // A staged update swaps the executable under windows still running the old build, and the two then look for
  // different pipes: the launch would start a second editor and restore every window into it (§49).
  const staged = stagedUpdate(process.execPath, vscode.env.appRoot);

  if (staged !== null) {
    return stagedUpdateRefusal(staged, vscode.version);
  }

  const failure = await runCode(newWindow ? ['--new-window', root] : [root]);

  return failure === null ? null : `The window on ${root} could not be opened: ${failure}`;
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

/**
 * One argument of a placement's command, as VS Code has to receive it. `vscode.open` rejects a string whose scheme
 * is not http or https, so a resource arrives as a `Uri`; `absent` is a positional gap and stays `undefined`.
 */
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
 * Reveals a session in this window. The call is the agent's own: Claude takes a session id, and Codex takes the
 * resource URI its extension registered a custom editor for — the same call that extension makes on itself (§44).
 */
async function revealHere(session: { agent: string; sessionId: string }): Promise<string | null> {
  const placement = placementOf(session.agent);

  if (placement === null) {
    return `The board does not know how to open a ${session.agent} session in VS Code.`;
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

  const raised = await raise(root, resume?.newWindow);
  if (raised !== null) return raised;

  // The URI reaches whichever window has focus, so this one losing it is the only proof the fire will land there.
  if (!(await focusLeft(FOCUS_TIMEOUT_MS))) return `Could not bring the window on ${root} forward, so nothing was opened.`;

  // Read here rather than taken from the render: anything already running when the fire went out is the developer's
  // own work, and reporting it as a stray would tell them to close a session they had just started themselves.
  const before = await roster();
  if (resume) {
    const refusal = resumeRefusal(session.sessionId, before);
    if (refusal) return refusal;
    if (Date.now() >= resume.expiresAt) return 'This resume request expired before its window was ready. Refresh the board and try again.';
  }

  const placement = placementOf(session.agent);

  if (placement === null) {
    return `The board does not know how to open a ${session.agent} session in VS Code.`;
  }

  // The agent's own URI where it answers one, and the board's own where it does not: a raised window runs Ground
  // Control too, so it can be handed the session and reveal it itself (`docs/mechanics.md` §45).
  const fired = await runCode(['--open-url', placement.openUri?.(session.sessionId) ?? handOverUri(session.sessionId, session.agent)]);

  if (fired !== null) {
    return `The ${session.agent} session could not be opened in the window on ${root}: ${fired}`;
  }

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
        return `The ${plan.session.agent} sidebar would not come forward. Open it from the activity bar.`;
      }

      // Said out loud because the sidebar shows one session and the record of which is up to a minute old: the view
      // that comes forward may be showing different work than the row that was clicked (`docs/mechanics.md` §21).
      void vscode.window.showInformationMessage(
        `The ${plan.session.agent} sidebar should be showing ${sessionLabel(plan.session)}.`,
      );

      return null;
    }

    case 'sidebar-elsewhere': {
      const raised = await raise(plan.root);
      if (raised !== null) return raised;

      // Nothing else is safe: the sidebar has no reveal-by-id, and opening a panel for a session it already holds is
      // a second process on one transcript (`docs/mechanics.md` §11).
      void vscode.window.showInformationMessage(
        `${sessionLabel(plan.session)} is in the ${plan.session.agent} sidebar of the window on ${plan.root}.`,
      );

      return null;
    }

    case 'unknown-surface-here':
      void vscode.window.showInformationMessage(
        `${sessionLabel(plan.session)} is somewhere in this window. VS Code has not recorded which tab or sidebar holds it, and guessing would run a second agent on it.`,
      );

      return null;

    case 'unknown-surface-elsewhere': {
      const raised = await raise(plan.root);
      if (raised !== null) return raised;

      void vscode.window.showInformationMessage(
        `${sessionLabel(plan.session)} is in the window on ${plan.root}. VS Code has not recorded which tab or sidebar holds it, so this is as close as the board can take you.`,
      );

      return null;
    }

    case 'open-checkout':
      // Whatever `raise` says and nothing more: no URI follows this, so there is no focus to wait for, and nothing
      // inside a window records which folder a board asked for. What the developer sees is the window itself.
      return raise(plan.root, plan.newWindow);

    case 'start-session':
      return startHere(plan.agent, plan.root, plan.prompt);
  }
}

/**
 * Starts a new session in this window. The workspace is re-read because the hub planned this against a hello that
 * may be a folder change old, and the agent takes its directory from this window rather than from anything the
 * board hands it (`docs/mechanics.md` §51) — so a stale plan would start the session in the wrong checkout.
 */
async function startHere(agent: string, root: string, prompt: string | null): Promise<string | null> {
  const placement = placementOf(agent);

  if (placement?.start === undefined) {
    return `The board does not know how to start a ${agent} session in VS Code.`;
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

  // No landing check, for the reason `open-checkout` has none: neither signal `verifyOpen` reads distinguishes a
  // session that was minted from a surface that was already there. Claude's start reuses the primary editor's
  // existing tab, so a new tab is not required; and an agent whose panel is already the active tab satisfies
  // `agentPanelActive` without anything having happened. What the developer sees is the composer.
  return null;
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

/** What is being opened, so a second click on something already on its way is dropped rather than repeated. */
const opening = new Set<string>();

/**
 * Carries out a route the hub planned, and says what went wrong when it did not land. One at a time per session,
 * or per card where a route has no session: a second fire at a tab already on its way is a second agent on one
 * transcript (`docs/mechanics.md` §11), and a second `code` on one checkout is a second window.
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
