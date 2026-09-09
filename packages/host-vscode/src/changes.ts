import { dirKey } from '@ground-control/core';

/** Change type within one stage. */
export type ChangeKind = 'added' | 'modified' | 'deleted';

export interface ChangedPath {
  path: string;
  kind: ChangeKind;
  /** Previous path for a rename; absent for other changes. */
  from?: string;
}

/**
 * Diff path and revision; null ref means the working-tree file. The extension converts these values to editor
 * URIs.
 */
export interface DiffSide {
  path: string;
  ref: string | null;
}

/** Null original means an addition; null modified means a deletion. */
export interface DiffRow {
  original: DiffSide | null;
  modified: DiffSide | null;
}

/**
 * Keep committed, staged, and working-tree changes separate. A path can have different changes in each stage,
 * such as a staged edit followed by an unstaged deletion.
 */
export interface ChangesRequest {
  /** Editor tab title: card label and checkout when needed. */
  label: string;
  /** Merge base, or null to show and label uncommitted changes only. */
  base: string | null;
  /** `base...HEAD`, empty when there is no base. */
  committed: readonly ChangedPath[];
  /** The index against HEAD. */
  staged: readonly ChangedPath[];
  /** The working tree against the index, untracked files included. */
  working: readonly ChangedPath[];
}

export type ChangesPlan =
  | { refusal: 'no-changes'; message: string }
  | { title: string; rows: DiffRow[]; shown: number; total: number };

/** Limit diff resources sent to the editor; report truncation when a branch exceeds this count. */
export const MAX_ROWS = 400;

/** Explain why VS Code could not open the checkout repository. */
export function noRepository(wanted: string): string {
  return `VS Code has no repository at ${wanted}. Open that folder in a window, or check that Git is enabled for it.`;
}

/**
 * Verify the selected root before diffing. VS Code may fall back to a prefix match or the only open repository,
 * which could select the main clone instead of a worktree.
 */
export function repositoryRefusal(wanted: string, answered: string): string | null {
  return dirKey(answered) === dirKey(wanted)
    ? null
    : `VS Code selected ${answered} instead of ${wanted}. Open ${wanted} in a separate window and try again.`;
}

/** Track a file's original and current paths across stages. */
interface Chain {
  basePath: string;
  existedAtBase: boolean;
  /** Null after deletion; later recreation of the path continues the same record. */
  nowPath: string | null;
}

/** Apply changes by their previous paths so renames update existing records. */
function advance(chains: Map<string, Chain>, changes: readonly ChangedPath[]): void {
  for (const change of changes) {
    const before = change.from ?? change.path;
    const chain = chains.get(dirKey(before)) ?? {
      basePath: before,
      existedAtBase: change.kind !== 'added',
      nowPath: before,
    };

    chains.delete(dirKey(before));
    chain.nowPath = change.kind === 'deleted' ? null : change.path;
    // Index by the resulting path for the next stage.
    chains.set(dirKey(change.path), chain);
  }
}

/**
 * Combine committed, staged, and working-tree changes into base-to-working-tree rows. Follow renames across
 * stages and omit files added then deleted.
 */
export function changesPlan(request: ChangesRequest): ChangesPlan {
  const chains = new Map<string, Chain>();

  advance(chains, request.committed);
  advance(chains, request.staged);
  advance(chains, request.working);

  // Use HEAD when no merge base exists and label the result as uncommitted changes only.
  const ref = request.base ?? 'HEAD';
  const rows: DiffRow[] = [];

  for (const chain of chains.values()) {
    if (!chain.existedAtBase && chain.nowPath === null) {
      continue;
    }

    rows.push({
      original: chain.existedAtBase ? { path: chain.basePath, ref } : null,
      modified: chain.nowPath === null ? null : { path: chain.nowPath, ref: null },
    });
  }

  if (rows.length === 0) {
    return {
      refusal: 'no-changes',
      message: request.base
        ? `${request.label}: no changes since the merge base and no uncommitted changes.`
        : `${request.label}: no uncommitted changes. Merge base unavailable.`,
    };
  }

  rows.sort((a, b) => (a.modified?.path ?? a.original?.path ?? '').localeCompare(b.modified?.path ?? b.original?.path ?? ''));

  const shown = rows.slice(0, MAX_ROWS);

  return { title: titleOf(request, shown.length, rows.length), rows: shown, shown: shown.length, total: rows.length };
}

/** Label the base and any truncation. The editor supplies the file count. */
function titleOf(request: ChangesRequest, shown: number, total: number): string {
  const scope = request.base ? `since ${request.base.slice(0, 7)}` : 'uncommitted only, no merge base';
  const left = shown === total ? '' : `, first ${shown} of ${total}`;

  return `${request.label} — ${scope}${left}`;
}
