import * as vscode from 'vscode';
import { bootstrapDirOf, dirKey, resolveStateDir } from '@ground-control/core';
import { realRelocationDeps, recoverRelocation, relocateState, relocationTarget } from '@ground-control/hub';
import type { Relocation } from '@ground-control/hub';
import { SECTION } from './config.js';
import type { HubClient } from './hubClient.js';
import { boardLog } from './logging.js';

export const STATE_DIRECTORY_KEY = 'stateDirectory';

let inFlight: Promise<void> | undefined;
let requestedAgain = false;

/** Clear a migration nobody is performing before this window connects, and tell the developer what was left behind. */
export function recoverStateDirectory(home: string): void {
  const message = recoverRelocation(home);

  if (message !== null) {
    boardLog().warn(message);
    void vscode.window.showWarningMessage(message);
  }
}

/**
 * Move the state when the setting names a different directory than the pointer. The setting stays truthful:
 * a refused or failed move restores it to the directory in use. On activation an unset setting adopts the
 * pointer's directory instead of moving, because each VS Code profile has its own settings file.
 */
export function reconcileStateDirectory(home: string, client: HubClient, activating = false): Promise<void> {
  if (inFlight) {
    // A setting changed during a move; evaluate the final value once the move settles.
    requestedAgain = true;

    return inFlight;
  }

  inFlight = reconcile(home, client, activating)
    .catch((error: unknown) => {
      boardLog().error(`state directory reconciliation failed: ${String(error)}`);
      void vscode.window.showErrorMessage(`Ground Control could not apply the state directory setting: ${String(error)}`);
    })
    .finally(() => {
      inFlight = undefined;

      if (requestedAgain) {
        requestedAgain = false;
        void reconcileStateDirectory(home, client);
      }
    });

  return inFlight;
}

async function reconcile(home: string, client: HubClient, activating: boolean): Promise<void> {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  const setting = configuration.inspect<string>(STATE_DIRECTORY_KEY)?.globalValue;
  const resolved = resolveStateDir(home);
  const current = resolved.stateDir;

  if (resolved.problem !== null) {
    boardLog().error(resolved.problem);
    void vscode.window.showErrorMessage(`${resolved.problem} Fix or delete it in ${bootstrapDirOf(home)}; the hub will not start until then.`);

    return;
  }

  if (activating && setting === undefined && dirKey(current) !== dirKey(bootstrapDirOf(home))) {
    boardLog().info(`state directory setting adopted from the pointer: ${current}`);
    await configuration.update(STATE_DIRECTORY_KEY, current, vscode.ConfigurationTarget.Global);

    return;
  }

  const target = relocationTarget(home, setting ?? '');

  if ('refused' in target) {
    await revert(home, current, target.refused);

    return;
  }

  if (dirKey(target.stateDir) === dirKey(current)) {
    return;
  }

  boardLog().info(`moving Ground Control state from ${current} to ${target.stateDir}`);

  client.suspend();

  let result: Relocation;

  try {
    result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Moving Ground Control state to ${target.stateDir}` },
      () => relocateState(target.stateDir, realRelocationDeps(home)),
    );
  } catch (error) {
    result = { failed: `The move stopped unexpectedly: ${String(error)} Check ${bootstrapDirOf(home)} and both directories before retrying.` };
  } finally {
    // Discovery after the move follows the new pointer.
    client.resume();
  }

  if ('busy' in result) {
    boardLog().info('another window is moving the state directory');

    return;
  }

  if ('refused' in result || 'failed' in result) {
    await revert(home, current, 'refused' in result ? result.refused : result.failed);

    return;
  }

  const leftover = result.leftover.length === 0 ? '' : ` ${result.leftover.length} entries could not be removed from ${current}.`;

  boardLog().info(`Ground Control state moved to ${result.stateDir}${leftover}`);
  void vscode.window.showInformationMessage(`Ground Control state moved to ${result.stateDir}.${leftover}`);
}

/** Restore the setting to the directory actually in use and report why the requested one was not adopted. */
async function revert(home: string, current: string, why: string): Promise<void> {
  const value = dirKey(current) === dirKey(bootstrapDirOf(home)) ? undefined : current;

  boardLog().error(`state directory unchanged: ${why}`);
  await vscode.workspace.getConfiguration(SECTION).update(STATE_DIRECTORY_KEY, value, vscode.ConfigurationTarget.Global);
  void vscode.window.showErrorMessage(`Ground Control state stays in ${current}. ${why}`);
}
