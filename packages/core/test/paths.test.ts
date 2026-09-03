import { describe, expect, it } from 'vitest';
import { basename, groundControlDirOf, isAbsolute, join, normalize, parent } from '../src/paths.js';

describe('normalize', () => {
  it('turns a Windows path into the forward-slash form the fixtures are keyed by', () => {
    expect(normalize('d:\\work\\repo.worktrees\\18941-inbox-badge')).toBe(
      'd:/work/repo.worktrees/18941-inbox-badge',
    );
  });
});

describe('join', () => {
  it('appends a segment', () => {
    expect(join('d:\\work\\repo', '.git')).toBe('d:/work/repo/.git');
  });

  it('does not double a trailing separator', () => {
    expect(join('d:/work/repo/', '.git')).toBe('d:/work/repo/.git');
  });

  it('collapses a relative gitdir pointer', () => {
    expect(join('d:/work/clone', '../shared/.git/worktrees/16080')).toBe('d:/work/shared/.git/worktrees/16080');
  });

  it('drops a bare current-directory segment', () => {
    expect(join('d:/work/clone', './.git')).toBe('d:/work/clone/.git');
  });
});

describe('isAbsolute', () => {
  it('recognises a drive-rooted and a slash-rooted path', () => {
    expect(isAbsolute('D:/work/repo/.git/worktrees/18941')).toBe(true);
    expect(isAbsolute('D:\\work\\repo')).toBe(true);
    expect(isAbsolute('/home/dev/repo')).toBe(true);
  });

  it('does not recognise a relative one', () => {
    expect(isAbsolute('../shared/.git')).toBe(false);
  });
});

describe('basename', () => {
  it('takes the last segment', () => {
    expect(basename('d:\\work\\repo.worktrees\\18941-inbox-badge')).toBe('18941-inbox-badge');
  });

  it('ignores a trailing separator', () => {
    expect(basename('d:/work/repo/')).toBe('repo');
  });
});

describe('parent', () => {
  it('steps one level up', () => {
    expect(parent('d:/work/repo/.git')).toBe('d:/work/repo');
    expect(parent('d:\\work\\repo')).toBe('d:/work');
  });

  it('stops at a drive root', () => {
    expect(parent('d:/work')).toBeNull();
  });

  it('stops at a POSIX root', () => {
    expect(parent('/home')).toBeNull();
    expect(parent('/home/dev')).toBe('/home');
  });

  it('stops at a UNC share root, rather than walking off the share onto the local drive', () => {
    expect(parent('//server/share')).toBeNull();
    expect(parent('//server/share/proj')).toBeNull();
    expect(parent('//server/share/proj/sub')).toBe('//server/share/proj');
  });

  it('ignores a trailing separator', () => {
    expect(parent('d:/work/repo/')).toBe('d:/work');
  });
});

describe('groundControlDirOf', () => {
  it('names the board directory under the home it is handed, whichever separator that home uses', () => {
    expect(groundControlDirOf('C:\\Users\\dev')).toBe('C:/Users/dev/.claude/ground-control');
    expect(groundControlDirOf('/home/dev/')).toBe('/home/dev/.claude/ground-control');
  });
});
