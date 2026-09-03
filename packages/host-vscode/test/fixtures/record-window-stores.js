// Records VS Code's own per-window state: `node test/fixtures/record-window-stores.js`.
// Every open window writes which Claude session each of its editor tabs and its sidebar is showing; that is the only
// record of where a session can be reached. Build the package first: the keys come from its placement table.
// Read the diff before committing — a fixture is evidence.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { REPO, WORKTREES, assertNoAbsolutePaths } = require('../../../../tools/fixture-scrub.js');
const { PLACEMENTS, defaultUserDir } = require('../../dist/index.js');

const OUT = path.join(__dirname, 'window-stores.json');
const EDITOR_KEY = 'memento/workbench.parts.editor';
const CLAUDE = PLACEMENTS.claude;
const SIDEBAR_KEYS = CLAUDE.sidebarKeys;
const KEYS = [EDITOR_KEY, ...SIDEBAR_KEYS];

/** Windows-shaped, unlike the roster fixtures': this records Windows paths, and a POSIX home inside one is incoherent. */
const HOME = 'C:/Users/dev';
/** Enough windows to carry every shape the reader meets, and few enough that the fixture stays readable. */
const KEEP = 8;
/** What every recorded tab title becomes. A title is the developer's own words about the work they are doing. */
const TITLE = 'recorded session';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function read(dir) {
  const database = path.join(dir, 'state.vscdb');
  let updatedAt;

  try {
    updatedAt = fs.statSync(database).mtimeMs;
  } catch {
    return null;
  }

  const scratch = path.join(os.tmpdir(), 'record-window-stores.vscdb');
  const values = new Map();

  try {
    fs.copyFileSync(database, scratch);
    const open = new DatabaseSync(scratch, { readOnly: true });
    for (const row of open.prepare(`select key, value from ItemTable where key in (${KEYS.map(() => '?').join(', ')})`).all(...KEYS)) {
      values.set(row.key, String(row.value));
    }
    open.close();
  } catch {
    return null;
  }

  let workspaceJson = null;
  try {
    workspaceJson = fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8');
  } catch { /* a window with neither a folder nor a workspace file */ }

  return {
    workspaceJson,
    editor: values.get(EDITOR_KEY) ?? null,
    sidebar: SIDEBAR_KEYS.map((key) => values.get(key)).find((value) => value !== undefined) ?? null,
    updatedAt,
  };
}

/**
 * Drops every editor that is not a Claude tab, keeping the grid that holds them. The nesting is what the reader walks,
 * and an untouched `gettingStartedInput` stays so the walk is still proved to step over an editor that is not ours.
 */
function trimEditor(editor) {
  if (editor === null) return null;

  let parsed;
  try { parsed = JSON.parse(editor); } catch { return editor; }

  const keep = (entry) => {
    if (typeof entry?.value !== 'string') return false;
    if (entry.id === 'workbench.editors.gettingStartedInput') return true;
    try { return JSON.parse(entry.value).providedId === CLAUDE.webviewId; } catch { return false; }
  };

  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object' || node === null) return;
    if (Array.isArray(node.editors)) node.editors = node.editors.filter(keep);
    Object.values(node).forEach(walk);
  };

  walk(parsed);

  return JSON.stringify(parsed);
}

/**
 * Walks the stored state, which is JSON nested inside JSON strings to whatever depth the editor was serialised at,
 * and applies `visit` to every object it finds. Re-encodes each layer, so a rewritten value survives back up.
 */
function deep(node, visit) {
  if (typeof node === 'string') {
    let parsed;
    try { parsed = JSON.parse(node); } catch { return node; }

    return parsed !== null && typeof parsed === 'object' ? JSON.stringify(deep(parsed, visit)) : node;
  }

  if (Array.isArray(node)) return node.map((child) => deep(child, visit));
  if (node === null || typeof node !== 'object') return node;

  return visit(Object.fromEntries(Object.entries(node).map(([key, value]) => [key, deep(value, visit)])));
}

/** The one free-text field a window's state carries. Nothing the reader walks depends on what a tab is called. */
function scrubTitles(stored) {
  return deep(stored, (node) => (typeof node.title === 'string' ? { ...node, title: TITLE } : node));
}

function titlesIn(stored) {
  const found = [];

  deep(stored, (node) => {
    if (typeof node.title === 'string') found.push(node.title);

    return node;
  });

  return found;
}

/** Every spelling of a path that survives into the stored JSON: separators, escaping, and the percent-encoded URI. */
function spellings(value) {
  const forward = value.split('\\').join('/');
  const back = forward.split('/').join('\\');

  return [
    ...new Set([
      forward,
      back,
      back.split('\\').join('\\\\'),
      encodeURIComponent(forward).split('%2F').join('/'),
      forward.toLowerCase(),
      forward.toUpperCase(),
    ]),
  ];
}

