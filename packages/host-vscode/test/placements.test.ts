import { describe, expect, it } from 'vitest';
import { PLACEMENTS, claudeDirOf, opensInSidebar } from '../src/placements.js';
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

  /** M63: the sixth argument makes Claude route by its preferred location without writing it. */
  it('opens a Claude session, or starts one, through the preferred-location route', () => {
    const route = PLACEMENTS['claude']!.sidebarOpen!;
    const preferred = { kind: 'object', value: { programmatic: 'honor-preferred-location' } };
    const gap = { kind: 'absent' };

    expect(route.command('abc', null)).toEqual({
      command: 'claude-vscode.editor.open',
      args: [{ kind: 'text', value: 'abc' }, gap, gap, gap, gap, preferred],
    });
    expect(route.command(null, 'do the thing')).toEqual({
      command: 'claude-vscode.editor.open',
      args: [gap, { kind: 'text', value: 'do the thing' }, gap, gap, gap, preferred],
    });
    expect(`${route.section}.${route.key}`).toBe('claudeCode.preferredLocation');
    expect(PLACEMENTS['codex']!.sidebarOpen).toBeUndefined();
    expect(PLACEMENTS['codex']!.editorExecutable).toBeUndefined();
  });

  it('sends an open to the sidebar only when the developer chose it and Claude prefers the sidebar', () => {
    const claude = PLACEMENTS['claude']!;

    expect(opensInSidebar(claude, 'preferred', 'sidebar')).toBe(true);
    expect(opensInSidebar(claude, 'editor', 'sidebar')).toBe(false);
    // Claude would open a tab, and a session the sidebar holds would gain a second process (M6).
    expect(opensInSidebar(claude, 'preferred', 'panel')).toBe(false);
    expect(opensInSidebar(claude, 'preferred', undefined)).toBe(false);
    expect(opensInSidebar(PLACEMENTS['codex']!, 'preferred', 'sidebar')).toBe(false);
  });

  it('identifies agents whose start command accepts a prompt', () => {
    expect(PLACEMENTS['claude']!.startTakesPrompt).toBe(true);
    expect(PLACEMENTS['codex']!.startTakesPrompt).toBe(false);
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
      { mayOpenWindow: true, resumeWorktreesInRepositoryWindow: false },
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
