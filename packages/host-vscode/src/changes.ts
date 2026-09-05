import { dirKey } from '@ground-control/core';

/** What happened to one path across one stage. `from` is set only by a rename, and is the name it had going in. */
export type ChangeKind = 'added' | 'modified' | 'deleted';

export interface ChangedPath {
  path: string;
  kind: ChangeKind;
  from?: string;
}

/**
 * One side of a row. `ref` null is the file as it stands on disk; anything else is that path at that revision. The
 * caller turns the pair into whatever URIs its editor wants — this package names no `vscode` type.
 */
export interface DiffSide {
  path: string;
  ref: string | null;
}

/** A missing side is a file that does not exist there: no original is an addition, no modified is a deletion. */
export interface DiffRow {
  original: DiffSide | null;
  modified: DiffSide | null;
}

/**
 * Three stages, because each answers something the others cannot: what the branch committed, what the index holds
 * against that, and what the working tree holds against the index. A file staged as an edit and then deleted on
 * disk says different things in two of them, and one status per path keeps whichever was read last.
 */
export interface ChangesRequest {
  /** What the editor tab is called — the card and, where a card spans more than one, its checkout. */
  label: string;
  /** The merge base. Null where none could be established, and then only uncommitted work is shown, and said. */
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

/**
 * How many rows one editor is given. A branch off a stale base can be thousands of files, and every resource is
 * handed over at once; past this the editor is a scrollbar rather than a review, so it is truncated and says so.
 */
export const MAX_ROWS = 400;

/** A checkout the editor would not open. Its Git integration is off for that folder, or the path is not there. */
export function noRepository(wanted: string): string {
  return `VS Code has no repository at ${wanted}. Open that folder in a window, or check that Git is enabled for it.`;
}

/**
 * Whether the repository that answered is the one that was asked for. VS Code resolves a repository argument by
 * longest open-repository root prefix and, on a miss, returns the window's only repository without prompting — so a
 * worktree that failed to open would diff the main clone silently. Nothing runs until the roots match.
 */
export function repositoryRefusal(wanted: string, answered: string): string | null {
  return dirKey(answered) === dirKey(wanted)
    ? null
    : `VS Code answered with the repository at ${answered} rather than ${wanted}. Open the worktree in a window of its own and try again.`;
}

/** One file followed through the stages: where it started, whether it was there, and what it is called now. */
interface Chain {
  basePath: string;
  existedAtBase: boolean;
  /** Null once a stage has deleted it. A later stage recreating that path picks the same chain back up. */
  nowPath: string | null;
}

/**
 * Follows one stage. A change is looked up under the name the file had going in, which is what makes a rename meet
 * the file it renamed rather than start a second row beside it.
 */
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
    // Keyed by the name it now has, so the next stage finds it under that name.
    chains.set(dirKey(change.path), chain);
  }
}

/**
 * Every file the branch has touched, committed work and uncommitted together: the base on the left, the working
 * tree on the right. No single Git command produces that set, so the stages are folded here.
 *
 * A file that moves through them is one row spanning the whole distance, and a file added and then deleted again
 * is no row at all.
 */
export function changesPlan(request: ChangesRequest): ChangesPlan {
  const chains = new Map<string, Chain>();

  advance(chains, request.committed);
  advance(chains, request.staged);
  advance(chains, request.working);

  // The original side is the merge base where there is one. Where there is not, it is HEAD and the title says so:
  // a missing base silently becoming HEAD would show uncommitted work while claiming to show the branch.
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
        ? `${request.label} has no changes: its branch matches what it forked from, and nothing is uncommitted.`
        : `${request.label} has nothing uncommitted, and the board could not work out what its branch forked from.`,
    };
  }

  rows.sort((a, b) => (a.modified?.path ?? a.original?.path ?? '').localeCompare(b.modified?.path ?? b.original?.path ?? ''));

  const shown = rows.slice(0, MAX_ROWS);

  return { title: titleOf(request, shown.length, rows.length), rows: shown, shown: shown.length, total: rows.length };
}

/**
 * The editor appends its own file count to whatever it is given, so this counts nothing: it says what the left-hand
 * side is, and how much was left out where anything was.
 */
function titleOf(request: ChangesRequest, shown: number, total: number): string {
  const scope = request.base ? `since ${request.base.slice(0, 7)}` : 'uncommitted only, no merge base';
  const left = shown === total ? '' : `, first ${shown} of ${total}`;

  return `${request.label} — ${scope}${left}`;
}
