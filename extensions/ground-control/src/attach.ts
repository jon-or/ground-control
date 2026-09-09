import * as vscode from 'vscode';
import { agentCommand, sessionLabel } from '@ground-control/core';
import type { Session } from '@ground-control/core';
import { sessionAllowed } from './sessionScope.js';
import type { SessionChecker } from './sessionScope.js';
import { attachEnvironment } from './agentStorage.js';

/**
 * Attach in a terminal from either board. Resuming an active run in an editor tab starts a second process that
 * exits 1 (mechanics M33). Closing the terminal leaves the run active.
 */
export async function attachTo(session: Session, check: SessionChecker): Promise<boolean> {
  // Validate attachId before building arguments; cached snapshots and cast roster responses may omit it.
  if (typeof session.attachId !== 'string' || session.attachId === '' || !sessionAllowed(session)) {
    return false;
  }

  const checked = await check(session.sessionId);
  if (!checked?.allowed || !checked.targetActive || !sessionAllowed(session)) return false;
  const env = attachEnvironment(session.agent, checked.agentHome);
  if (env === null) return false;

  // The same map the hub is configured from, read here rather than carried, and resolved by the same rule (R30).
  const configured = vscode.workspace.getConfiguration('groundControl').get<Record<string, string>>('agents', {});

  // Use shellPath so the configured executable runs directly, including paths with spaces.
  vscode.window
    .createTerminal({
      name: sessionLabel(session),
      cwd: session.cwd,
      shellPath: agentCommand(configured, session.agent),
      shellArgs: ['attach', session.attachId],
      env,
    })
    .show();

  return true;
}
