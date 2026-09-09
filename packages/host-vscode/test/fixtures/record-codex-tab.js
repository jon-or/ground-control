// Records one VS Code window holding a revealed Codex thread: `node test/fixtures/record-codex-tab.js`.
// A Codex tab carries its thread in the editor's own resource rather than in webview state, so this is the only
// record of where a Codex session can be reached. Build the package first: the keys come from its placement table.
// Read the diff before committing — a fixture is evidence.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { REPO, assertNoAbsolutePaths } = require('../../../../tools/fixture-scrub.js');
const { PLACEMENTS, defaultUserDir } = require('../../dist/index.js');

const OUT = path.join(__dirname, 'codex-tab.json');
const EDITOR_KEY = 'memento/workbench.parts.editor';
const CODEX = PLACEMENTS.codex;

/**
 * Codex's own view-container state, which is the whole of what its sidebar records: it names no thread whatever it
 * is showing, which is why the placement table gives Codex no sidebar keys. Recorded so that stays checkable.
 */
const SIDEBAR_KEY = 'workbench.view.extension.codexSecondaryViewContainer.state';

/** Windows-shaped, as this records Windows paths: a POSIX home inside a recorded `fsPath` is incoherent. */
const HOME = 'C:/Users/dev';
/** What every recorded tab title becomes. Codex titles a fresh tab with the thread id, but a title is free text. */
const TITLE = 'recorded session';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const SYNTHETIC_THREAD = '00000000-0000-4000-8000-000000000031';
const SYNTHETIC_ORIGIN = '00000000-0000-4000-8000-000000000030';

