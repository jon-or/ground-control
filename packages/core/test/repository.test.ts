import { describe, expect, it } from 'vitest';
import { repositoryKey, repositoryOf } from '../src/repository.js';

describe('repository identity for history', () => {
  it.each(['https://github.com/Org/Repo.git', 'git@github.com:Org/Repo.git', 'ssh://git@github.com/Org/Repo', 'https://github.com/Org/Repo/issues/42'])(
    'compares %s by repository', (url) => expect(repositoryKey(url)).toBe('github.com/org/repo'),
  );
  it.each(['not a remote', 'https://github.com/owner', 'file:///local/repo'])('refuses %s', (url) => expect(repositoryKey(url)).toBeNull());
  it('follows relative gitdir and commondir from a subdirectory without reading HEAD', () => {
    const files: Record<string, string> = {
      '/work/42-test/.git': 'gitdir: ../repo/.git/worktrees/test',
      '/work/repo/.git/worktrees/test/commondir': '../..',
      '/work/repo/.git/config': '[core]\n bare = false\n[remote "origin"]\n url = git@github.com:Org/Repo.git\n[branch "main"]\n remote = origin',
    };
    const calls: string[] = [];
    expect(repositoryOf('/work/42-test/src', (p) => { calls.push(p); return files[p] ?? null; })).toBe('github.com/org/repo');
    expect(calls.some((p) => p.endsWith('/HEAD'))).toBe(false);
  });
  it('handles absolute worktree paths and refuses a checkout with no origin', () => {
    const files: Record<string, string> = { '/work/test/.git': 'gitdir: /git/worktrees/test', '/git/worktrees/test/commondir': '/git', '/git/config': '[remote "other"]\n url = https://github.com/other/repo' };
    expect(repositoryOf('/work/test', (p) => files[p] ?? null)).toBeNull();
    expect(repositoryOf('/deleted/42-worktree', () => null)).toBeNull();
  });
});


it.each(['"https://github.com/org/repo.git"', '"https://github.com/org/repo.git" # comment', 'https://github.com/org/repo.git ; comment', '"https://github.com/org/repo.git"'])('reads Git config value %s', (value) => {
  expect(repositoryOf('/work/repo', (p) => p === '/work/repo/.git/config' ? `[remote "origin"]\n url = ${value}` : null)).toBe('github.com/org/repo');
});
it.each(['"unterminated', 'https://github.com/org/repo' + String.fromCharCode(92) + 'q'])('refuses malformed config quoting %s', (value) => {
  expect(repositoryOf('/work/repo', (p) => p === '/work/repo/.git/config' ? `[remote "origin"]\n url = ${value}` : null)).toBeNull();
});
