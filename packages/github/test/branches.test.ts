import { describe, expect, it } from 'vitest';
import { fetchBranchPullRequests, fetchBranchTip, fetchContains } from '../src/branches.js';
import type { GhRunner, Result } from '../src/index.js';
import { fixture, runnerOf } from './helpers.js';

const SIGNAL = new AbortController().signal;
const MASTER = 'bed53b87b5ac652eaa0bc616cce67fd694eb85bd';

/** A runner whose one request fails as `gh api` reported it. */
function failing(message: string, kind: 'query-failed' | 'offline' = 'query-failed'): GhRunner {
  return async (): Promise<Result<unknown>> => ({ ok: false, error: { kind, message, remedy: 'r' } });
}

/** The base of a stacked pull request, read by its head branch (R39). */
describe('the open pull requests of a branch', () => {
  it('reads the one open pull request, its tip, author, and the one issue it closes', async () => {
    const run = runnerOf(fixture('branch-pull-requests'));

    expect(await fetchBranchPullRequests('example-org/example-repo', '16080-parent-feature', run, SIGNAL)).toEqual({
      pullRequests: [
        {
          number: 17589,
          author: 'dev-1',
          isDraft: false,
          baseRefName: 'master',
          headRefName: '16080-parent-feature',
          headOid: '4235c514e84cd772144c23acfb8f3cb4a1ef3f90',
          issueNumber: 16080,
          crossRepository: false,
        },
      ],
      failure: null,
    });
    expect(run.calls[0]).toEqual(expect.arrayContaining(['-f', 'owner=example-org', '-f', 'name=example-repo', '-f', 'branch=16080-parent-feature']));
  });

  it('reads none for a branch no open pull request has as its head', async () => {
    expect(await fetchBranchPullRequests('example-org/example-repo', 'no-such-branch', runnerOf(fixture('branch-pull-requests-none')), SIGNAL)).toEqual({
      pullRequests: [],
      failure: null,
    });
  });

  /** Derived from the recording: a pull request closing two issues names neither, leaving the branch name to. */
  it('names no issue for a pull request closing several', async () => {
    const recorded = fixture('branch-pull-requests') as { data: { repository: { pullRequests: { nodes: { closingIssuesReferences: { nodes: unknown[] } }[] } } } };
    recorded.data.repository.pullRequests.nodes[0]!.closingIssuesReferences.nodes = [{ number: 16080 }, { number: 16081 }];

    const read = await fetchBranchPullRequests('example-org/example-repo', '16080-parent-feature', runnerOf(recorded), SIGNAL);

    expect(read.pullRequests?.[0]?.issueNumber).toBeNull();
  });

  it('reports a failed read, and an unexpected answer, as failures', async () => {
    expect(await fetchBranchPullRequests('example-org/example-repo', 'b', failing('GitHub could not be reached.', 'offline'), SIGNAL)).toMatchObject({
      pullRequests: null,
      failure: { subject: 'github', kind: 'offline' },
    });
    expect(await fetchBranchPullRequests('example-org/example-repo', 'b', runnerOf({ data: { repository: { pullRequests: {} } } }), SIGNAL)).toMatchObject({
      pullRequests: null,
      failure: { kind: 'bad-response' },
    });
  });
});

describe('a branch\'s tip', () => {
  it('reads the commit the branch points at, URL-encoding the branch', async () => {
    const run = runnerOf(fixture('branch-tip'));

    expect(await fetchBranchTip('example-org/example-repo', 'feature/x', run, SIGNAL)).toEqual({ sha: MASTER, failure: null });
    expect(run.calls[0]?.[1]).toBe('repos/example-org/example-repo/branches/feature%2Fx');
  });

  it('reports an answer with no commit as a failure', async () => {
    expect(await fetchBranchTip('example-org/example-repo', 'master', runnerOf({ sha: '' }), SIGNAL)).toMatchObject({ sha: null, failure: { kind: 'bad-response' } });
  });
});

/** Whether a branch contains a commit: how a merge's push is checked (R39). */
describe('a branch containing a commit', () => {
  it('holds for a branch identical to the commit, and asks only for the relation', async () => {
    const run = runnerOf(fixture('compare-identical'));

    expect(await fetchContains('example-org/example-repo', MASTER, 'master', run, SIGNAL)).toEqual({ contained: true, failure: null });
    expect(run.calls[0]).toEqual(['api', `repos/example-org/example-repo/compare/${MASTER}...master`, '--jq', '{status: .status, behind_by: .behind_by}']);
  });

  /** Derived from the identical recording: the API names a branch with commits past the one compared as ahead. */
  it('holds for a branch ahead of the commit', async () => {
    expect(await fetchContains('example-org/example-repo', MASTER, 'b', runnerOf({ behind_by: 0, status: 'ahead' }), SIGNAL)).toEqual({ contained: true, failure: null });
  });

  it('does not hold for a branch that has diverged from the commit', async () => {
    expect(await fetchContains('example-org/example-repo', MASTER, '16080-parent-feature', runnerOf(fixture('compare-diverged')), SIGNAL)).toEqual({
      contained: false,
      failure: null,
    });
  });

  /** `gh` reported the recorded missing branch as `gh: Not Found (HTTP 404)` on stderr. */
  it('reports a branch GitHub does not have as missing, which waiting will not change', async () => {
    expect(await fetchContains('example-org/example-repo', MASTER, 'no-such-branch', failing('gh: Not Found (HTTP 404)'), SIGNAL)).toEqual({
      contained: null,
      failure: expect.objectContaining({ kind: 'not-found', message: 'GitHub has no branch no-such-branch, or no commit bed53b8.' }),
      missing: true,
    });
  });

  it('reports other failures, and an unexpected answer, as failures worth retrying', async () => {
    expect(await fetchContains('example-org/example-repo', MASTER, 'b', failing('GitHub could not be reached.', 'offline'), SIGNAL)).toMatchObject({
      contained: null,
      failure: { kind: 'offline' },
      missing: false,
    });
    expect(await fetchContains('example-org/example-repo', MASTER, 'b', runnerOf({ status: 'unknown', behind_by: 0 }), SIGNAL)).toMatchObject({
      contained: null,
      failure: { kind: 'bad-response' },
      missing: false,
    });
  });

  it('refuses a repository that is not owner/name without asking GitHub', async () => {
    expect(await fetchContains('example-repo', MASTER, 'b', runnerOf(), SIGNAL)).toMatchObject({ contained: null, missing: false });
  });
});
