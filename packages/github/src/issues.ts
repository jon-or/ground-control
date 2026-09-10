import { ASSIGNED_ISSUES_QUERY, ISSUE_BY_NUMBER_QUERY } from './queries.js';
import type { GhRunner } from './gh.js';
import { makeGhRunner } from './gh.js';
import { onConfiguredProject, projectOwnerOf } from './project.js';
import type {
  AssignedIssues,
  CardAvatar,
  CardPullRequest,
  GithubConfig,
  IssueCard,
  ProjectItem,
  Result,
  SearchNode,
} from './types.js';
import { issueResponse, searchResponse } from './types.js';

/** Bound each page request so stalled networking cannot block subsequent refreshes. */
const PAGE_TIMEOUT_MS = 30_000;

/** Repeated assignee qualifiers use OR in issue search and AND in projectV2.items(query:), as verified against a live repository. */
export function buildSearchQuery(cfg: GithubConfig, withProject: boolean): string {
  const parts = [`repo:${cfg.repo}`, 'is:issue', 'is:open', ...cfg.logins.map((l) => `assignee:${l}`)];

  if (withProject) {
    parts.push(`project:${projectOwnerOf(cfg)}/${cfg.projectNumber}`);
  }

  return parts.join(' ');
}

/**
 * The person the policy names for the card's side of the review boundary, falling through to an assignee where
 * that person is unavailable: a review card with no pull request, a deleted account (R5).
 */
function selectCardAvatar(
  node: Pick<SearchNode, 'author' | 'assignees' | 'pullRequests'>,
  cfg: Pick<GithubConfig, 'logins' | 'reviewStatuses' | 'avatar'>,
  status: string | null,
): CardAvatar | null {
  const review = status !== null && cfg.reviewStatuses.includes(status);
  const wanted = review ? cfg.avatar.review : cfg.avatar.offReview;

  if (wanted === 'pull-request-author') {
    const pullRequest = [...(node.pullRequests?.nodes ?? [])]
      .filter((pr) => pr.author)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

    if (pullRequest?.author) {
      return { login: pullRequest.author.login, url: pullRequest.author.avatarUrl, source: 'pull-request' };
    }
  }

  if (wanted === 'issue-author' && node.author) {
    return { login: node.author.login, url: node.author.avatarUrl, source: 'issue-author' };
  }

  const assignees = new Map(node.assignees.nodes.map((actor) => [actor.login.toLowerCase(), actor]));
  const assignee = cfg.logins.map((login) => assignees.get(login.toLowerCase())).find(Boolean) ?? node.assignees.nodes[0];

  return assignee?.avatarUrl ? { login: assignee.login, url: assignee.avatarUrl, source: 'issue' } : null;
}

