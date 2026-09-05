import * as vscode from 'vscode';

/**
 * The parts of the built-in Git extension's API (`vscode.git`, version 1) this board calls. Declared here rather
 * than vendored whole: the shipped extension carries no `.d.ts`, so every field below is one measured against
 * `resources/app/extensions/git/dist/main.js` on 2026-09-05 and named in `docs/mechanics.md` §30.
 */
export const GIT_EXTENSION_ID = 'vscode.git';

/** `Status` as the Git extension freezes it, whole: a member left out reads as one that is present. */
export const GitStatus = {
  INDEX_MODIFIED: 0,
  INDEX_ADDED: 1,
  INDEX_DELETED: 2,
  INDEX_RENAMED: 3,
  INDEX_COPIED: 4,
  IGNORED: 8,
  MODIFIED: 5,
  DELETED: 6,
  UNTRACKED: 7,
  INTENT_TO_ADD: 9,
  INTENT_TO_RENAME: 10,
  TYPE_CHANGED: 11,
  ADDED_BY_US: 12,
  ADDED_BY_THEM: 13,
  DELETED_BY_US: 14,
  DELETED_BY_THEM: 15,
  BOTH_ADDED: 16,
  BOTH_DELETED: 17,
  BOTH_MODIFIED: 18,
} as const;

export interface GitChange {
  /** The path as it stands now — the new name of a rename. */
  readonly uri: vscode.Uri;
  /** The path as it stood before — the old name of a rename. */
  readonly originalUri: vscode.Uri;
  readonly status: number;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD: { readonly name?: string; readonly commit?: string } | undefined;
    readonly workingTreeChanges: readonly GitChange[];
    readonly indexChanges: readonly GitChange[];
    readonly untrackedChanges: readonly GitChange[];
  };
  /** Runs a status read and resolves when the resource groups below have been rebuilt from it. */
  status(): Promise<void>;
  getMergeBase(ref1: string, ref2: string): Promise<string | undefined>;
  diffBetween(ref1: string, ref2: string): Promise<GitChange[]>;
}

export interface GitApi {
  readonly repositories: readonly GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExports {
  getAPI(version: 1): GitApi;
}

/** Null where the Git extension is not installed or is disabled — the board says so rather than throwing. */
export async function gitApi(): Promise<GitApi | null> {
  const extension = vscode.extensions.getExtension<GitExports>(GIT_EXTENSION_ID);

  if (!extension) {
    return null;
  }

  const exports = extension.isActive ? extension.exports : await extension.activate();

  return exports.getAPI(1);
}

/**
 * A path at a revision, as the Git extension's own content provider reads it. The query is the whole address; the
 * path carries the file only so the editor has a name and a language to show.
 */
export function gitUri(path: string, ref: string): vscode.Uri {
  const file = vscode.Uri.file(path);

  return file.with({ scheme: 'git', query: JSON.stringify({ path: file.fsPath, ref }) });
}
