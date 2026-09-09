import { join } from '@ground-control/core';

/** Read Claude session IDs from webview state and Codex IDs from editor resource URIs (M44). */
export type SessionInTab =
  | { from: 'state'; key: string }
  | { from: 'resource'; scheme: string; prefix: string };

/** `uri` arguments become vscode.Uri instances in the extension host; vscode.open rejects raw custom-scheme strings.
 * `absent` preserves positional gaps, including the session-ID slot before a new Claude prompt. */
export type CommandArg = { kind: 'text'; value: string } | { kind: 'uri'; value: string } | { kind: 'absent' };

/** A command plan built without vscode and executed in the extension host. */
export interface CommandCall {
  command: string;
  args: readonly CommandArg[];
}

export interface AgentPlacement {
  /** Agent editor-tab `providedId`, used to exclude other webviews (M21). */
  webviewId: string;
  /** Sidebar memento keys, in preference order. Empty for Codex: its recorded sidebar state is `{}` and does not identify the thread (M44). */
  sidebarKeys: readonly string[];
  /** Session identity location in an editor tab. */
  session: SessionInTab;
  /** Optional agent IDE lock directory, with one file per window (M22). Process ancestry provides separate window evidence. */
  lockDir?(home: string, env: NodeJS.ProcessEnv): string;
  extensionId: string;
  /**
   * Windows executable name for session PID lookup. Its parent is the window's extension host: Claude runs
   * directly; Codex runs in an app-server (M22, M47).
   */
  processName: string;
  /** Reveals a tab for one session without writing the developer's preferred location (`docs/mechanics.md` M6). */
  reveal(sessionId: string): CommandCall;
  /** Start a session in the target window (M51). Prompt prefilling depends on startTakesPrompt. Absent when no start command is supported. */
  start?(prompt: string | null): CommandCall;
  /** Whether the start command accepts a prompt. */
  startTakesPrompt: boolean;
  /**
   * Whether reveal focuses an existing surface without starting a duplicate agent. Required when VS Code has
   * not recorded the surface (M6, M44).
   */
  idempotentReveal: boolean;
  /** Sidebar focus commands in fallback order; unavailable commands reject. */
  sidebarFocusCommands: readonly string[];
  /** Agent-provided OS URI for opening a session without Ground Control in the target window (M7). No working Codex deep link was measured (M44). */
  openUri?(sessionId: string): string;
}

/** Resolve Claude storage, respecting CLAUDE_CONFIG_DIR for session and window discovery. */
export function claudeDirOf(home: string, configDir: string | undefined): string {
  const configured = configDir?.trim();

  return configured ? configured : join(home, '.claude');
}

/** Codex conversation-editor scheme and local-thread path prefix. */
const CODEX_SCHEME = 'openai-codex';
const CODEX_LOCAL = '/local/';

/** Resolve Codex storage, respecting CODEX_HOME. */
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
    reveal: (sessionId) => ({ command: 'claude-vscode.primaryEditor.open', args: [{ kind: 'text', value: sessionId }] }),
    // An empty session-ID slot makes the webview allocate the ID (M51). primaryEditor.open preserves the
    // preferred location; editor.open would change it (M6).
    start: (prompt) => ({
      command: 'claude-vscode.primaryEditor.open',
      args: [{ kind: 'absent' }, prompt === null ? { kind: 'absent' } : { kind: 'text', value: prompt }],
    }),
    startTakesPrompt: true,
    sidebarFocusCommands: ['claudeVSCodeSidebarSecondary.focus', 'claudeVSCodeSidebar.focus'],
    openUri: (sessionId) => `vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`,
  },

  /**
   * Codex opens its registered editor-resource URI through `vscode.open`. Repeating the call focuses the
   * existing tab (M44).
   */
  codex: {
    webviewId: 'chatgpt.conversationEditor',
    // Codex sidebar mementos contain only `{}`.
    sidebarKeys: [],
    session: { from: 'resource', scheme: CODEX_SCHEME, prefix: CODEX_LOCAL },
    // Codex has no measured IDE lock directory. Its thread records do not identify the window (M44).
    extensionId: 'openai.chatgpt',
    // The hook records the per-window `codex app-server` PID; its parent is the extension host (M47).
    processName: 'codex.exe',
    idempotentReveal: true,
    reveal: (sessionId) => ({ command: 'vscode.open', args: [{ kind: 'uri', value: `${CODEX_SCHEME}://route${CODEX_LOCAL}${sessionId}` }] }),
    // This command accepts no prompt (M51). startTakesPrompt lets the menu disclose that limitation.
    start: () => ({ command: 'chatgpt.newCodexPanel', args: [] }),
    startTakesPrompt: false,
    // Codex sidebar state has no session ID, so no route can select it (M44).
    sidebarFocusCommands: [],
  },
};
