import { dirKey } from '@ground-control/core';
import type { SessionSurface } from '@ground-control/core';
import type { AgentPlacement, SessionInTab } from './placements.js';

/**
 * Raw state from a window's workspaceStorage directory. Parse separately so nested formats can be tested
 * without SQLite (M21).
 */
export interface WindowStore {
  /** `workspace.json`, naming the window's folder or its `.code-workspace` file. */
  workspaceJson: string | null;
  /** `memento/workbench.parts.editor`, holding one serialised input per editor tab. */
  editor: string | null;
  /** Agent sidebar memento containing the displayed session. */
  sidebar: string | null;
  /** Database write time, used to prefer recent records over stale window state. */
  updatedAt: number;
}

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

/** Read the displayed session from agent webview state. */
function sessionIn(state: unknown, stateKey: string): string | null {
  const parsed = parse(typeof state === 'string' ? state : null) as Record<string, unknown> | null;
  const id = parsed?.[stateKey];

  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Read session identity from the editor resource URI. Use path: fsPath has platform separators and external is
 * percent-encoded (M44).
 */
function sessionAt(resource: unknown, want: { scheme: string; prefix: string }): string | null {
  const uri = resource as { scheme?: unknown; path?: unknown } | null;

  if (uri?.scheme !== want.scheme || typeof uri.path !== 'string' || !uri.path.startsWith(want.prefix)) {
    return null;
  }

  const id = uri.path.slice(want.prefix.length);

  return id.length > 0 && !id.includes('/') ? id : null;
}

/** Read a tab's session using its agent placement. */
function sessionOf(input: Record<string, unknown>, session: SessionInTab): string | null {
  return session.from === 'state'
    ? sessionIn(input['state'], session.key)
    : sessionAt(input['editorResource'], session);
}

/**
 * Decode the window's folder or workspace URI for code. Strip the leading slash before Windows drive letters;
 * return null when neither key exists.
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

  // Preserve the authority and leading double slash for network-share paths.
  const path = rest.startsWith('/') ? rest : `//${rest}`;

  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
}

/** Read the sidebar session, or null when none is recorded. */
export function sidebarSession(sidebar: string | null, session: SessionInTab): string | null {
  // Codex sidebar state contains no session ID (M44).
  return session.from === 'state'
    ? sessionIn((parse(sidebar) as { webviewState?: unknown } | null)?.webviewState, session.key)
    : null;
}

/** Walk nested editor groups to collect the agent's session IDs. Ignore tabs with no session assigned. */
export function tabSessions(editor: string | null, placement: Pick<AgentPlacement, 'webviewId' | 'session'>): string[] {
  const found: string[] = [];

  walk(parse(editor), placement, found);

  return found;
}

function walk(node: unknown, placement: Pick<AgentPlacement, 'webviewId' | 'session'>, found: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      walk(child, placement, found);
    }

    return;
  }

  if (typeof node !== 'object' || node === null) {
    return;
  }

  const record = node as Record<string, unknown>;
  const value = record['value'];
  const input = parse(typeof value === 'string' ? value : null) as Record<string, unknown> | null;

  if (input?.['providedId'] === placement.webviewId) {
    const sessionId = sessionOf(input, placement.session);

    if (sessionId !== null) {
      found.push(sessionId);
    }
  }

  for (const child of Object.values(record)) {
    walk(child, placement, found);
  }
}

/**
 * Locate sessions across windows and agents. Prefer the latest window record, then a tab over a sidebar because
 * tabs can be revealed by ID.
 */
export function surfacesFrom(
  stores: readonly WindowStore[],
  placements: Readonly<Record<string, AgentPlacement>>,
): SessionSurface[] {
  const surfaces = new Map<string, SessionSurface>();
  const rooted = stores.flatMap((store) => {
    const root = rootFrom(store.workspaceJson);

    return root === null ? [] : [{ store, root }];
  });

  // Break timestamp ties by root for stable results independent of directory listing order.
  rooted.sort((a, b) => a.store.updatedAt - b.store.updatedAt || dirKey(a.root).localeCompare(dirKey(b.root)));

  for (const { store, root } of rooted) {
    for (const [agent, placement] of Object.entries(placements)) {
      const sidebar = sidebarSession(store.sidebar, placement.session);

      if (sidebar !== null) {
        surfaces.set(sidebar, { agent, sessionId: sidebar, root, surface: 'sidebar' });
      }

      for (const sessionId of tabSessions(store.editor, placement)) {
        surfaces.set(sessionId, { agent, sessionId, root, surface: 'tab' });
      }
    }
  }

  return [...surfaces.values()];
}
