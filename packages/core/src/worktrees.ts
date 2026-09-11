import type { BoardCard } from './board.js';
import { commonDirOf, gitDirOf } from './gitDir.js';
import { branchOf, findCheckout, issueNumberFrom } from './link.js';
import type { CheckoutReaders } from './machine.js';
import { basename, dirKey, isAbsolute, join, normalize, parent } from './paths.js';
import { repositoryAt, repositoryKey } from './repository.js';

/** A worktree matched to a card. `only` is false when several worktrees name the same issue. */
export interface CardWorktree {
  root: string;
  branch: string | null;
  only: boolean;
}

/** A working tree of a known clone, with the repository its clone's origin names. */
export interface ScannedWorktree {
  root: string;
  branch: string | null;
  repository: string;
}

/** Worktrees match a card of the same repository only: issue numbers repeat across repositories. */
function worktreeKey(repository: string, issueNumber: number): string {
  return `${repository}#${issueNumber}`;
}

/** A clone the hub can search or provision a worktree in, reached from any directory inside it. */
export interface Clone {
  /** The main working tree. Null for a bare clone or a separate git directory. */
  root: string | null;
  /** The shared git directory holding config and the worktree registrations. */
  commonDir: string;
  repository: string;
}

/**
 * Working trees of one clone: the main tree, when it has one, and every registered worktree. A registration
 * whose directory is gone is skipped (mechanics M56).
 */
export function worktreesOf(clone: Clone, readers: CheckoutReaders): ScannedWorktree[] {
  const found: ScannedWorktree[] = [];

  if (clone.root !== null) {
    const head = readers.readText(join(clone.commonDir, 'HEAD'));

    found.push({ root: clone.root, branch: head === null ? null : branchOf(head), repository: clone.repository });
  }

  const registrations = join(clone.commonDir, 'worktrees');

  for (const name of readers.listDir(registrations) ?? []) {
    const entry = join(registrations, name);
    const pointer = readers.readText(join(entry, 'gitdir'))?.trim();
    // The pointer names the worktree's own `.git` file, so the worktree root is its parent. Git writes it
    // relative to the registration under `worktree.useRelativePaths`.
    const dotGit = pointer && basename(pointer) === '.git' ? (isAbsolute(pointer) ? normalize(pointer) : join(entry, pointer)) : null;
    const root = dotGit === null ? null : parent(dotGit);

    if (root === null || readers.listDir(root) === null) {
      continue;
    }

    const head = readers.readText(join(entry, 'HEAD'));

    found.push({ root, branch: head === null ? null : branchOf(head), repository: clone.repository });
  }

  return found;
}

/**
 * The distinct clones the given directories belong to. A clone and all its worktrees share one common
 * directory, so each is reported once however many of its directories are named.
 */
export function clonesOf(roots: Iterable<string>, readers: CheckoutReaders): Clone[] {
  const clones = new Map<string, Clone | null>();

  for (const start of roots) {
    // Roots arrive as session directories and window folders, which may sit below the checkout.
    const checkout = findCheckout(start, readers.readText);

    if (checkout === null) {
      continue;
    }

    const gitDir = gitDirOf(checkout.root, readers.readText);
    const commonDir = commonDirOf(gitDir, readers.readText);
    const key = dirKey(commonDir);
    // The main working tree owns the common directory outright; a linked worktree's git directory sits under it.
    const owns = dirKey(gitDir) === key;
    const known = clones.get(key);

    if (known !== undefined) {
      // A separate git directory names no working tree from a linked worktree; the main tree, reached later, does.
      if (known !== null && known.root === null && owns) known.root = checkout.root;

      continue;
    }

    const repository = repositoryAt(commonDir, readers.readText) ?? null;

    // A clone with no identifiable origin cannot be matched to an issue without guessing.
    if (repository === null) {
      clones.set(key, null);
      continue;
    }

    // Reached through a linked worktree, the main tree is the parent of a `.git` directory; a bare clone, or a
    // separate git directory, names none.
    const main = owns ? checkout.root : basename(commonDir) === '.git' ? parent(commonDir) : null;

    clones.set(key, { root: main, commonDir, repository });
  }

  return [...clones.values()].filter((clone): clone is Clone => clone !== null);
}

/** Every working tree of every known clone, by the issue its name links to and by directory. */
export interface WorktreeIndex {
  /** Keyed by repository and issue number; a worktree links by branch name, else by directory name. */
  byIssue: ReadonlyMap<string, ScannedWorktree[]>;
  /** Keyed by `dirKey` of the root, so a recorded link can be checked against what git registers. */
  byRoot: ReadonlyMap<string, ScannedWorktree>;
}

/**
 * Index the working trees of every distinct clone among `roots`. Name linking applies the precedence `linkOf`
 * applies to sessions; without a usable pattern nothing links by name, the refusal `fetchSessions` reports (R25).
 */
export function worktreeIndex(roots: Iterable<string>, readers: CheckoutReaders, pattern: RegExp | null): WorktreeIndex {
  const byIssue = new Map<string, ScannedWorktree[]>();
  const byRoot = new Map<string, ScannedWorktree>();

  for (const clone of clonesOf(roots, readers)) {
    for (const worktree of worktreesOf(clone, readers)) {
      byRoot.set(dirKey(worktree.root), worktree);

      const issueNumber = pattern === null ? null : (issueNumberFrom(worktree.branch, pattern) ?? issueNumberFrom(basename(worktree.root), pattern));

      if (issueNumber === null) {
        continue;
      }

      const key = worktreeKey(clone.repository, issueNumber);
      const list = byIssue.get(key) ?? [];

      list.push(worktree);
      byIssue.set(key, list);
    }
  }

  for (const list of byIssue.values()) {
    list.sort((a, b) => dirKey(a.root).localeCompare(dirKey(b.root)));
  }

  return { byIssue, byRoot };
}

/**
 * The worktree for a card: the one a provisioning run recorded for it, if git still registers it in a clone of
 * the card's repository, else the first by path of those naming the issue. Null when neither exists.
 */
export function worktreeFor(
  card: Pick<BoardCard, 'issue' | 'issueNumber'>,
  index: WorktreeIndex,
  recorded?: string,
): CardWorktree | null {
  const repository = card.issue === null ? null : repositoryKey(card.issue.url);

  if (repository === null || card.issueNumber === null) {
    return null;
  }

  const named = index.byIssue.get(worktreeKey(repository, card.issueNumber)) ?? [];
  const kept = recorded === undefined ? undefined : index.byRoot.get(dirKey(recorded));
  const chosen = kept !== undefined && kept.repository === repository ? kept : named[0];

  if (chosen === undefined) {
    return null;
  }

  // Several worktrees for one issue: the developer has to say which, so no caller may treat the pick as settled.
  const roots = new Set([chosen, ...named].map((worktree) => dirKey(worktree.root)));

  return { root: chosen.root, branch: chosen.branch, only: roots.size < 2 };
}
