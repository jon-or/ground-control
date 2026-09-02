import { basename, isAbsolute, join, normalize, parent } from './paths.js';

/** Reads a text file, or returns null for anything that is not a readable file — a directory included. */
export type ReadText = (path: string) => string | null;

export interface Link {
  branch: string | null;
  issueNumber: number | null;
}

/**
 * A worktree's `.git` is a file holding `gitdir: <path>`, so the pointer is followed once. A plain clone's `.git`
 * is a directory, whose text read fails — HEAD is what proves a checkout either way.
 */
function headAt(dir: string, read: ReadText): { branch: string | null } | null {
  const dotGit = join(dir, '.git');
  const pointer = read(dotGit);
  const gitdir = pointer && /^gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1];
  const gitDir = gitdir ? (isAbsolute(gitdir) ? normalize(gitdir) : join(dir, gitdir)) : dotGit;
  const head = read(join(gitDir, 'HEAD'))?.trim();

  if (!head) {
    return null;
  }

  return { branch: /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? null };
}

/**
 * The checkout a session runs in, searched upward: a session started in a subdirectory would otherwise lose its
 * branch and have the subdirectory's name mistaken for the work's. A detached HEAD is a checkout with no branch.
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

/**
 * A pattern with no capturing group would match every branch and link none of them, with nothing to show the
 * developer — so it is refused up front alongside a pattern that is not a regex at all (R25).
 */
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

/**
 * The branch is the primary signal because it is the team's stated convention and the only one that works for a
 * developer who switches branches in a single clone. The checkout's own directory name covers a detached HEAD.
 */
export function linkOf(cwd: string, read: ReadText, pattern: RegExp | null): Link {
  const checkout = findCheckout(cwd, read);
  const branch = checkout?.branch ?? null;

  if (!pattern) {
    return { branch, issueNumber: null };
  }

  return {
    branch,
    issueNumber: issueNumberFrom(branch, pattern) ?? issueNumberFrom(basename(checkout?.root ?? cwd), pattern),
  };
}
