import { copyFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentPlacement } from './placements.js';
import type { WindowStore } from './surface.js';

/**
 * Load experimental `node:sqlite` on demand so an import failure disables window discovery without preventing
 * board startup.
 */
let sqlite: typeof import('node:sqlite') | null = null;

async function loadSqlite(): Promise<typeof import('node:sqlite') | null> {
  // Retry failed imports so a temporary failure does not disable discovery until restart.
  sqlite ??= await import('node:sqlite').catch(() => null);

  return sqlite;
}

const EDITOR_KEY = 'memento/workbench.parts.editor';

/**
 * Default VS Code user directory. The extension supplies its actual storage path for portable and Insiders
 * installs.
 */
export function defaultUserDir(): string {
  if (process.platform === 'win32') {
    return join(process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), 'Code', 'User');
  }

  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Code', 'User');
  }

  return join(homedir(), '.config', 'Code', 'User');
}

function text(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function readOne(
  dir: string,
  scratch: string,
  sidebarKeys: readonly string[],
  DatabaseSync: typeof import('node:sqlite').DatabaseSync,
): WindowStore | null {
  const keys = [EDITOR_KEY, ...sidebarKeys];
  const select = `select key, value from ItemTable where key in (${keys.map(() => '?').join(', ')})`;
  const database = join(dir, 'state.vscdb');
  let updatedAt: number;

  try {
    updatedAt = statSync(database).mtimeMs;
  } catch {
    return null;
  }

  const values = new Map<string, string>();

  try {
    // Read a copy because VS Code holds the original database open.
    copyFileSync(database, scratch);

    const open = new DatabaseSync(scratch, { readOnly: true });

    try {
      for (const row of open.prepare(select).all(...keys)) {
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
    sidebar: sidebarKeys.map((key) => values.get(key)).find((value) => value !== undefined) ?? null,
    updatedAt,
  };
}

/** Cache stores by directory and mtime, requiring only a stat for unchanged databases. */
const storeCache = new Map<string, { updatedAt: number; store: WindowStore }>();

/**
 * Read persisted window state and agent sidebar mementos (M21). Use the running installation's `User` directory
 * for portable and Insiders support.
 */
export async function readWindowStores(
  userDir: string,
  placements: Readonly<Record<string, AgentPlacement>>,
): Promise<WindowStore[]> {
  const sidebarKeys = Object.values(placements).flatMap((placement) => placement.sidebarKeys);
  const loaded = await loadSqlite();

  if (loaded === null) {
    return [];
  }

  const root = join(userDir, 'workspaceStorage');
  // Use a separate copy per process to prevent windows from overwriting each other's reads.
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
    const cached = storeCache.get(dir);
    const store = cached?.updatedAt === updatedAt ? cached.store : readOne(dir, scratch, sidebarKeys, loaded.DatabaseSync);

    if (store !== null) {
      storeCache.set(dir, { updatedAt, store });
      stores.push(store);
    }
  }

  for (const dir of storeCache.keys()) {
    if (!present.has(dir)) {
      storeCache.delete(dir);
    }
  }

  try {
    rmSync(scratch, { force: true });
  } catch {
    /* The next read overwrites the scratch file. */
  }

  return stores;
}