/**
 * One synthetic checkout per real one and one synthetic id per real session, applied to the stored text rather than to
 * a parsed tree: the nesting — JSON inside a JSON string inside a row — is exactly what the reader has to cope with,
 * so it is preserved byte for byte and only the names change.
 */
function anonymise(stores) {
  const roots = [...new Set(stores.map((store) => rootOf(store.workspaceJson)).filter((root) => root !== null))];
  const ids = [...new Set(stores.flatMap((store) => `${store.editor ?? ''}${store.sidebar ?? ''}`.match(UUID) ?? []))];

  const swaps = [
    [os.homedir(), HOME],
    ...roots.map((root, index) => [root, syntheticRoot(root, index)]),
    ...ids.map((id, index) => [id, syntheticId(index)]),
    // Last, and on its own: the account name also turns up outside any path the recording knows about.
    [os.userInfo().username, 'dev'],
  ];

  // Case-insensitively: one recording carried the same home under both `C:\Users\…` and `c:\Users\…`, and an
  // exact-case pass leaves the second one naming a real person.
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const rewrite = (text) => {
    if (text === null) return null;

    let out = text;

    for (const [from, to] of swaps) {
      for (const spelling of spellings(from)) {
        out = out.replace(new RegExp(escape(spelling), 'gi'), to);
      }
    }

    return out;
  };

  const written = stores.map((store, index) => ({
    workspaceJson: rewrite(store.workspaceJson),
    editor: rewrite(scrubTitles(trimEditor(store.editor))),
    sidebar: rewrite(scrubTitles(store.sidebar)),
    // Fixed offsets, ordered as recorded: the reader believes the most recently written window, and a real mtime
    // would make that ordering drift with the machine rather than with the fixture.
    updatedAt: 1_700_000_000_000 + index * 60_000,
  }));

  assertScrubbed([os.homedir(), os.userInfo().username, ...roots, ...ids], written);

  return written;
}

function rootOf(workspaceJson) {
  if (workspaceJson === null) return null;
  let parsed;
  try { parsed = JSON.parse(workspaceJson); } catch { return null; }
  const uri = parsed.folder ?? parsed.workspace;
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
  const decoded = decodeURIComponent(uri.slice('file://'.length));
  return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
}

function syntheticRoot(root, index) {
  if (root.endsWith('.code-workspace')) return 'd:/work/team.code-workspace';
  if (index === 0) return REPO;
  return `${WORKTREES}/${1000 + index}-recorded-worktree`;
}

const syntheticId = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

/** Synthetic prefixes every path in the fixture must start with. A real one that survived would not match any. */
const SYNTHETIC = [HOME, REPO, 'd:/work'];

/**
 * Fails the recording rather than writing a fixture that still names something real. Three checks, because each alone
 * is escapable: the values known to identify this machine must be gone; every absolute path left must be one of ours,
 * which catches a checkout no window is rooted at; and every title must be the synthetic one, because a title is free
 * text that no list of paths or ids would ever match.
 */
function assertScrubbed(identifying, written) {
  const json = JSON.stringify(written);
  const leaked = [...new Set(identifying)].filter((value) => spellings(value).some((s) => json.includes(s)));

  if (leaked.length > 0) {
    throw new Error(`anonymise left ${leaked.length} identifying value(s): ${leaked.slice(0, 5).join(', ')}`);
  }

  const titles = [
    ...new Set(written.flatMap((store) => [...titlesIn(store.editor), ...titlesIn(store.sidebar)])),
  ].filter((title) => title !== TITLE);

  if (titles.length > 0) {
    throw new Error(`anonymise left ${titles.length} real title(s): ${titles.slice(0, 5).join(', ')}`);
  }

  assertNoAbsolutePaths(json, SYNTHETIC);
}

const root = path.join(defaultUserDir(), 'workspaceStorage');
const stores = fs
  .readdirSync(root)
  .map((dir) => read(path.join(root, dir)))
  .filter((store) => store !== null)
  // Only windows that have shown a Claude session: the rest are the same shape with nothing in them to find.
  .filter((store) => `${store.editor ?? ''}${store.sidebar ?? ''}`.includes('sessionID'))
  .sort((a, b) => b.updatedAt - a.updatedAt)
  .slice(0, KEEP)
  .reverse();

fs.writeFileSync(OUT, `${JSON.stringify(anonymise(stores), null, 1)}\n`);
console.log(`recorded ${stores.length} window stores to ${OUT}`);
