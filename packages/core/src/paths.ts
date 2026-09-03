/**
 * Forward-slash normalised so construction is identical on both platforms. A POSIX cwd containing a literal
 * backslash is mangled here, accepted because no agent CLI reports such a path.
 */
export function normalize(path: string): string {
  return path.split('\\').join('/');
}

/** Joins and collapses `.` and `..` — a worktree's gitdir pointer may be relative to the checkout. */
export function join(dir: string, name: string): string {
  const segments: string[] = [];

  for (const segment of `${normalize(dir).replace(/\/+$/, '')}/${normalize(name)}`.split('/')) {
    if (segment === '.') {
      continue;
    }

    if (segment === '..' && segments.length > 1) {
      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return segments.join('/');
}

export function isAbsolute(path: string): boolean {
  return /^([A-Za-z]:\/|\/)/.test(normalize(path));
}

/** The last segment of a path, with any trailing separator ignored. */
export function basename(path: string): string {
  const trimmed = normalize(path).replace(/\/+$/, '');

  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** One level up, or null at a root: a drive letter, a POSIX root, or a UNC share — the bound on an upward search. */
export function parent(path: string): string | null {
  const trimmed = normalize(path).replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  const above = trimmed.slice(0, cut);

  // A UNC path's first two segments are the server and the share; above them is another machine, not a parent.
  if (cut <= 0 || above.endsWith(':') || /^\/\/[^/]*(\/[^/]*)?$/.test(above)) {
    return null;
  }

  return above;
}

/**
 * A directory as a comparable key. Case is folded because two CLIs can report the same Windows path with a different
 * drive-letter case. The cost lands only on a case-sensitive filesystem, where two directories differing just in case
 * become one board card, and a session there may be opened onto the wrong checkout.
 */
export function dirKey(dir: string): string {
  return normalize(dir).replace(/\/+$/, '').toLowerCase();
}

/** Where everything of the board's own lives in the developer's home: the hub's files, and each agent's signal. */
export const GROUND_CONTROL_DIR = '.claude/ground-control';

export function groundControlDirOf(home: string): string {
  return `${normalize(home).replace(/\/+$/, '')}/${GROUND_CONTROL_DIR}`;
}