/** Select the most recently updated open closing PR, or the most recently updated PR when none is open. */
function selectPullRequest(node: Pick<SearchNode, 'pullRequests'>): CardPullRequest | null {
  const byRecency = [...(node.pullRequests?.nodes ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const latest = byRecency.find((pr) => pr.state === 'OPEN') ?? byRecency[0];

  if (!latest) {
    return null;
  }

  const commit = latest.commits?.nodes[0]?.commit;
  const rollup = commit?.statusCheckRollup?.state ?? null;

  return {
    number: latest.number,
    url: latest.url,
    state: latest.state,
    author: latest.author?.login ?? null,
    isDraft: latest.isDraft,
    reviewDecision: latest.reviewDecision,
    updatedAt: latest.updatedAt,
    headOid: commit?.oid ?? null,
    // Only failures affect derivedAction; transitions between pending and passing do not invalidate triage.
    checksRed: rollup === null ? null : rollup === 'FAILURE' || rollup === 'ERROR',
  };
}

function itemOf(node: Pick<SearchNode, 'projectItems'>, cfg: GithubConfig): ProjectItem | undefined {
  return node.projectItems.nodes.find((item) => onConfiguredProject(item.project, cfg));
}

/**
 * Why the configured field cannot supply status for an item on the project, or null. An unset value is not a
 * problem; a card without status stays active (R1).
 */
export function fieldProblemOf(item: ProjectItem, cfg: GithubConfig): string | null {
  const project = `${projectOwnerOf(cfg)}/${cfg.projectNumber}`;
  const field = item.project.field;

  if (field === null) {
    return `Project ${project} has no field named "${cfg.statusField}".`;
  }

  if (field !== undefined && field.__typename !== 'ProjectV2SingleSelectField') {
    return `The "${cfg.statusField}" field on project ${project} is a ${field.__typename}, not a single-select field.`;
  }

  return null;
}

function toCard(node: SearchNode, cfg: GithubConfig): IssueCard {
  const item = itemOf(node, cfg);
  const status = item?.fieldValueByName?.name ?? null;

  return {
    number: node.number,
    title: node.title,
    state: node.state,
    repository: node.repository.nameWithOwner,
    type: node.issueType?.name ?? null,
    typeColor: node.issueType?.color ?? null,
    url: node.url,
    status,
    statusColor: item?.fieldValueByName?.color ?? null,
    statusChangedAt: item?.fieldValueByName?.updatedAt ?? null,
    assignees: node.assignees.nodes.map((a) => a.login),
    avatar: selectCardAvatar(node, cfg, status),
    pullRequest: selectPullRequest(node),
    updatedAt: node.updatedAt,
  };
}

/** Page assigned issues and map them to cards. Require logins to avoid fetching every open issue in the repository. */
export async function fetchAssignedIssues(cfg: GithubConfig, runner?: GhRunner): Promise<Result<AssignedIssues>> {
  if (cfg.logins.length === 0) {
    return {
      ok: false,
      error: {
        kind: 'no-logins',
        message: 'No GitHub account is configured.',
        remedy: 'Set groundControl.github.logins to your GitHub username, comma-separated if you use more than one.',
      },
    };
  }

  const run = runner ?? makeGhRunner(cfg.ghPath);
  const withProject = cfg.cardSource === 'project';
  const cardsQuery = buildSearchQuery(cfg, withProject);
  const allQuery = buildSearchQuery(cfg, false);

  const seen = new Map<number, IssueCard>();
  let after: string | null = null;
  let matched = 0;
  let totalAssigned = 0;
  let hasNextPage = false;
  let fieldProblem: string | null = null;

  for (let page = 0; page < cfg.maxPages; page++) {
    const args = [
      'api', 'graphql',
      '-f', `query=${ASSIGNED_ISSUES_QUERY}`,
      '-f', `cards=${cardsQuery}`,
      '-f', `all=${allQuery}`,
      '-f', `status=${cfg.statusField}`,
    ];

    if (after) {
      args.push('-f', `after=${after}`);
    }

    const raw = await run(args, { timeoutMs: PAGE_TIMEOUT_MS });

    if (!raw.ok) {
      return raw;
    }

    const parsed = searchResponse.safeParse(raw.value);

    if (!parsed.success) {
      return {
        ok: false,
        error: {
          kind: 'bad-response',
          message: `GitHub returned an unexpected response: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`,
          remedy: 'The GitHub API may have changed. Refresh, and report it if it persists.',
        },
      };
    }

    const { cards, assignedTotal } = parsed.data.data;
    matched = cards.issueCount;
    totalAssigned = assignedTotal.issueCount;
    hasNextPage = cards.pageInfo.hasNextPage;

    for (const node of cards.nodes) {
      seen.set(node.number, toCard(node, cfg));

      const item = itemOf(node, cfg);

      if (item !== undefined && fieldProblem === null) {
        fieldProblem = fieldProblemOf(item, cfg);
      }
    }

    // A null cursor would repeat page one even when hasNextPage is true.
    if (!hasNextPage || !cards.pageInfo.endCursor) {
      break;
    }

    after = cards.pageInfo.endCursor;
  }

  return {
    ok: true,
    value: {
      cards: [...seen.values()],
      matched,
      totalAssigned,
      notOnProject: Math.max(0, totalAssigned - matched),
      truncated: hasNextPage,
      fetchedAt: new Date().toISOString(),
      sourceQuery: cardsQuery,
      fieldProblem,
    },
  };
}

/** Read an issue regardless of state or assignee. Missing repositories and issues return null without an error (R4). */
export async function fetchIssue(
  cfg: GithubConfig,
  owner: string,
  name: string,
  number: number,
  runner?: GhRunner,
  signal?: AbortSignal,
): Promise<Result<IssueCard | null>> {
  const run = runner ?? makeGhRunner(cfg.ghPath);
  const raw = await run(
    ['api', 'graphql', '-f', `query=${ISSUE_BY_NUMBER_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`, '-f', `status=${cfg.statusField}`],
    signal ? { timeoutMs: PAGE_TIMEOUT_MS, signal } : { timeoutMs: PAGE_TIMEOUT_MS },
  );

  if (!raw.ok) {
    return raw;
  }

  const parsed = issueResponse.safeParse(raw.value);

  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: 'bad-response',
        message: `GitHub returned an unexpected response for issue #${number}.`,
        remedy: 'The GitHub API may have changed. Refresh, and report it if it persists.',
      },
    };
  }

  const node = parsed.data.data.repository?.issue ?? null;

  return { ok: true, value: node === null ? null : toCard(node, cfg) };
}
