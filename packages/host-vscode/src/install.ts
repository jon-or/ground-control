import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The marker VS Code's background updater writes beside its executable, naming the commit it staged (M49). */
const MARKER = 'updating_version';

/** How much of a commit hash names the version directory a build unpacks into. */
const DIRECTORY_CHARS = 10;

export interface StagedUpdate {
  /** The version the update staged, or null where its `product.json` was unreadable. */
  version: string | null;
}

function text(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function productVersion(path: string): string | null {
  const json = text(path);

  if (json === null) {
    return null;
  }

  try {
    const version: unknown = (JSON.parse(json) as { version?: unknown }).version;

    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/**
 * Detect a staged commit different from appRoot's build. A missing marker returns null, which is not proof of
 * launch safety. A swapped executable can use another version's single-instance pipe and start a second instance.
 * Compare commit directories instead of version strings to handle stable and Insiders builds (mechanics M49).
 */
export function stagedUpdate(execPath: string, appRoot: string): StagedUpdate | null {
  const dir = dirname(execPath);
  const commit = text(join(dir, MARKER))?.trim();

  if (!commit) {
    return null;
  }

  const staged = commit.slice(0, DIRECTORY_CHARS);

  if (appRoot.split(/[\\/]/).includes(staged)) {
    return null;
  }

  return { version: productVersion(join(dir, staged, 'resources', 'app', 'product.json')) };
}

/** What the developer is told when a route would launch the editor while an update is staged. */
export function stagedUpdateRefusal(staged: StagedUpdate, running: string): string {
  const version = staged.version ?? 'a newer build';

  return `VS Code has ${version} staged and these windows still run ${running}. Opening another window now would start a second VS Code and reopen every window you have. Restart VS Code first.`;
}
