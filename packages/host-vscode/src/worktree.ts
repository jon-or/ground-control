/**
 * Resume a worktree session in its repository's window. Claude lists only its own folder's project directory,
 * and binds a resumed working directory only under `.claude/worktrees` (`docs/mechanics.md` M52).
 */

import { join } from '@ground-control/core';
import { claudeDirOf } from './placements.js';

/** Claude's own worktree layout. Any other checkout resumes in the main folder, which is the wrong directory. */
const WORKTREE_PATH = /^(.*[^/\\])[/\\]\.claude[/\\]worktrees[/\\][^/\\]+$/;

/** Claude's project-directory name: every non-alphanumeric character becomes a dash. */
const SEPARATOR = /[^a-zA-Z0-9]/g;

/**
 * What the override accepts; a longer name silently keeps the window's own project directory. It also rejects
 * device names, which a path with a separator cannot produce.
 */
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The project directory Claude reads for a working directory, or null where the override cannot name it. */
export function projectDirName(cwd: string): string | null {
  const name = cwd.replace(SEPARATOR, '-');

  return NAME.test(name) ? name : null;
}

/**
 * The repository window that can resume a session from `cwd`, or null to keep a window on the checkout. Both
 * the layout and the name limit must hold, or the session would run in the repository.
 */
export function repositoryWindowFor(cwd: string): string | null {
  const root = WORKTREE_PATH.exec(cwd)?.[1];

  return root !== undefined && projectDirName(cwd) !== null ? root : null;
}

/** Variables that redirect the project directory. The override applies only while both are set. */
const CONFIG_DIR = 'CLAUDE_CONFIG_DIR';
const PROJECT_DIR_NAME = 'CLAUDE_CODE_PROJECT_DIR_NAME';

export type WorktreePointer = Record<typeof CONFIG_DIR | typeof PROJECT_DIR_NAME, string>;

/**
 * The environment that makes a window list a worktree's session, or a refusal naming what is wrong. Pass a
 * resolved `checkout`. An override the extension rejects is ignored in silence, so refuse instead (M52).
 */
export function worktreePointer(
  sessionId: string,
  checkout: string,
  home: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): WorktreePointer | string {
  const name = projectDirName(checkout);

  if (name === null) {
    return `Claude cannot list ${checkout} from another window: its project directory name exceeds 64 characters. Turn off groundControl.resumeWorktreesInRepositoryWindow.`;
  }

  const configDir = claudeDirOf(home, env[CONFIG_DIR]);
  const projects = join(join(configDir, 'projects'), name);

  // Name the transcript: a redirect to a directory without it lists nothing and resumes an empty session.
  if (!exists(join(projects, `${sessionId}.jsonl`))) {
    return `Claude has no saved transcript for this session in ${checkout}. Open it from a window on that worktree.`;
  }

  // Keep the configuration directory this window already uses; only the project directory changes.
  return { [CONFIG_DIR]: configDir, [PROJECT_DIR_NAME]: name };
}
