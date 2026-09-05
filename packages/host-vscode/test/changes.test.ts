import { describe, expect, it } from 'vitest';
import { MAX_ROWS, changesPlan, noRepository, repositoryRefusal } from '../src/changes.js';
import type { ChangesPlan, ChangesRequest } from '../src/changes.js';

const ROOT = 'd:/work/repo.worktrees/18941-inbox-badge';
const BASE = '3f2a91c7d4e5b6a8091c2d3e4f5a6b7c8d9e0f1a';

function request(over: Partial<ChangesRequest> = {}): ChangesRequest {
  return { label: '#18941 Inbox badge', base: BASE, committed: [], staged: [], working: [], ...over };
}

/** The rows an editor would be handed, flattened so a table reads as `path@ref -> path@ref`. */
function rows(plan: ChangesPlan): string[] {
  if ('refusal' in plan) {
    throw new Error(`expected a plan, got a refusal: ${plan.message}`);
  }

  const side = (s: { path: string; ref: string | null } | null) => (s === null ? 'none' : `${s.path}@${s.ref ?? 'disk'}`);

  return plan.rows.map((row) => `${side(row.original)} -> ${side(row.modified)}`);
}

describe('the repository a command will actually run against', () => {
  it('accepts the repository that was asked for', () => {
    expect(repositoryRefusal(ROOT, ROOT)).toBeNull();
  });

  it('accepts a drive letter cased the other way, which two readers of one path disagree on', () => {
    expect(repositoryRefusal('d:/work/repo', 'D:\\work\\repo')).toBeNull();
  });

  // The failure this exists for: VS Code hands back the window's only repository without prompting, so a worktree
  // that failed to open would have the main clone diffed under its name.
  it('refuses a different repository, naming both and what to do', () => {
    expect(repositoryRefusal(ROOT, 'd:/work/repo')).toBe(
      `VS Code answered with the repository at d:/work/repo rather than ${ROOT}. Open the worktree in a window of its own and try again.`,
    );
  });

  it('says what to try when the editor would not open the checkout at all', () => {
    expect(noRepository(ROOT)).toBe(
      `VS Code has no repository at ${ROOT}. Open that folder in a window, or check that Git is enabled for it.`,
    );
  });
});

