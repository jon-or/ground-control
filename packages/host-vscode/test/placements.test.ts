import { describe, expect, it } from 'vitest';
import { PLACEMENTS, claudeDirOf } from '../src/placements.js';
import { planOpen } from '../src/open.js';
import { session } from './helpers.js';

describe('the placement table', () => {
  it('carries every identifier a route needs for each placed agent', () => {
    expect(Object.keys(PLACEMENTS)).toEqual(['claude']);

    for (const placement of Object.values(PLACEMENTS)) {
      expect(placement.webviewId.length).toBeGreaterThan(0);
      expect(placement.sidebarKeys.length).toBeGreaterThan(0);
      expect(placement.stateKey.length).toBeGreaterThan(0);
      expect(placement.extensionId.length).toBeGreaterThan(0);
      expect(placement.revealCommand.length).toBeGreaterThan(0);
      expect(placement.sidebarFocusCommands.length).toBeGreaterThan(0);
      expect(placement.lockDir('/home/dev', {})).toContain('/home/dev');
      expect(placement.openUri('abc def')).toContain('abc%20def');
    }
  });

  it('refuses an agent outside the table, because the host has no record of where its sessions show', () => {
    const codex = session({ agent: 'codex' });
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
    expect(PLACEMENTS['claude']!.lockDir('C:/Users/dev', {})).toBe('C:/Users/dev/.claude/ide');
  });

  it('honours CLAUDE_CONFIG_DIR, which moves the directory wholesale', () => {
    expect(claudeDirOf('C:/Users/dev', 'd:/config/claude')).toBe('d:/config/claude');
    expect(PLACEMENTS['claude']!.lockDir('C:/Users/dev', { CLAUDE_CONFIG_DIR: 'd:/config/claude' })).toBe(
      'd:/config/claude/ide',
    );
  });

  it('treats an empty or blank setting as unset rather than as the filesystem root', () => {
    expect(claudeDirOf('C:/Users/dev', '')).toBe('C:/Users/dev/.claude');
    expect(claudeDirOf('C:/Users/dev', '   ')).toBe('C:/Users/dev/.claude');
  });
});
