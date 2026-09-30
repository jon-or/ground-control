/**
 * Which branches a merge request names (R39). On a pull request based on another branch, the board first merges the
 * default branch into that base; the row's prompt performs the rest.
 */
export const MERGE_TYPES = ['upstream', 'stacked', 'test'] as const;

export type MergeType = (typeof MERGE_TYPES)[number];

export const DEFAULT_TEST_BRANCH_PATTERN = '^Test-';

export type MergeReading = { ok: true; type: MergeType; target: string | null } | { ok: false; reason: string };

/**
 * Derive the merge type from branch facts. `named` is the branch the request names as its destination: a test
 * branch makes the merge a test merge; the head, the base, or the default branch leave it to the PR's base.
 */
export function mergeTypeOf(
  pr: { baseRefName: string; headRefName: string },
  defaultBranch: string | null,
  named: string | null,
  testPattern: string,
): MergeReading {
  if (defaultBranch === null) {
    return { ok: false, reason: 'Repository default branch unavailable.' };
  }

  let test: RegExp;

  try {
    test = new RegExp(testPattern);
  } catch {
    return { ok: false, reason: `groundControl.actions.testBranchPattern is not a valid regular expression: ${testPattern}` };
  }

  const stacked = pr.baseRefName !== '' && pr.baseRefName !== defaultBranch;

  if (named !== null && named !== '') {
    if (test.test(named)) {
      return { ok: true, type: 'test', target: named };
    }

    if (![pr.headRefName, pr.baseRefName, defaultBranch].includes(named)) {
      return { ok: false, reason: `The request names ${named}, which is neither this pull request's branch, its base, nor a test branch.` };
    }
  }

  return { ok: true, type: stacked ? 'stacked' : 'upstream', target: null };
}
