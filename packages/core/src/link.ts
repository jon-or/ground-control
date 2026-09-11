import { gitDirOf } from './gitDir.js';
import type { ReadText } from './machine.js';
import { basename, join, normalize, parent } from './paths.js';
import { repositoryOf } from './repository.js';

export interface Link {
  /**
   * The checkout the session runs in, which is not its own directory when it was started below one. Null outside a
   * checkout.
   */
  checkoutRoot: string | null;
  branch: string | null;
  /** Canonical remote identity (host/owner/repository), or null when the checkout cannot establish it. */
  repository: string | null;
  issueNumber: number | null;
}

/** Follow a worktree gitdir pointer once. For ordinary clones, read HEAD directly from the .git directory. */
function headAt(dir: string, read: ReadText): { branch: string | null } | null {
  const head = read(join(gitDirOf(dir, read), 'HEAD'))?.trim();

  if (!head) {
    return null;
  }

  return { branch: branchOf(head) };
}

/** The checked-out branch named by a HEAD file's contents. Null for a detached HEAD, which names a commit. */
export function branchOf(head: string): string | null {
  return /^ref: refs\/heads\/(.+)$/.exec(head.trim())?.[1] ?? null;
}

/**
 * Search parent directories for the checkout so sessions in subdirectories retain branch identity. Detached HEAD
 * has no branch.
 */
export function findCheckout(cwd: string, read: ReadText): { root: string; branch: string | null } | null {
  let dir: string | null = normalize(cwd);

  while (dir) {
    const at = headAt(dir, read);

    if (at) {
      return { root: dir, branch: at.branch };
    }

    dir = parent(dir);
  }

  return null;
}

/** Null unless the pattern's first group captured digits — a pattern can match and capture something else. */
export function issueNumberFrom(text: string | null, pattern: RegExp): number | null {
  const captured = text && pattern.exec(text)?.[1];

  return captured && /^\d+$/.test(captured) ? Number(captured) : null;
}

export interface CompiledPattern {
  pattern: RegExp | null;
  error: string | null;
}

/** Reject invalid regexes and patterns without a capture group; linking requires the captured issue number (R25). */
export function compilePattern(source: string): CompiledPattern {
  let pattern: RegExp;

  try {
    pattern = new RegExp(source);
  } catch {
    return { pattern: null, error: `is not a valid regular expression: ${source}` };
  }

  if (!/\((?!\?)|\(\?</.test(source.replace(/\\./g, ''))) {
    return {
      pattern: null,
      error: `has no capturing group, so it cannot say which digits are the issue number: ${source}`,
    };
  }

  return { pattern, error: null };
}

/** Prefer the branch-name convention; fall back to the checkout directory for detached HEAD. */
export function linkOf(cwd: string, read: ReadText, pattern: RegExp | null): Link {
  const checkout = findCheckout(cwd, read);
  const branch = checkout?.branch ?? null;
  // The root rather than `cwd`: the walk is already done, and a session started below the checkout would repeat it.
  const repository = checkout === null ? null : repositoryOf(checkout.root, read);

  const found = { checkoutRoot: checkout?.root ?? null, branch, repository };

  if (!pattern) {
    return { ...found, issueNumber: null };
  }

  return {
    ...found,
    issueNumber: issueNumberFrom(branch, pattern) ?? issueNumberFrom(basename(checkout?.root ?? cwd), pattern),
  };
}
