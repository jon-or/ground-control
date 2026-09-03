import { copyFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WindowStore } from '@ground-control/sessions';

/**
 * Loaded on demand, not at import. `node:sqlite` is still experimental, and this module is reached from the board's
 * own module graph — a top-level import that threw would cost the whole board rather than one refused click.
 */
let sqlite: typeof import('node:sqlite') | null = null;

async function loadSqlite(): Promise<typeof import('node:sqlite') | null> {
  // Retried rather than remembered as absent: caching one failed import would leave every session for the rest of
  // the session reporting that no window is showing it, which is a false explanation rather than a missing read.
  sqlite ??= await import('node:sqlite').catch(() => null);

  return sqlite;
}

const EDITOR_KEY = 'memento/workbench.parts.editor';
/** The secondary sidebar is where the Claude view lives on VS Code versions that have one; the other is the fallback. */
const SIDEBAR_KEYS = ['memento/webviewView.claudeVSCodeSidebarSecondary', 'memento/webviewView.claudeVSCodeSidebar'];
const KEYS = [EDITOR_KEY, ...SIDEBAR_KEYS];

const SELECT = `select key, value from ItemTable where key in (${KEYS.map(() => '?').join(', ')})`;

function text(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function readOne(dir: string, scratch: string, DatabaseSync: typeof import('node:sqlite').DatabaseSync): WindowStore | null {
  const database = join(dir, 'state.vscdb');
  let updatedAt: number;

  try {
    updatedAt = statSync(database).mtimeMs;
  } catch {
    return null;
  }

  const values = new Map<string, string>();

  try {
    // The window that owns it holds it open, so it is copied and read from the copy rather than opened in place.
    copyFileSync(database, scratch);

    const open = new DatabaseSync(scratch, { readOnly: true });

    try {
      for (const row of open.prepare(SELECT).all(...KEYS)) {
        const value = row['value'];

        if (typeof row['key'] === 'string' && (typeof value === 'string' || value instanceof Uint8Array)) {
          values.set(row['key'], typeof value === 'string' ? value : Buffer.from(value).toString('utf8'));
        }
      }
    } finally {
      open.close();
    }
  } catch {
    return null;
  }

  return {
    workspaceJson: text(join(dir, 'workspace.json')),
    editor: values.get(EDITOR_KEY) ?? null,
    sidebar: SIDEBAR_KEYS.map((key) => values.get(key)).find((value) => value !== undefined) ?? null,
    updatedAt,
  };
}

/**
 * What was read last, keyed by directory. Re-read only when the database has been written since, which leaves one
 * `stat` per window in the steady state — most belong to windows closed weeks ago that will never change again.
 */
const seen = new Map<string, { updatedAt: number; store: WindowStore }>();

/**
 * Every VS Code window's persisted state (`docs/mechanics.md` §21). `userDir` is derived from the extension's own
 * storage rather than assumed, which is where a portable or Insiders install differs from the default one.
 */
export async function readWindowStores(userDir: string): Promise<WindowStore[]> {
  const loaded = await loadSqlite();

  if (loaded === null) {
    return [];
  }

  const root = join(userDir, 'workspaceStorage');
  // Named for this process: the board runs in every window, and a shared scratch file has them overwriting each
  // other's copy mid-read, which attributes one window's tabs to another window's root.
  const scratch = join(tmpdir(), `ground-control-window-store-${process.pid}.vscdb`);

  let dirs: string[];

  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }

  const stores: WindowStore[] = [];
  const present = new Set<string>();

  for (const name of dirs) {
    const dir = join(root, name);
    let updatedAt: number;

    try {
      updatedAt = statSync(join(dir, 'state.vscdb')).mtimeMs;
    } catch {
      continue;
    }

    present.add(dir);
    const cached = seen.get(dir);
    const store = cached?.updatedAt === updatedAt ? cached.store : readOne(dir, scratch, loaded.DatabaseSync);

    if (store !== null) {
      seen.set(dir, { updatedAt, store });
      stores.push(store);
    }
  }

  for (const dir of seen.keys()) {
    if (!present.has(dir)) {
      seen.delete(dir);
    }
  }

  try {
    rmSync(scratch, { force: true });
  } catch {
    /* the next read overwrites it anyway */
  }

  return stores;
}
