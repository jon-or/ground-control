import { describe, expect, it } from 'vitest';
import { compilePattern, findCheckout, issueNumberFrom, linkOf } from '../src/link.js';
import type { ReadText } from '../src/link.js';
import { gitReads } from './helpers.js';

const read = gitReads();
const { pattern } = compilePattern('^(\\d+)-');

const WORKTREE = 'd:/work/repo.worktrees/18941-inbox-badge-overwrites-a-manual-edit';
const BRANCH = '18941-inbox-badge-overwrites-a-manual-edit';
const CLONE = 'd:/work/repo';

describe('findCheckout', () => {
  it('follows a worktree gitdir pointer to the branch', () => {
    expect(findCheckout(WORKTREE.replace(/\//g, '\\'), read)).toEqual({ root: WORKTREE, branch: BRANCH });
  });

  it('reads HEAD directly when .git is a directory', () => {
    expect(findCheckout(CLONE, read)?.branch).toBe('main');
  });

  it('keeps a branch name containing a slash intact', () => {
    expect(findCheckout('c:/users/dev/.tools/worktrees/worker-1', read)?.branch).toBe('team/worker-1');
  });

  it('searches upward, so a session started in a subdirectory finds its checkout', () => {
    expect(findCheckout(`${CLONE}/packages/sessions/src`, read)).toEqual({ root: CLONE, branch: 'main' });
  });

  it('is null for a directory under no checkout at all', () => {
    expect(findCheckout('d:/nowhere/at/all', read)).toBeNull();
  });

  it('reports a detached HEAD as a checkout with no branch', () => {
    const detached: ReadText = (path) => (path.endsWith('/HEAD') ? '9f2a1c0e4b7d\n' : read(path));

    expect(findCheckout(CLONE, detached)).toEqual({ root: CLONE, branch: null });
  });

  it('tolerates a gitdir pointer written with CRLF or trailing spaces', () => {
    const crlf: ReadText = (path) =>
      path === 'd:/work/other/.git' ? 'gitdir: d:/work/shared/.git/worktrees/16080-api-port  \r\n'
      : path === 'd:/work/shared/.git/worktrees/16080-api-port/HEAD' ? 'ref: refs/heads/16080-api-port\r\n'
      : null;

    expect(findCheckout('d:/work/other', crlf)?.branch).toBe('16080-api-port');
  });

  it('ignores a .git file that is not a gitdir pointer', () => {
    const junk: ReadText = (path) => (path === 'd:/work/other/.git' ? 'not a pointer\n' : null);

    expect(findCheckout('d:/work/other', junk)).toBeNull();
  });

  it('resolves a relative gitdir pointer against the checkout', () => {
    const relative: ReadText = (path) =>
      path === 'd:/work/other/.git' ? 'gitdir: ../shared/.git/worktrees/16080-api-port\n'
      : path === 'd:/work/shared/.git/worktrees/16080-api-port/HEAD' ? 'ref: refs/heads/16080-api-port\n'
      : null;

    expect(findCheckout('d:/work/other', relative)?.branch).toBe('16080-api-port');
  });
});

describe('issueNumberFrom', () => {
  it('reads the leading number', () => {
    expect(issueNumberFrom(BRANCH, pattern!)).toBe(18941);
  });

  it('is null when the name does not start with a number', () => {
    expect(issueNumberFrom('team/worker-1', pattern!)).toBeNull();
    expect(issueNumberFrom('main', pattern!)).toBeNull();
    expect(issueNumberFrom(null, pattern!)).toBeNull();
  });

  it('is null, not NaN, when a valid pattern captures something that is not digits', () => {
    const { pattern: words } = compilePattern('^issue-(\\w+)-');

    expect(issueNumberFrom('issue-abc-thing', words!)).toBeNull();
  });
});

describe('compilePattern', () => {
  it('accepts a pattern with a capturing group', () => {
    expect(compilePattern('^(\\d+)-')).toMatchObject({ error: null });
    expect(compilePattern('(?<n>\\d+)')).toMatchObject({ error: null });
  });

  it('refuses a pattern that is not a regular expression, and says so', () => {
    expect(compilePattern('^(\\d+')).toMatchObject({ pattern: null });
    expect(compilePattern('^(\\d+').error).toContain('not a valid regular expression');
  });

  it('refuses a pattern with no capturing group, which would link nothing in silence', () => {
    expect(compilePattern('^\\d+-').error).toContain('no capturing group');
    expect(compilePattern('^(?:\\d+)-').error).toContain('no capturing group');
  });

  it('does not mistake an escaped parenthesis for a group', () => {
    expect(compilePattern('^\\(\\d+\\)').error).toContain('no capturing group');
  });
});

describe('linkOf', () => {
  it('links from the branch', () => {
    expect(linkOf(WORKTREE, read, pattern)).toEqual({ branch: BRANCH, issueNumber: 18941 });
  });

  it('falls back to the directory name when there is no checkout to read', () => {
    expect(linkOf('d:/work/repo.worktrees/17510-not-a-recorded-checkout', read, pattern)).toEqual({
      branch: null,
      issueNumber: 17510,
    });
  });

  it('names the checkout, not the subdirectory, when falling back', () => {
    const root = 'd:/work/repo.worktrees/17198-guest-portal-drops-rows-past-the-first-page';
    const detached: ReadText = (path) =>
      path === 'D:/work/repo/.git/worktrees/17198-guest-portal-drops-rows-past-the-first-page/HEAD'
        ? '9f2a1c0e4b7d\n'
        : read(path);

    expect(linkOf(`${root}/99999-not-the-issue`, detached, pattern)).toEqual({ branch: null, issueNumber: 17198 });
  });

  it('leaves a checkout on a branch with no issue number unlinked', () => {
    expect(linkOf(CLONE, read, pattern)).toEqual({ branch: 'main', issueNumber: null });
  });

  it('reports the branch but links nothing when the pattern is unusable', () => {
    expect(linkOf(WORKTREE, read, null)).toEqual({ branch: BRANCH, issueNumber: null });
  });
});