describe('folding the commits, the index and the working tree into one editor', () => {
  it('refuses a checkout that matches what it forked from and has nothing uncommitted', () => {
    expect(changesPlan(request())).toEqual({
      refusal: 'no-changes',
      message: '#18941 Inbox badge has no changes: its branch matches what it forked from, and nothing is uncommitted.',
    });
  });

  it('says which of the two ran out when there is no merge base', () => {
    expect(changesPlan(request({ base: null }))).toEqual({
      refusal: 'no-changes',
      message: '#18941 Inbox badge has nothing uncommitted, and the board could not work out what its branch forked from.',
    });
  });

  it('puts the base on the left and the working tree on the right', () => {
    expect(rows(changesPlan(request({ committed: [{ path: 'd:/work/a.ts', kind: 'modified' }] })))).toEqual([
      `d:/work/a.ts@${BASE} -> d:/work/a.ts@disk`,
    ]);
  });

  it('gives an added file no left-hand side and a deleted file no right-hand one', () => {
    const plan = changesPlan(
      request({ committed: [{ path: 'd:/work/new.ts', kind: 'added' }, { path: 'd:/work/gone.ts', kind: 'deleted' }] }),
    );

    expect(rows(plan)).toEqual([`d:/work/gone.ts@${BASE} -> none`, 'none -> d:/work/new.ts@disk']);
  });

  it('gives a file that is new and only uncommitted no left-hand side', () => {
    expect(rows(changesPlan(request({ working: [{ path: 'd:/work/scratch.ts', kind: 'added' }] })))).toEqual([
      'none -> d:/work/scratch.ts@disk',
    ]);
  });

  it('reads a rename from the name the file had at the base', () => {
    const plan = changesPlan(request({ committed: [{ path: 'd:/work/new.ts', kind: 'modified', from: 'd:/work/old.ts' }] }));

    expect(rows(plan)).toEqual([`d:/work/old.ts@${BASE} -> d:/work/new.ts@disk`]);
  });

  // The whole point of the fold: a file both committed and then edited again is one row spanning both, not two
  // rows of half the story.
  it('collapses a file that was committed and then edited again into one row', () => {
    const plan = changesPlan(
      request({
        committed: [{ path: 'd:/work/a.ts', kind: 'modified' }],
        working: [{ path: 'd:/work/a.ts', kind: 'modified' }],
      }),
    );

    expect(rows(plan)).toEqual([`d:/work/a.ts@${BASE} -> d:/work/a.ts@disk`]);
  });

  it('keeps a file added in a commit an addition even though it is edited again on disk', () => {
    const plan = changesPlan(
      request({
        committed: [{ path: 'd:/work/new.ts', kind: 'added' }],
        working: [{ path: 'd:/work/new.ts', kind: 'modified' }],
      }),
    );

    expect(rows(plan)).toEqual(['none -> d:/work/new.ts@disk']);
  });

  it('drops a file added in a commit and since deleted, which existed at neither end', () => {
    const plan = changesPlan(
      request({
        committed: [{ path: 'd:/work/scratch.ts', kind: 'added' }],
        working: [{ path: 'd:/work/scratch.ts', kind: 'deleted' }],
      }),
    );

    expect(plan).toEqual({ refusal: 'no-changes', message: expect.any(String) });
  });

  it('shows a file deleted in a commit and put back on disk as a change rather than a deletion', () => {
    const plan = changesPlan(
      request({
        committed: [{ path: 'd:/work/a.ts', kind: 'deleted' }],
        working: [{ path: 'd:/work/a.ts', kind: 'added' }],
      }),
    );

    expect(rows(plan)).toEqual([`d:/work/a.ts@${BASE} -> d:/work/a.ts@disk`]);
  });

  it('matches a path two readers cased differently, keeping each side its own name', () => {
    const plan = changesPlan(
      request({
        committed: [{ path: 'D:/Work/a.ts', kind: 'modified' }],
        working: [{ path: 'd:/work/a.ts', kind: 'modified' }],
      }),
    );

    expect(rows(plan)).toEqual([`D:/Work/a.ts@${BASE} -> d:/work/a.ts@disk`]);
  });

  it('shows uncommitted work against HEAD when there is no merge base', () => {
    const plan = changesPlan(request({ base: null, working: [{ path: 'd:/work/a.ts', kind: 'modified' }] }));

    expect(rows(plan)).toEqual(['d:/work/a.ts@HEAD -> d:/work/a.ts@disk']);
  });

  it('says in the title that a missing base means uncommitted work alone', () => {
    const plan = changesPlan(request({ base: null, working: [{ path: 'd:/work/a.ts', kind: 'modified' }] }));

    expect(plan).toMatchObject({ title: '#18941 Inbox badge — uncommitted only, no merge base' });
  });

  it('names the base it diffed from, so the title is not a claim about the branch', () => {
    const plan = changesPlan(request({ committed: [{ path: 'd:/work/a.ts', kind: 'modified' }] }));

    expect(plan).toMatchObject({ title: '#18941 Inbox badge — since 3f2a91c' });
  });

  it('orders rows by path, so one editor reads the same on two machines', () => {
    const plan = changesPlan(
      request({
        committed: [{ path: 'd:/work/z.ts', kind: 'modified' }, { path: 'd:/work/a.ts', kind: 'modified' }],
        working: [{ path: 'd:/work/m.ts', kind: 'modified' }],
      }),
    );

    expect(rows(plan).map((row) => row.split('@')[0])).toEqual(['d:/work/a.ts', 'd:/work/m.ts', 'd:/work/z.ts']);
  });
});

/**
 * The index holds one thing against HEAD and the working tree another against the index, and the two disagree
 * often. One status per path keeps whichever was read last, which is how a delete goes missing.
 */
