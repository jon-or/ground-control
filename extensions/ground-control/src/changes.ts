import * as vscode from 'vscode';
import { findCheckout, readTextFromDisk } from '@ground-control/core';
import { changesPlan, noRepository, repositoryRefusal } from '@ground-control/host-vscode';
import type { ChangedPath, DiffSide } from '@ground-control/host-vscode';
import { GitStatus, gitApi, gitUri } from './gitApi.js';
import type { GitChange, GitRepository } from './gitApi.js';

/**
 * Where a branch is taken to have forked from, tried in order. `origin/HEAD` is the remote's own answer and is set
 * by a clone; the two names are what a repository without it is almost always using.
 */
const BASE_REFS = ['origin/HEAD', 'origin/main', 'origin/master'];

/**
 * A conflicted file is work in progress and belongs in the editor, so every conflict state reads as a modification
 * rather than being dropped. Only an ignored file is left out — it is not what the branch did.
 */
function kindOf(status: number): ChangedPath['kind'] | null {
  switch (status) {
    case GitStatus.INDEX_ADDED:
    case GitStatus.UNTRACKED:
    case GitStatus.INTENT_TO_ADD:
    // A copy is a new file. Following it back to its source would put the source on the left and claim the branch
    // changed a file it never touched.
    case GitStatus.INDEX_COPIED:
    case GitStatus.BOTH_ADDED:
    case GitStatus.ADDED_BY_US:
    case GitStatus.ADDED_BY_THEM:
      return 'added';
    case GitStatus.INDEX_DELETED:
    case GitStatus.DELETED:
    case GitStatus.BOTH_DELETED:
    case GitStatus.DELETED_BY_US:
    case GitStatus.DELETED_BY_THEM:
      return 'deleted';
    case GitStatus.IGNORED:
      return null;
    default:
      return 'modified';
  }
}

/** Only a rename carries the name the file had going in; a copy's original is a different file that still exists. */
function renamedFrom(change: GitChange): string | null {
  const renamed = change.status === GitStatus.INDEX_RENAMED || change.status === GitStatus.INTENT_TO_RENAME;
  const from = change.originalUri.fsPath;

  return renamed && from !== change.uri.fsPath ? from : null;
}

function changedPaths(changes: readonly GitChange[]): ChangedPath[] {
  const paths: ChangedPath[] = [];

  for (const change of changes) {
    const kind = kindOf(change.status);

    if (kind === null) {
      continue;
    }

    const from = renamedFrom(change);

    paths.push(from === null ? { path: change.uri.fsPath, kind } : { path: change.uri.fsPath, kind, from });
  }

  return paths;
}

/** The first ref that shares an ancestor with HEAD. A repository with no remote, or an unrelated history, has none. */
async function mergeBase(repository: GitRepository): Promise<string | null> {
  for (const ref of BASE_REFS) {
    try {
      const base = await repository.getMergeBase('HEAD', ref);

      if (base) {
        return base;
      }
    } catch {
      // A ref this repository does not have. `getBranchBase` would answer in one call, but it writes
      // `branch.<name>.vscode-merge-base` into the checkout's config, and looking at work must not change it.
    }
  }

  return null;
}

function sideUri(side: DiffSide | null): vscode.Uri | undefined {
  if (side === null) {
    return undefined;
  }

  return side.ref === null ? vscode.Uri.file(side.path) : gitUri(side.path, side.ref);
}

/**
 * The card action, as a command. Not contributed, so it is not in the palette — it takes a checkout, a name and the
 * card it came from, which only the board has. It is a command rather than a call because `test-integration/`
 * reaches the extension host no other way, and what this rides on can only be settled inside a real one.
 */
export const OPEN_CHANGES = 'groundControl.openChanges';

export function registerChangesCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(OPEN_CHANGES, (cwd: string, label: string, key: string) =>
    openChanges(cwd, label, key),
  );
}

/**
 * Everything a card's checkout has done to its files — its commits and its uncommitted work in one editor, the
 * merge base on the left and the working tree on the right. Assembled because no built-in command produces that
 * set; the shape of it is `changesPlan`'s, and this only fetches and opens.
 *
 * Every failure says so. A control that quietly does nothing is the state R25 exists to prevent, and half of what
 * this calls is private to VS Code and can go with an update (`docs/mechanics.md` §30).
 */
export async function openChanges(cwd: string, label: string, key: string): Promise<void> {
  try {
    await open(cwd, label, key);
  } catch (error) {
    void vscode.window.showErrorMessage(`${label}: the board could not open its changes — ${String(error)}`);
  }
}

async function open(cwd: string, label: string, key: string): Promise<void> {
  const checkout = findCheckout(cwd, readTextFromDisk);

  if (!checkout) {
    void vscode.window.showWarningMessage(`${label} is running in ${cwd}, which is not inside a Git checkout.`);

    return;
  }

  const api = await gitApi();

  if (!api) {
    void vscode.window.showWarningMessage('The Git extension is disabled in this window, so the board cannot show changes.');

    return;
  }

  const root = vscode.Uri.file(checkout.root);

  // A worktree is rarely in the window's own folder, so it is opened as a repository first — which leaves it in the
  // Source Control view. The command takes a path rather than a URI: it is registered without repository
  // resolution and passes its argument through raw.
  await vscode.commands.executeCommand('git.openRepository', root.fsPath);

  const repository = api.getRepository(root);

  if (repository === null) {
    void vscode.window.showWarningMessage(noRepository(root.fsPath));

    return;
  }

  const refusal = repositoryRefusal(root.fsPath, repository.rootUri.fsPath);

  if (refusal !== null) {
    void vscode.window.showWarningMessage(refusal);

    return;
  }

  // A repository VS Code has just opened has not read its own status yet, and its resource groups are empty until
  // it has — measured, and it is the uncommitted half of the editor that would silently go missing (§30).
  await repository.status();

  const base = await mergeBase(repository);
  const committed = base === null ? [] : changedPaths(await repository.diffBetween(base, 'HEAD'));
  const state = repository.state;
  const plan = changesPlan({
    label,
    base,
    committed,
    staged: changedPaths(state.indexChanges),
    // Under the default `git.untrackedChanges` the untracked group is empty and its files are in the working tree
    // group; under `separate` it is the only place they appear. Under `hidden` there are none and the editor is
    // short by them — the setting says not to show them, and the board does not overrule it.
    working: changedPaths([...state.workingTreeChanges, ...state.untrackedChanges]),
  });

  if ('refusal' in plan) {
    void vscode.window.showInformationMessage(plan.message);

    return;
  }

  await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
    // The card, not only the checkout: two cards on one clone would otherwise reveal each other's editor.
    multiDiffSourceUri: vscode.Uri.from({ scheme: 'ground-control-changes', path: `${key}/${checkout.root}` }),
    title: plan.title,
    resources: plan.rows.map((row) => ({ originalUri: sideUri(row.original), modifiedUri: sideUri(row.modified) })),
  });
}
