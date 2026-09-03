import { dirKey } from './paths.js';

/** Which VS Code surface holds a session. Only a tab can be revealed by id; a sidebar can only be brought forward. */
export type Surface = 'tab' | 'sidebar';

/**
 * One VS Code window's persisted state, from its `workspaceStorage` directory. Taken verbatim rather than parsed by
 * the reader, so every layer of the unwrapping is testable without a database (`docs/mechanics.md` §21).
 */
export interface WindowStore {
  /** `workspace.json`, naming the window's folder or its `.code-workspace` file. */
  workspaceJson: string | null;
  /** `memento/workbench.parts.editor`, holding one serialised input per editor tab. */
  editor: string | null;
  /** `memento/webviewView.claudeVSCodeSidebarSecondary`, holding the session the sidebar shows now. */
  sidebar: string | null;
  /** When the store was last written. A closed window's state survives it, so recency is what settles a conflict. */
  updatedAt: number;
}

export interface SessionSurface {
  sessionId: string;
  /** What `code` is given to bring the window forward: its folder, or its `.code-workspace` file. */
  root: string;
  surface: Surface;
}

/** The `providedId` every Claude Code editor tab carries, which is what tells one from any other webview. */
const CLAUDE_WEBVIEW = 'claudeVSCodePanel';

const FILE_URI = 'file://';

function parse(text: string | null | undefined): unknown {
  if (typeof text !== 'string') {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** A webview's own state, which is where the Claude extension records the session the surface is showing. */
function sessionIn(state: unknown): string | null {
  const id = (parse(typeof state === 'string' ? state : null) as { sessionID?: unknown } | null)?.sessionID;

  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * The path `code` is given to raise the window. Stored as a percent-encoded file URI, and a Windows drive arrives
 * behind a leading slash that has to go. A window with neither key is one `code` has no argument for.
 */
export function rootFrom(workspaceJson: string | null): string | null {
  const parsed = parse(workspaceJson) as { folder?: unknown; workspace?: unknown } | null;
  const uri = typeof parsed?.folder === 'string' ? parsed.folder : parsed?.workspace;

  if (typeof uri !== 'string' || !uri.startsWith(FILE_URI)) {
    return null;
  }

  let rest: string;

  try {
    rest = decodeURIComponent(uri.slice(FILE_URI.length));
  } catch {
    return null;
  }

  if (rest.length === 0) {
    return null;
  }

  // What follows `file://` is a path only when it starts with a slash; anything else is an authority, which is how a
  // network share is written and has to keep both leading slashes to stay absolute.
  const path = rest.startsWith('/') ? rest : `//${rest}`;

  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
}

/** The session the window's Claude sidebar is showing, or null where it has never shown one. */
export function sidebarSession(sidebar: string | null): string | null {
  return sessionIn((parse(sidebar) as { webviewState?: unknown } | null)?.webviewState);
}

/**
 * Every Claude tab's session in one window. The editor grid nests to whatever depth the developer has split their
 * editors to, so it is walked rather than indexed, and a tab opened but never bound to a session contributes nothing.
 */
export function tabSessions(editor: string | null): string[] {
  const found: string[] = [];

  walk(parse(editor), found);

  return found;
}

function walk(node: unknown, found: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      walk(child, found);
    }

    return;
  }

  if (typeof node !== 'object' || node === null) {
    return;
  }

  const record = node as Record<string, unknown>;
  const value = record['value'];
  const input = parse(typeof value === 'string' ? value : null) as { providedId?: unknown; state?: unknown } | null;

  if (input?.providedId === CLAUDE_WEBVIEW) {
    const sessionId = sessionIn(input.state);

    if (sessionId !== null) {
      found.push(sessionId);
    }
  }

  for (const child of Object.values(record)) {
    walk(child, found);
  }
}

/**
 * Where each session is held, across every window. Two rules settle a session more than one record names: the window
 * that wrote most recently wins, and within one window a tab beats the sidebar, being the only surface reachable by id.
 */
export function surfacesFrom(stores: readonly WindowStore[]): SessionSurface[] {
  const surfaces = new Map<string, SessionSurface>();
  const rooted = stores.flatMap((store) => {
    const root = rootFrom(store.workspaceJson);

    return root === null ? [] : [{ store, root }];
  });

  // Windows are flushed on a shared cycle, so two stores can carry the same timestamp; the root breaks the tie, which
  // keeps the answer off the order the storage directories happened to be listed in.
  rooted.sort((a, b) => a.store.updatedAt - b.store.updatedAt || dirKey(a.root).localeCompare(dirKey(b.root)));

  for (const { store, root } of rooted) {
    const sidebar = sidebarSession(store.sidebar);

    if (sidebar !== null) {
      surfaces.set(sidebar, { sessionId: sidebar, root, surface: 'sidebar' });
    }

    for (const sessionId of tabSessions(store.editor)) {
      surfaces.set(sessionId, { sessionId, root, surface: 'tab' });
    }
  }

  return [...surfaces.values()];
}
