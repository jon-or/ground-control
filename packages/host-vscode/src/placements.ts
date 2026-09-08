import { join } from '@ground-control/core';

/**
 * Where one agent's integration with VS Code records its sessions, and the commands that reach them. The host owns
 * the storage format and the agent owns the identifiers, so this table is the host's, keyed by agent id.
 */
/**
 * Where a tab of this agent's records which session it is showing. Two shapes, because the two extensions record it
 * differently and neither is ours: Claude keeps a session id inside the webview's own state, and Codex has no state
 * at all — its tab *is* the session, addressed by the resource URI it was opened with (`docs/mechanics.md` §44).
 */
export type SessionInTab =
  | { from: 'state'; key: string }
  | { from: 'resource'; scheme: string; prefix: string };

/**
 * What a reveal runs in the window holding the session: a command, and the one argument it takes. `kind` is what
 * the argument *is*, because `vscode.open` validates its first argument as a `Uri` instance or an http/https
 * string and rejects any other string outright — and a `Uri` can only be built where `vscode` is importable.
 */
export interface RevealCall {
  command: string;
  kind: 'id' | 'uri';
  value: string;
}

export interface AgentPlacement {
  /** The `providedId` of the agent's editor-tab webview, which tells its tabs from any other webview (§21). */
  webviewId: string;
  /**
   * Memento keys of the agent's sidebar view, preferred first: only one is registered on a given VS Code. Empty
   * where the agent's sidebar records nothing — Codex's is always `{}`, so a thread held there is invisible (§44).
   */
  sidebarKeys: readonly string[];
  /** How a tab says which session it holds. */
  session: SessionInTab;
  /**
   * Where the agent's windows announce themselves, one lock file per window (`docs/mechanics.md` §22). Absent for
   * an agent that announces none, which is a host that finds no windows of its own to raise for it.
   */
  lockDir?(home: string, env: NodeJS.ProcessEnv): string;
  extensionId: string;
  /**
   * The Windows image name of the process a session's pid belongs to, whose parent is the extension host of the
   * window showing it (§22, §47). Claude's session is that process; Codex's is the app-server its extension runs.
   */
  processName: string;
  /** Reveals a tab for one session without writing the developer's preferred location (`docs/mechanics.md` §6). */
  reveal(sessionId: string): RevealCall;
  /**
   * Whether a reveal re-activates the surface already holding the session rather than opening a second agent on it
   * (§6, §44). Only an idempotent one may be fired at a window whose surface VS Code has not recorded.
   */
  idempotentReveal: boolean;
  /** The views' own focus commands, tried in order; the one not registered on this VS Code rejects. */
  sidebarFocusCommands: readonly string[];
  /**
   * The OS URI the agent's extension handles, so a window needs nothing of ours in it (`docs/mechanics.md` §7).
   * Absent where the agent has none that resolves — Codex's deep links never answered (§44), so a client that is
   * resident in nothing cannot reach a Codex session at all.
   */
  openUri?(sessionId: string): string;
}

/**
 * Where Claude Code keeps its state. `CLAUDE_CONFIG_DIR` moves the whole directory, and a developer who has set it has
 * no `~/.claude` for anything to be found under — every window would read as closed rather than as unreadable.
 */
export function claudeDirOf(home: string, configDir: string | undefined): string {
  const configured = configDir?.trim();

  return configured ? configured : join(home, '.claude');
}

/** The scheme Codex registered its conversation editor for, and the host segment a local thread sits under. */
const CODEX_SCHEME = 'openai-codex';
const CODEX_LOCAL = '/local/';

/** Where Codex keeps its home. `CODEX_HOME` moves the whole directory, the way `CLAUDE_CONFIG_DIR` moves Claude's. */
export function codexDirOf(home: string, configured: string | undefined): string {
  const named = configured?.trim();

  return named ? named : join(home, '.codex');
}

export const PLACEMENTS: Readonly<Record<string, AgentPlacement>> = {
  claude: {
    webviewId: 'claudeVSCodePanel',
    sidebarKeys: ['memento/webviewView.claudeVSCodeSidebarSecondary', 'memento/webviewView.claudeVSCodeSidebar'],
    session: { from: 'state', key: 'sessionID' },
    lockDir: (home, env) => join(claudeDirOf(home, env['CLAUDE_CONFIG_DIR']), 'ide'),
    extensionId: 'Anthropic.claude-code',
    processName: 'claude.exe',
    idempotentReveal: false,
    reveal: (sessionId) => ({ command: 'claude-vscode.primaryEditor.open', kind: 'id', value: sessionId }),
    sidebarFocusCommands: ['claudeVSCodeSidebarSecondary.focus', 'claudeVSCodeSidebar.focus'],
    openUri: (sessionId) => `vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`,
  },

  /**
   * Codex's thread is an editor resource rather than a webview holding an id, so the reveal is VS Code's own
   * `vscode.open` on the URI its extension registered a custom editor for — which is the call the Codex extension
   * makes on itself, and is idempotent: a second one re-activates the tab rather than forking a surface (§44).
   */
  codex: {
    webviewId: 'chatgpt.conversationEditor',
    // Its sidebar mementos exist and are always `{}`, so reading them would only ever find nothing.
    sidebarKeys: [],
    session: { from: 'resource', scheme: CODEX_SCHEME, prefix: CODEX_LOCAL },
    // No `lockDir`: Codex announces no window anywhere. What it writes per thread says which thread is being
    // written, never which window is writing it (§44), so there is no directory to name and none is invented.
    extensionId: 'openai.chatgpt',
    // The thread runs inside `codex app-server`, which the extension spawns per window, so the pid the hook records
    // is that process and its parent is the window's extension host (§47).
    processName: 'codex.exe',
    idempotentReveal: true,
    reveal: (sessionId) => ({ command: 'vscode.open', kind: 'uri', value: `${CODEX_SCHEME}://route${CODEX_LOCAL}${sessionId}` }),
    // Codex's sidebar records nothing the board can read (§44), so no route ever reaches a focus command for it.
    sidebarFocusCommands: [],
  },
};
