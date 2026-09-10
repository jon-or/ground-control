import { describe, expect, it } from 'vitest';
import { projectDirName, repositoryWindowFor, worktreePointer } from '../src/worktree.js';

describe('naming the project directory Claude reads for a working directory', () => {
  it('replaces every non-alphanumeric character with a dash', () => {
    expect(projectDirName('D:\\wtp\\.claude\\worktrees\\w')).toBe('D--wtp--claude-worktrees-w');
    expect(projectDirName('/home/dev/repo')).toBe('-home-dev-repo');
  });

  it('refuses a name the override rejects, which would silently keep the window own sessions', () => {
    expect(projectDirName(`/${'a'.repeat(64)}`)).toBeNull();
    expect(projectDirName(`/${'a'.repeat(62)}`)).toBe(`-${'a'.repeat(62)}`);
  });
});

describe('choosing the repository window for a worktree session', () => {
  it('accepts the layout Claude binds a resumed working directory for', () => {
    expect(repositoryWindowFor('D:\\wtp\\.claude\\worktrees\\w')).toBe('D:\\wtp');
    expect(repositoryWindowFor('/src/repo/.claude/worktrees/feature')).toBe('/src/repo');
  });

  it('keeps a window on the checkout for any other layout, which would otherwise run in the repository', () => {
    expect(repositoryWindowFor('D:\\git\\repo.worktrees\\feature')).toBeNull();
    expect(repositoryWindowFor('D:\\git\\repo')).toBeNull();
    expect(repositoryWindowFor('D:\\git\\repo\\.claude\\worktrees\\a\\nested')).toBeNull();
  });

  it('keeps a window on the checkout when the path is too long to name', () => {
    expect(repositoryWindowFor(`/${'a'.repeat(40)}/.claude/worktrees/feature`)).toBeNull();
  });
});

describe('the environment that redirects one window to a worktree', () => {
  const ID = 'a1b2c3d4-0000-4000-8000-000000000000';
  const held = (path: string) => path === `/home/.claude/projects/-wtp--claude-worktrees-w/${ID}.jsonl`;

  it('sets both variables, because the override applies only alongside the configuration directory', () => {
    expect(worktreePointer(ID, '/wtp/.claude/worktrees/w', '/home', {}, held)).toEqual({
      CLAUDE_CONFIG_DIR: '/home/.claude',
      CLAUDE_CODE_PROJECT_DIR_NAME: '-wtp--claude-worktrees-w',
    });
  });

  it('keeps a configuration directory the developer already set, changing only the project directory', () => {
    const env = { CLAUDE_CONFIG_DIR: '/elsewhere/.claude' };
    const there = (path: string) => path === `/elsewhere/.claude/projects/-wtp--claude-worktrees-w/${ID}.jsonl`;

    expect(worktreePointer(ID, '/wtp/.claude/worktrees/w', '/home', env, there)).toMatchObject({ CLAUDE_CONFIG_DIR: '/elsewhere/.claude' });
  });

  it('refuses rather than resume an empty session when the override cannot apply', () => {
    expect(worktreePointer(ID, `/${'a'.repeat(64)}`, '/home', {}, held)).toContain('64 characters');
    // A redirect to a directory holding no transcript for this session would open a new one instead.
    expect(worktreePointer(ID, '/wtp/.claude/worktrees/other', '/home', {}, held)).toContain('no saved transcript');
    expect(worktreePointer('a1b2c3d4-0000-4000-8000-000000000009', '/wtp/.claude/worktrees/w', '/home', {}, held)).toContain('no saved transcript');
  });
});
