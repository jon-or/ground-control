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

  it('compares drive letters case-insensitively', () => {
    expect(repositoryRefusal('d:/work/repo', 'D:\\work\\repo')).toBeNull();
  });

  // VS Code can fall back to the only open repository. Reject a main clone returned for a worktree request.
  it('refuses a different repository, naming both and what to do', () => {
    expect(repositoryRefusal(ROOT, 'd:/work/repo')).toBe(
      `VS Code selected d:/work/repo instead of ${ROOT}. Open ${ROOT} in a separate window and try again.`,
    );
  });

  it('provides recovery steps for unavailable repositories', () => {
    expect(noRepository(ROOT)).toBe(
      `VS Code has no repository at ${ROOT}. Open that folder in a window, or check that Git is enabled for it.`,
    );
  });
});

describe('combining committed, staged, and working-tree changes', () => {
  it('refuses a checkout that matches what it forked from and has nothing uncommitted', () => {
    expect(changesPlan(request())).toEqual({
      refusal: 'no-changes',
      message: '#18941 Inbox badge: no changes since the merge base and no uncommitted changes.',
    });
  });

  it('reports missing merge base with no uncommitted changes', () => {
    expect(changesPlan(request({ base: null }))).toEqual({
      refusal: 'no-changes',
      message: '#18941 Inbox badge: no uncommitted changes. Merge base unavailable.',
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

  // A committed file with later edits must produce one combined row.
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

  it('matches path casing variants while preserving display paths', () => {
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

  it('labels HEAD fallback as uncommitted changes only', () => {
    const plan = changesPlan(request({ base: null, working: [{ path: 'd:/work/a.ts', kind: 'modified' }] }));

    expect(plan).toMatchObject({ title: '#18941 Inbox badge — uncommitted only, no merge base' });
  });

  it('names the base it diffed from, so the title is not a claim about the branch', () => {
    const plan = changesPlan(request({ committed: [{ path: 'd:/work/a.ts', kind: 'modified' }] }));

    expect(plan).toMatchObject({ title: '#18941 Inbox badge — since 3f2a91c' });
  });

  it('sorts rows by path', () => {
    const plan = changesPlan(
      request({
        committed: [{ path: 'd:/work/z.ts', kind: 'modified' }, { path: 'd:/work/a.ts', kind: 'modified' }],
        working: [{ path: 'd:/work/m.ts', kind: 'modified' }],
      }),
    );

    expect(rows(plan).map((row) => row.split('@')[0])).toEqual(['d:/work/a.ts', 'd:/work/m.ts', 'd:/work/z.ts']);
  });
});

/** Staged and working-tree statuses can differ. Keeping only one per path can lose deletions. */
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

  // Later renames must update the existing row, not create separate original and destination rows.
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
  // Assert the fixed cap independently of MAX_ROWS so accidental constant changes fail.
  it('is capped at four hundred rows', () => {
    expect(MAX_ROWS).toBe(400);
  });

  it('reports truncation in the title', () => {
    const many = Array.from({ length: 410 }, (_, i) => ({
      path: `d:/work/${String(i).padStart(4, '0')}.ts`,
      kind: 'modified' as const,
    }));

    const plan = changesPlan(request({ committed: many }));

    expect(plan).toMatchObject({ shown: 400, total: 410, title: '#18941 Inbox badge — since 3f2a91c, first 400 of 410' });
    expect(rows(plan)).toHaveLength(400);
  });
});
