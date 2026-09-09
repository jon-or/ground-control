import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SESSION_SCOPE, restrictedSessionScope, scopeDirectory, scopeRepository, sessionInScope, sessionScopeSchema } from '../src/sessionScope.js';
import { findCheckout } from '../src/link.js';

describe('session scope settings', () => {
  it.each([
    ['Example/Repo', 'github.com/example/repo'],
    ['GitHub.com/Example/Repo.git', 'github.com/example/repo'],
    ['https://github.com/Example/Repo.git', 'github.com/example/repo'],
    ['git@github.com:Example/Repo.git', 'github.com/example/repo'],
    ['ssh://git@github.com/Example/Repo.git', 'github.com/example/repo'],
  ])('normalizes repository %s', (raw, expected) => {
    expect(scopeRepository(raw)).toBe(expected);
  });

  it.each(['https://user:secret@github.com/org/repo', 'https://secret@github.com/org/repo',
    'https://github.com/org/repo/issues/4', 'https://github.com/org/repo?token=secret',
    'https://github.com/org/repo#section', 'file:///org/repo', 'org', 'org/repo/extra/four', 'org/.git'])('rejects malformed repository %s', (raw) => {
    expect(scopeRepository(raw)).toBeNull();
  });

  it.each([
    ['C:\\Work\\Repo\\..', 'c:/work'], ['C:/', 'c:/'],
    ['\\\\Server\\Share\\Work\\..', '//server/share'], ['/Work/Repo/../', '/Work'], ['/', '/'],
  ])('normalizes absolute directory %s and preserves its round trip', (raw, expected) => {
    expect(scopeDirectory(raw)).toBe(expected);
    expect(scopeDirectory(expected)).toBe(expected);
  });

  it.each(['relative/work', 'C:work', '\\work', '//server', '\\\\?\\C:\\work', ''])('rejects nonabsolute or unsupported directory %s', (raw) => {
    expect(scopeDirectory(raw)).toBeNull();
  });

  it('defaults omitted fields and rejects a malformed scope rather than widening it', () => {
    expect(sessionScopeSchema.parse({})).toEqual(DEFAULT_SESSION_SCOPE);
    for (const value of [null, { showHistory: 'false' }, { includeDirectories: ['relative'] },
      { excludeRepositories: [null] }, { excludeRepos: ['org/repo'] }]) {
      expect(sessionScopeSchema.safeParse(value).success).toBe(false);
    }
  });

  it('persists canonical rules and distinguishes privacy restrictions from display preferences', () => {
    const parsed = sessionScopeSchema.parse({
      includeRepositories: ['git@github.com:Org/Repo.git'], excludeDirectories: ['D:\\Personal\\notes\\..'], showHistory: false,
    });
    expect(parsed).toEqual({
      includeRepositories: ['github.com/org/repo'], excludeRepositories: [], includeDirectories: [],
      excludeDirectories: ['d:/personal'], showHistory: false, showAdHoc: true,
    });
    expect(restrictedSessionScope(parsed)).toBe(true);
    expect(restrictedSessionScope({ ...DEFAULT_SESSION_SCOPE, showHistory: false, showAdHoc: false })).toBe(false);
    expect(sessionScopeSchema.parse(parsed)).toEqual(parsed);
  });
});

describe('session scope matching', () => {
  const session = { cwd: '/work/project/src', checkoutRoot: '/work/project', repository: 'github.com/org/repo' };

  it('unions includes and lets any exclusion win', () => {
    const included = { ...DEFAULT_SESSION_SCOPE, includeRepositories: ['elsewhere/repo'], includeDirectories: ['/work/project'] };
    expect(sessionInScope(included, session)).toBe(true);
    expect(sessionInScope({ ...included, excludeRepositories: ['org/repo'] }, session)).toBe(false);
    expect(sessionInScope({ ...included, excludeDirectories: ['/work/project/src'] }, session)).toBe(false);
    expect(sessionInScope({ ...included, includeDirectories: ['/other'] }, session)).toBe(false);
  });

  it('treats unknown repositories conservatively without disabling discovery by default', () => {
    const unknown = { ...session, repository: null };
    expect(sessionInScope(DEFAULT_SESSION_SCOPE, unknown)).toBe(true);
    expect(sessionInScope({ ...DEFAULT_SESSION_SCOPE, includeRepositories: ['org/repo'] }, unknown)).toBe(false);
    expect(sessionInScope({ ...DEFAULT_SESSION_SCOPE, includeDirectories: ['/work'] }, unknown)).toBe(true);
    expect(sessionInScope({ ...DEFAULT_SESSION_SCOPE, includeDirectories: ['/work'], excludeRepositories: ['personal/private'] }, unknown)).toBe(false);
  });

  it('uses path segment boundaries, Windows case folding, and POSIX case distinctions', () => {
    expect(sessionInScope({ ...DEFAULT_SESSION_SCOPE, includeDirectories: ['/work/pro'] }, session)).toBe(false);
    expect(sessionInScope({ ...DEFAULT_SESSION_SCOPE, includeDirectories: ['/WORK'] }, session)).toBe(false);
    expect(sessionInScope({ ...DEFAULT_SESSION_SCOPE, includeDirectories: ['/work/project'] }, { ...session, cwd: '/work/project ', checkoutRoot: null })).toBe(false);
    expect(sessionInScope({ ...DEFAULT_SESSION_SCOPE, includeDirectories: ['D:\\Work'] }, { ...session, cwd: 'd:/work/project', checkoutRoot: null })).toBe(true);
    expect(sessionInScope({ ...DEFAULT_SESSION_SCOPE, includeDirectories: ['D:/'] }, { ...session, cwd: 'd:/project', checkoutRoot: null })).toBe(true);
    expect(sessionInScope({ ...DEFAULT_SESSION_SCOPE, includeDirectories: ['//SERVER/SHARE'] }, { ...session, cwd: '\\\\server\\share\\project', checkoutRoot: null })).toBe(true);
    expect(sessionInScope({ ...DEFAULT_SESSION_SCOPE, includeDirectories: ['/'] }, session)).toBe(true);
  });

  it('matches a saved session through its recorded worktree checkout', () => {
    const files = JSON.parse(readFileSync(join(__dirname, 'fixtures/git-reads.json'), 'utf8')) as Record<string, string | null>;
    const read = (path: string) => files[path] ?? null;
    const cwd = 'd:/work/repo.worktrees/18941-inbox-badge-overwrites-a-manual-edit/src';
    const derived = { cwd, checkoutRoot: findCheckout(cwd, read)?.root ?? null, repository: 'github.com/org/repo' };
    expect(derived.checkoutRoot).toBe('d:/work/repo.worktrees/18941-inbox-badge-overwrites-a-manual-edit');
    expect(sessionInScope({ ...DEFAULT_SESSION_SCOPE, includeRepositories: ['org/repo'] }, derived)).toBe(true);
    expect(sessionInScope({ ...DEFAULT_SESSION_SCOPE, excludeDirectories: ['D:/WORK/REPO.WORKTREES'] }, derived)).toBe(false);
  });
});
