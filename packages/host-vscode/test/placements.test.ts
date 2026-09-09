import { describe, expect, it } from 'vitest';
import { PLACEMENTS, claudeDirOf } from '../src/placements.js';
import { planOpen } from '../src/open.js';
import { session } from './helpers.js';

describe('the placement table', () => {
  it('carries every identifier a route needs for each placed agent', () => {
    expect(Object.keys(PLACEMENTS)).toEqual(['claude', 'codex']);

    for (const placement of Object.values(PLACEMENTS)) {
      expect(placement.webviewId.length).toBeGreaterThan(0);
      expect(placement.extensionId.length).toBeGreaterThan(0);
      expect(placement.reveal('a-session').command.length).toBeGreaterThan(0);
      expect(placement.reveal('a-session').args.map((arg) => ('value' in arg ? arg.value : '')).join(' ')).toContain('a-session');
    }
  });

  it('reveals a Claude session by id, and a Codex thread by the resource its editor is registered for', () => {
    expect(PLACEMENTS['claude']!.reveal('abc')).toEqual({
      command: 'claude-vscode.primaryEditor.open',
      args: [{ kind: 'text', value: 'abc' }],
    });

    // Custom schemes require a Uri instance. The extension host converts the plan's URI argument.
    expect(PLACEMENTS['codex']!.reveal('abc')).toEqual({
      command: 'vscode.open',
      args: [{ kind: 'uri', value: 'openai-codex://route/local/abc' }],
    });
  });

  /**
   * Claude starts through its reveal command with the session slot absent; Codex uses a no-argument command
   * (M51).
   */
  it('checks complete start commands and prompt positions', () => {
    expect(PLACEMENTS['claude']!.start!('do the thing')).toEqual({
      command: 'claude-vscode.primaryEditor.open',
      args: [{ kind: 'absent' }, { kind: 'text', value: 'do the thing' }],
    });

    // Omit both session and prompt slots for an empty session; an empty string would prefill a blank prompt.
    expect(PLACEMENTS['claude']!.start!(null)).toEqual({
      command: 'claude-vscode.primaryEditor.open',
      args: [{ kind: 'absent' }, { kind: 'absent' }],
    });

    expect(PLACEMENTS['codex']!.start!('do the thing')).toEqual({ command: 'chatgpt.newCodexPanel', args: [] });
  });

  it('identifies agents whose start command accepts a prompt', () => {
    expect(PLACEMENTS['claude']!.startTakesPrompt).toBe(true);
    expect(PLACEMENTS['codex']!.startTakesPrompt).toBe(false);
  });

  it('offers a URI only for the agent whose extension answers one', () => {
    expect(PLACEMENTS['claude']!.openUri!('abc def')).toContain('abc%20def');
    // No working Codex OS deep link was measured (M44).
    expect(PLACEMENTS['codex']!.openUri).toBeUndefined();
  });

  /** M44: Codex's sidebar mementos are always empty, so nothing reads them and no route focuses that view. */
  it('reads no sidebar, and focuses none, for the agent whose sidebar records nothing', () => {
    expect(PLACEMENTS['claude']!.sidebarKeys.length).toBeGreaterThan(0);
    expect(PLACEMENTS['claude']!.sidebarFocusCommands.length).toBeGreaterThan(0);
    expect(PLACEMENTS['codex']!.sidebarKeys).toEqual([]);
    expect(PLACEMENTS['codex']!.sidebarFocusCommands).toEqual([]);
  });

  /** Codex has no IDE lock directory (M44); process ancestry provides separate window evidence (M47). */
  it('names a lock directory only for the agent whose windows announce themselves', () => {
    expect(PLACEMENTS['claude']!.lockDir!('/home/dev', {})).toBe('/home/dev/.claude/ide');
    expect(PLACEMENTS['codex']!.lockDir).toBeUndefined();
  });

  /** Check both process names for extension-host ancestry: claude.exe and the Codex app-server (M47). */
  it('names the executable whose parent is the window running the session', () => {
    expect(PLACEMENTS['claude']!.processName).toBe('claude.exe');
    expect(PLACEMENTS['codex']!.processName).toBe('codex.exe');
  });

  /** Only Codex supports idempotent reveal when the current surface is unknown (M6, M44). */
  it('claims an idempotent reveal only for the agent whose reveal re-activates the surface', () => {
    expect(PLACEMENTS['claude']!.idempotentReveal).toBe(false);
    expect(PLACEMENTS['codex']!.idempotentReveal).toBe(true);
  });

  it('refuses an agent outside the table, because the host has no record of where its sessions show', () => {
    const codex = session({ agent: 'gemini' });
    const plan = planOpen(
      {
        sessionId: codex.sessionId,
        sessions: [codex],
        surfaces: [],
        window: null,
        liveRoots: [],
        workspaceRoot: null,
        extensionReady: true,
        now: codex.startedAt,
      },
      PLACEMENTS,
      true,
    );

    expect('refusal' in plan && plan.refusal).toBe('other-agent');
  });
});

describe('claudeDirOf', () => {
  it('defaults to the home directory, where Claude Code keeps its state', () => {
    expect(claudeDirOf('C:/Users/dev', undefined)).toBe('C:/Users/dev/.claude');
    expect(PLACEMENTS['claude']!.lockDir!('C:/Users/dev', {})).toBe('C:/Users/dev/.claude/ide');
  });

  it('honours CLAUDE_CONFIG_DIR, which moves the directory wholesale', () => {
    expect(claudeDirOf('C:/Users/dev', 'd:/config/claude')).toBe('d:/config/claude');
    expect(PLACEMENTS['claude']!.lockDir!('C:/Users/dev', { CLAUDE_CONFIG_DIR: 'd:/config/claude' })).toBe(
      'd:/config/claude/ide',
    );
  });

  it('treats blank storage settings as unset', () => {
    expect(claudeDirOf('C:/Users/dev', '')).toBe('C:/Users/dev/.claude');
    expect(claudeDirOf('C:/Users/dev', '   ')).toBe('C:/Users/dev/.claude');
  });
});
