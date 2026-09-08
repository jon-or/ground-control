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
      expect(placement.reveal('a-session').value).toContain('a-session');
    }
  });

  it('reveals a Claude session by id, and a Codex thread by the resource its editor is registered for', () => {
    expect(PLACEMENTS['claude']!.reveal('abc')).toEqual({
      command: 'claude-vscode.primaryEditor.open',
      kind: 'id',
      value: 'abc',
    });

    // `vscode.open` takes a `Uri` instance or an http/https string and refuses any other string outright, so a
    // resource has to be named as one — the client is the only place a `Uri` can be built.
    expect(PLACEMENTS['codex']!.reveal('abc')).toEqual({
      command: 'vscode.open',
      kind: 'uri',
      value: 'openai-codex://route/local/abc',
    });
  });

  it('offers a URI only for the agent whose extension answers one', () => {
    expect(PLACEMENTS['claude']!.openUri!('abc def')).toContain('abc%20def');
    // Codex's deep links never resolved when fired at a window, so the board must not pretend it can reach one (§44).
    expect(PLACEMENTS['codex']!.openUri).toBeUndefined();
  });

  /** §44: Codex's sidebar mementos are always empty, so nothing reads them and no route focuses that view. */
  it('reads no sidebar, and focuses none, for the agent whose sidebar records nothing', () => {
    expect(PLACEMENTS['claude']!.sidebarKeys.length).toBeGreaterThan(0);
    expect(PLACEMENTS['claude']!.sidebarFocusCommands.length).toBeGreaterThan(0);
    expect(PLACEMENTS['codex']!.sidebarKeys).toEqual([]);
    expect(PLACEMENTS['codex']!.sidebarFocusCommands).toEqual([]);
  });

  /** §44: nothing Codex writes says which window holds a thread, so no directory is invented for it. */
  it('names a lock directory only for the agent whose windows announce themselves', () => {
    expect(PLACEMENTS['claude']!.lockDir!('/home/dev', {})).toBe('/home/dev/.claude/ide');
    expect(PLACEMENTS['codex']!.lockDir).toBeUndefined();
  });

  /**
   * §47: the pid a session reports belongs to a process the window's extension host started, which is what ties a
   * session to a window. Claude's session is `claude.exe`; a Codex thread runs inside the extension's app-server.
   */
  it('names the executable whose parent is the window running the session', () => {
    expect(PLACEMENTS['claude']!.processName).toBe('claude.exe');
    expect(PLACEMENTS['codex']!.processName).toBe('codex.exe');
  });

  /** §6, §44: Claude's reveal forks a surface, so only Codex's may be fired at an unrecorded one. */
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

  it('treats an empty or blank setting as unset rather than as the filesystem root', () => {
    expect(claudeDirOf('C:/Users/dev', '')).toBe('C:/Users/dev/.claude');
    expect(claudeDirOf('C:/Users/dev', '   ')).toBe('C:/Users/dev/.claude');
  });
});