describe('the index and the working tree, which say different things', () => {
  it('follows a staged edit that was then deleted on disk through to a deletion', () => {
    const plan = changesPlan(
      request({
        staged: [{ path: 'd:/work/a.ts', kind: 'modified' }],
        working: [{ path: 'd:/work/a.ts', kind: 'deleted' }],
      }),
    );

    expect(rows(plan)).toEqual([`d:/work/a.ts@${BASE} -> none`]);
  });

  it('drops a file staged as new and then deleted on disk', () => {
    const plan = changesPlan(
      request({
        staged: [{ path: 'd:/work/a.ts', kind: 'added' }],
        working: [{ path: 'd:/work/a.ts', kind: 'deleted' }],
      }),
    );

    expect(plan).toEqual({ refusal: 'no-changes', message: expect.any(String) });
  });

  it('keeps a file staged as new and then edited again an addition', () => {
    const plan = changesPlan(
      request({
        staged: [{ path: 'd:/work/a.ts', kind: 'added' }],
        working: [{ path: 'd:/work/a.ts', kind: 'modified' }],
      }),
    );

    expect(rows(plan)).toEqual(['none -> d:/work/a.ts@disk']);
  });

  it('shows a file staged as deleted and then written again as a change, not a deletion', () => {
    const plan = changesPlan(
      request({
        staged: [{ path: 'd:/work/a.ts', kind: 'deleted' }],
        working: [{ path: 'd:/work/a.ts', kind: 'added' }],
      }),
    );

    expect(rows(plan)).toEqual([`d:/work/a.ts@${BASE} -> d:/work/a.ts@disk`]);
  });

  // A rename in a later stage has to meet the file it renamed, or the branch reads as having touched two files:
  // one at a path that is no longer on disk, and one that never existed at the base.
  it('follows a committed file that was then renamed in the index', () => {
    const plan = changesPlan(
      request({
        committed: [{ path: 'd:/work/a.ts', kind: 'modified' }],
        staged: [{ path: 'd:/work/b.ts', kind: 'modified', from: 'd:/work/a.ts' }],
      }),
    );

    expect(rows(plan)).toEqual([`d:/work/a.ts@${BASE} -> d:/work/b.ts@disk`]);
  });

  it('keeps a file added in a commit and then renamed an addition at its new name', () => {
    const plan = changesPlan(
      request({
        committed: [{ path: 'd:/work/a.ts', kind: 'added' }],
        staged: [{ path: 'd:/work/b.ts', kind: 'modified', from: 'd:/work/a.ts' }],
      }),
    );

    expect(rows(plan)).toEqual(['none -> d:/work/b.ts@disk']);
  });

  it('follows a rename through both uncommitted stages', () => {
    const plan = changesPlan(
      request({
        committed: [{ path: 'd:/work/a.ts', kind: 'modified' }],
        staged: [{ path: 'd:/work/b.ts', kind: 'modified', from: 'd:/work/a.ts' }],
        working: [{ path: 'd:/work/b.ts', kind: 'modified' }],
      }),
    );

    expect(rows(plan)).toEqual([`d:/work/a.ts@${BASE} -> d:/work/b.ts@disk`]);
  });
});

describe('a branch off a stale base', () => {
  // The cap itself, not a relationship to a number derived from it: an expectation built out of `MAX_ROWS` holds
  // for every value of `MAX_ROWS`, including one.
  it('is capped at four hundred rows', () => {
    expect(MAX_ROWS).toBe(400);
  });

  it('is truncated, and the title says how much it left out', () => {
    const many = Array.from({ length: 410 }, (_, i) => ({
      path: `d:/work/${String(i).padStart(4, '0')}.ts`,
      kind: 'modified' as const,
    }));

    const plan = changesPlan(request({ committed: many }));

    expect(plan).toMatchObject({ shown: 400, total: 410, title: '#18941 Inbox badge — since 3f2a91c, first 400 of 410' });
    expect(rows(plan)).toHaveLength(400);
  });
});
