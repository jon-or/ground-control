import * as vscode from 'vscode';
import { findCheckout, readTextFromDisk } from '@ground-control/core';
import { changesPlan, noRepository, repositoryRefusal } from '@ground-control/host-vscode';
import type { ChangedPath, DiffSide } from '@ground-control/host-vscode';
import { GitStatus, gitApi, gitUri } from './gitApi.js';
import type { GitChange, GitRepository } from './gitApi.js';

/** Try origin/HEAD, then common default branches, when finding the branch base. */
const BASE_REFS = ['origin/HEAD', 'origin/main', 'origin/master'];

/** Treat conflicts as modifications so they appear in the diff. Exclude ignored files. */
function kindOf(status: number): ChangedPath['kind'] | null {
  switch (status) {
    case GitStatus.INDEX_ADDED:
    case GitStatus.UNTRACKED:
    case GitStatus.INTENT_TO_ADD:
    // Treat copies as additions; the source file still exists unchanged.
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
      // Try the next ref. Avoid getBranchBase because it writes branch.<name>.vscode-merge-base to checkout
      // config.
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
 * Register an internal command for the board and real-host tests. It requires card context, so it is not in
 * the command palette.
 */
export const OPEN_CHANGES = 'groundControl.openChanges';

export function registerChangesCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(OPEN_CHANGES, (cwd: string, label: string, key: string) =>
    openChanges(cwd, label, key),
  );
}

/**
 * Fetch the committed and uncommitted resources from changesPlan and open one multi-diff. Report failures from
 * the private VS Code APIs; recheck their contracts after upgrades (mechanics M30).
 */
export async function openChanges(cwd: string, label: string, key: string): Promise<void> {
  try {
    await open(cwd, label, key);
  } catch (error) {
    void vscode.window.showErrorMessage(`${label}: could not open changes: ${String(error)}`);
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
    void vscode.window.showWarningMessage('Enable the Git extension to view changes.');

    return;
  }

  const root = vscode.Uri.file(checkout.root);

  // Open the worktree repository in Source Control first. The Git command takes a raw path, not a URI.
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

  // Wait for Git status before reading resource groups; newly opened repositories initially omit uncommitted
  // changes (M30).
  await repository.status();

  const base = await mergeBase(repository);
  const committed = base === null ? [] : changedPaths(await repository.diffBetween(base, 'HEAD'));
  const state = repository.state;
  const plan = changesPlan({
    label,
    base,
    committed,
    staged: changedPaths(state.indexChanges),
    // Read both working-tree and untracked groups to support default and separate git.untrackedChanges modes.
    // Respect hidden mode.
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
