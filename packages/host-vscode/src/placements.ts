import { join } from '@ground-control/core';

/**
 * Where one agent's integration with VS Code records its sessions, and the commands that reach them. The host owns
 * the storage format and the agent owns the identifiers, so this table is the host's, keyed by agent id.
 */
export interface AgentPlacement {
  /** The `providedId` of the agent's editor-tab webview, which tells its tabs from any other webview (§21). */
  webviewId: string;
  /** Memento keys of the agent's sidebar view, preferred first: only one is registered on a given VS Code. */
  sidebarKeys: readonly string[];
  /** The key in a webview's own state carrying the session id. */
  stateKey: string;
  /** Where the agent's windows announce themselves, one lock file per window (`docs/mechanics.md` §22). */
  lockDir(home: string, env: NodeJS.ProcessEnv): string;
  extensionId: string;
  /** Reveals a tab by session id without writing the developer's preferred location (`docs/mechanics.md` §6). */
  revealCommand: string;
  /** The views' own focus commands, tried in order; the one not registered on this VS Code rejects. */
  sidebarFocusCommands: readonly string[];
  /** The OS URI the agent's extension handles, so a window needs nothing of ours in it (`docs/mechanics.md` §7). */
  openUri(sessionId: string): string;
}

/**
 * Where Claude Code keeps its state. `CLAUDE_CONFIG_DIR` moves the whole directory, and a developer who has set it has
 * no `~/.claude` for anything to be found under — every window would read as closed rather than as unreadable.
 */
export function claudeDirOf(home: string, configDir: string | undefined): string {
  const configured = configDir?.trim();

  return configured ? configured : join(home, '.claude');
}

export const PLACEMENTS: Readonly<Record<string, AgentPlacement>> = {
  claude: {
    webviewId: 'claudeVSCodePanel',
    sidebarKeys: ['memento/webviewView.claudeVSCodeSidebarSecondary', 'memento/webviewView.claudeVSCodeSidebar'],
    stateKey: 'sessionID',
    lockDir: (home, env) => join(claudeDirOf(home, env['CLAUDE_CONFIG_DIR']), 'ide'),
    extensionId: 'Anthropic.claude-code',
    revealCommand: 'claude-vscode.primaryEditor.open',
    sidebarFocusCommands: ['claudeVSCodeSidebarSecondary.focus', 'claudeVSCodeSidebar.focus'],
    openUri: (sessionId) => `vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`,
  },
};
