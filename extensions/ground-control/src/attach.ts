import * as vscode from 'vscode';
import { agentCommand, sessionLabel } from '@ground-control/core';
import type { Session } from '@ground-control/core';

/**
 * Opens a detached run in a terminal. `attach` and not a tab: opening a session as a tab resumes it, which the CLI
 * refuses while the run's own process still holds the conversation — that process exits 1 and the panel shows its
 * stderr (`docs/mechanics.md` §33). Closing the terminal leaves the run going, as attach does.
 *
 * Called by the row on the board and by the `/attach` URI a row in the browser navigates to.
 */
export function attachTo(session: Session): boolean {
  // The shape both boards check rather than a null test: a snapshot can outlive the hub version that wrote it, and
  // a roster read is a cast rather than a parse, so an absent id must not reach the argument list.
  if (typeof session.attachId !== 'string' || session.attachId === '') {
    return false;
  }

  // The same map the hub is configured from, read here rather than carried, and resolved by the same rule (R30).
  const configured = vscode.workspace.getConfiguration('groundControl').get<Record<string, string>>('agents', {});

  // `shellPath` and not `sendText`: the CLI is the terminal's own process, so a configured path with spaces in it is
  // one argument rather than two tokens for a shell to mis-split.
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
