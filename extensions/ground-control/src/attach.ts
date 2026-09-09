import * as vscode from 'vscode';
import { agentCommand, sessionLabel } from '@ground-control/core';
import type { Session } from '@ground-control/core';

/**
 * Attach in a terminal from either board. Resuming an active run in an editor tab starts a second process that
 * exits 1 (mechanics M33). Closing the terminal leaves the run active.
 */
export function attachTo(session: Session): boolean {
  // Validate attachId before building arguments; cached snapshots and cast roster responses may omit it.
  if (typeof session.attachId !== 'string' || session.attachId === '') {
    return false;
  }

  // The same map the hub is configured from, read here rather than carried, and resolved by the same rule (R30).
  const configured = vscode.workspace.getConfiguration('groundControl').get<Record<string, string>>('agents', {});

  // Use shellPath so the configured executable runs directly, including paths with spaces.
  vscode.window
    .createTerminal({
      name: sessionLabel(session),
      cwd: session.cwd,
      shellPath: agentCommand(configured, session.agent),
      shellArgs: ['attach', session.attachId],
    })
    .show();

  return true;
}