function read(dir) {
  const database = path.join(dir, 'state.vscdb');

  if (!fs.existsSync(database)) return null;

  const scratch = path.join(os.tmpdir(), 'record-codex-tab.vscdb');
  const values = new Map();

  try {
    fs.copyFileSync(database, scratch);
    const open = new DatabaseSync(scratch, { readOnly: true });
    for (const row of open.prepare('select key, value from ItemTable where key in (?, ?)').all(EDITOR_KEY, SIDEBAR_KEY)) {
      values.set(row.key, String(row.value));
    }
    open.close();
  } catch {
    return null;
  }

  const editor = values.get(EDITOR_KEY);

  if (editor === undefined || !editor.includes(CODEX.webviewId)) return null;

  let workspaceJson = null;
  try {
    workspaceJson = fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8');
  } catch { /* a window with neither a folder nor a workspace file */ }

  return { editor, sidebar: values.get(SIDEBAR_KEY) ?? null, workspaceJson };
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

function titlesIn(stored) {
  const found = [];

  deep(stored, (node) => {
    if (typeof node.title === 'string') found.push(node.title);

    return node;
  });

  return found;
}

/**
 * How a path can be spelled in the stored JSON. A tab's own state is a JSON string inside the memento's JSON, so one
 * Windows separator is written there as four backslashes — a two-deep pass leaves the path naming a real checkout.
 */
const STYLES = ['forward', 1, 2, 4, 8, 'uri', 'lower', 'upper'];

/** One path in one of those styles. A rewrite pairs the two sides style for style, so no mixed separators survive. */
function spell(value, style) {
  const forward = value.split('\\').join('/');

  if (style === 'uri') return encodeURIComponent(forward).split('%2F').join('/');
  if (style === 'lower') return forward.toLowerCase();
  if (style === 'upper') return forward.toUpperCase();
  if (style === 'forward') return forward;

  return forward.split('/').join('\\'.repeat(style));
}

const spellings = (value) => [...new Set(STYLES.map((style) => spell(value, style)))];

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function rootOf(workspaceJson) {
  if (workspaceJson === null) return null;
  let parsed;
  try { parsed = JSON.parse(workspaceJson); } catch { return null; }
  const uri = parsed.folder ?? parsed.workspace;
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
  const decoded = decodeURIComponent(uri.slice('file://'.length));
  return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
}

/**
 * One synthetic name per real one, applied to the stored text rather than to a parsed tree: the nesting — JSON
 * inside a JSON string inside a row — is exactly what the reader has to cope with, so it is preserved byte for byte
 * and only the names change. The thread is the first id in the resource; the second is the webview's own origin.
 */
function anonymise(store) {
  const root = rootOf(store.workspaceJson);
  const resource = new RegExp(`${escape(CODEX.session.scheme)}://[^/"]*${escape(CODEX.session.prefix)}([A-Za-z0-9-]+)`);
  const thread = resource.exec(store.editor)?.[1] ?? null;

  if (thread === null) {
    throw new Error('the recorded window has a Codex tab whose resource carries no thread');
  }

  const ids = [...new Set(store.editor.match(UUID) ?? [])].filter((id) => id !== thread);
  const swaps = [
    [os.homedir(), HOME],
    ...(root === null ? [] : [[root, REPO]]),
    [thread, SYNTHETIC_THREAD],
    ...ids.map((id, index) => [id, index === 0 ? SYNTHETIC_ORIGIN : `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`]),
    // Last, and on its own: the account name also turns up outside any path the recording knows about.
    [os.userInfo().username, 'dev'],
  ];

  // Case-insensitively: one recording carried the same home under both `C:\Users\…` and `c:\Users\…`, and an
  // exact-case pass leaves the second one naming a real person.
  const rewrite = (text) => {
    if (text === null) return null;

    let out = text;

    for (const [from, to] of swaps) {
      for (const style of STYLES) {
        out = out.replace(new RegExp(escape(spell(from, style)), 'gi'), spell(to, style === 'lower' || style === 'upper' ? 'forward' : style));
      }
    }

    return out;
  };

  const scrubTitles = (stored) => deep(stored, (node) => (typeof node.title === 'string' ? { ...node, title: TITLE } : node));

  const written = {
    thread: SYNTHETIC_THREAD,
    /** The memento as VS Code stores it: one JSON string per tab, inside the editor grid. */
    editor: rewrite(scrubTitles(store.editor)),
    /** Codex's own sidebar state, which names no thread whatever the sidebar is showing (M44). */
    sidebar: rewrite(store.sidebar),
  };

  assertScrubbed([os.homedir(), os.userInfo().username, thread, ...ids, ...(root === null ? [] : [root])], written);

  return written;
}

/**
 * Fails the recording rather than writing a fixture that still names something real. Three checks, because each
 * alone is escapable: the values known to identify this machine must be gone; every absolute path left must be one
 * of ours; and every title must be the synthetic one, because a title is free text no list of names would match.
 */
function assertScrubbed(identifying, written) {
  const json = JSON.stringify(written);
  const leaked = [...new Set(identifying)].filter((value) => spellings(value).some((s) => json.toLowerCase().includes(s.toLowerCase())));

  if (leaked.length > 0) {
    throw new Error(`anonymise left ${leaked.length} identifying value(s): ${leaked.slice(0, 5).join(', ')}`);
  }

  const titles = [...new Set(titlesIn(written.editor))].filter((title) => title !== TITLE);

  if (titles.length > 0) {
    throw new Error(`anonymise left ${titles.length} real title(s): ${titles.slice(0, 5).join(', ')}`);
  }

  assertNoAbsolutePaths(json, [HOME, REPO]);
}

const root = path.join(defaultUserDir(), 'workspaceStorage');
const found = fs
  .readdirSync(root)
  .map((dir) => read(path.join(root, dir)))
  .filter((store) => store !== null)
  // The smallest such window, which is the one whose whole memento stays readable in a diff.
  .sort((a, b) => a.editor.length - b.editor.length);

if (found.length === 0) {
  throw new Error(`no window in ${root} is holding a Codex tab — reveal one, wait a minute for the memento to flush, and re-run`);
}

fs.writeFileSync(OUT, `${JSON.stringify(anonymise(found[0]), null, 2)}\n`);
console.log(`recorded a Codex tab from 1 of ${found.length} windows holding one, to ${OUT}`);
