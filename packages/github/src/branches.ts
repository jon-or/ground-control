import { z } from 'zod';
import type { BranchPullRequestReading, BranchTipReading, ContainsReading, ReadFailure } from '@ground-control/core';
import type { GhRunner } from './gh.js';
import { BRANCH_PULL_REQUESTS_QUERY } from './queries.js';
import type { Failure } from './types.js';

/** Duplicated to avoid a circular import with source.ts. */
const GITHUB_SOURCE_ID = 'github';

/** Merge checks run beside dispatch and settling; a slow answer is retried later rather than waited for. */
const BRANCH_TIMEOUT_MS = 20_000;

/** `gh api` reports a missing branch, commit, or repository as HTTP 404 on stderr. */
const NOT_FOUND = /HTTP 404/;

const pullRequestsResponse = z.object({
  data: z.object({
    repository: z
      .object({
        pullRequests: z.object({
          nodes: z.array(
            z.object({
              number: z.number(),
              isDraft: z.boolean(),
              isCrossRepository: z.boolean(),
              baseRefName: z.string(),
              headRefName: z.string(),
              headRefOid: z.string(),
              author: z.object({ login: z.string() }).nullable(),
              closingIssuesReferences: z.object({ nodes: z.array(z.object({ number: z.number() })) }),
            }),
          ),
        }),
      })
      .nullable(),
  }),
});

const tipResponse = z.object({ sha: z.string().min(1) });

/** The compare API's relation of the second commit to the first; `ahead` and `identical` mean it contains the first. */
const compareResponse = z.object({ status: z.enum(['ahead', 'behind', 'diverged', 'identical']), behind_by: z.number() });

function ownerAndName(repository: string): [string, string] | null {
  const [owner, name, ...rest] = repository.split('/');

  return owner && name && rest.length === 0 ? [owner, name] : null;
}

function failureOf(error: Failure): ReadFailure {
  return { ...error, subject: GITHUB_SOURCE_ID };
}

function unexpected(what: string): ReadFailure {
  return {
    subject: GITHUB_SOURCE_ID,
    kind: 'bad-response',
    message: `GitHub returned an unexpected response for ${what}.`,
    remedy: 'Try again. If the error persists, report it.',
  };
}

function badRepository(repository: string): ReadFailure {
  return { subject: GITHUB_SOURCE_ID, kind: 'bad-response', message: `"${repository}" is not an owner/name repository.`, remedy: 'Refresh the board.' };
}

/** Open pull requests whose head is `branch` (R39). */
export async function fetchBranchPullRequests(
  repository: string,
  branch: string,
  run: GhRunner,
  signal: AbortSignal,
): Promise<BranchPullRequestReading> {
  const at = ownerAndName(repository);

  if (at === null) {
    return { pullRequests: null, failure: badRepository(repository) };
  }

  const result = await run(
    ['api', 'graphql', '-f', `query=${BRANCH_PULL_REQUESTS_QUERY}`, '-f', `owner=${at[0]}`, '-f', `name=${at[1]}`, '-f', `branch=${branch}`],
    { timeoutMs: BRANCH_TIMEOUT_MS, signal },
  );

  if (!result.ok) {
    return { pullRequests: null, failure: failureOf(result.error) };
  }

  const parsed = pullRequestsResponse.safeParse(result.value);

  if (!parsed.success || parsed.data.data.repository === null) {
    return { pullRequests: null, failure: unexpected(`the pull requests of ${branch}`) };
  }

  return {
    pullRequests: parsed.data.data.repository.pullRequests.nodes.map((node) => {
      const closing = node.closingIssuesReferences.nodes;

      return {
        number: node.number,
        author: node.author?.login ?? null,
        isDraft: node.isDraft,
        baseRefName: node.baseRefName,
        headRefName: node.headRefName,
        headOid: node.headRefOid,
        // Several closed issues leave the choice to the branch name.
        issueNumber: closing.length === 1 ? closing[0]!.number : null,
        crossRepository: node.isCrossRepository,
      };
    }),
    failure: null,
  };
}

/** The commit `branch` points at. */
export async function fetchBranchTip(repository: string, branch: string, run: GhRunner, signal: AbortSignal): Promise<BranchTipReading> {
  const at = ownerAndName(repository);

  if (at === null) {
    return { sha: null, failure: badRepository(repository) };
  }

  const result = await run(
    ['api', `repos/${at[0]}/${at[1]}/branches/${encodeURIComponent(branch)}`, '--jq', '{sha: .commit.sha}'],
    { timeoutMs: BRANCH_TIMEOUT_MS, signal },
  );

  if (!result.ok) {
    return { sha: null, failure: failureOf(result.error) };
  }

  const parsed = tipResponse.safeParse(result.value);

  return parsed.success ? { sha: parsed.data.sha, failure: null } : { sha: null, failure: unexpected(`the tip of ${branch}`) };
}

/**
 * Whether `branch` contains commit `sha`, from the compare API with only its relation kept: the full response embeds
 * up to 250 commits. A missing branch or commit is reported as `missing`, which retrying will not change.
 */
export async function fetchContains(
  repository: string,
  sha: string,
  branch: string,
  run: GhRunner,
  signal: AbortSignal,
): Promise<ContainsReading> {
  const at = ownerAndName(repository);

  if (at === null) {
    return { contained: null, failure: badRepository(repository), missing: false };
  }

  const result = await run(
    ['api', `repos/${at[0]}/${at[1]}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(branch)}`, '--jq', '{status: .status, behind_by: .behind_by}'],
    { timeoutMs: BRANCH_TIMEOUT_MS, signal },
  );

  if (!result.ok) {
    const missing = NOT_FOUND.test(result.error.message);

    return {
      contained: null,
      failure: missing
        ? { subject: GITHUB_SOURCE_ID, kind: 'not-found', message: `GitHub has no branch ${branch}, or no commit ${sha.slice(0, 7)}.`, remedy: 'Check the branch on GitHub.' }
        : failureOf(result.error),
      missing,
    };
  }

  const parsed = compareResponse.safeParse(result.value);

  if (!parsed.success) {
    return { contained: null, failure: unexpected(`${branch} compared with ${sha.slice(0, 7)}`), missing: false };
  }

  return { contained: parsed.data.status === 'ahead' || parsed.data.status === 'identical', failure: null };
}
