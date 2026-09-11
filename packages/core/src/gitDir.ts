import type { ReadText } from './machine.js';
import { isAbsolute, join, normalize } from './paths.js';

/**
 * The git directory a checkout uses, following a worktree's `.git` pointer file. Path resolution only: confirm
 * a checkout by reading a file inside the result, because a directory read returns null here.
 */
export function gitDirOf(root: string, read: ReadText): string {
  const dotGit = join(root, '.git');
  const pointer = read(dotGit)?.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];

  if (pointer === undefined) {
    return dotGit;
  }

  return isAbsolute(pointer) ? normalize(pointer) : join(root, pointer);
}

/** The shared git directory holding config and worktree registrations. Equal to `gitDir` in a main clone. */
export function commonDirOf(gitDir: string, read: ReadText): string {
  const common = read(join(gitDir, 'commondir'))?.trim();

  if (!common) {
    return gitDir;
  }

  return isAbsolute(common) ? normalize(common) : join(gitDir, common);
}
