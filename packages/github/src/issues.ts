import { ASSIGNED_ISSUES_QUERY } from './queries.js';
import type { GhRunner } from './gh.js';
import { makeGhRunner } from './gh.js';
import type { AssignedIssues, GithubConfig, IssueCard, Result, SearchNode } from './types.js';
import { searchResponse } from './types.js';

/**
 * Repeated `assignee:` qualifiers OR in GitHub's issue search — verified against ownerrez/orez.
 * They AND in `projectV2.items(query:)`, so this trick does not survive a move to the project API.
 */
export function buildSearchQuery(cfg: GithubConfig, withProject: boolean): string {
  const parts = [`repo:${cfg.repo}`, 'is:issue', 'is:open', ...cfg.logins.map((l) => `assignee:${l}`)];

  if (withProject) {
    parts.push(`project:${cfg.repo.split('/')[0]}/${cfg.projectNumber}`);
  }

  return parts.join(' ');
}

function toCard(node: SearchNode, projectNumber: number): IssueCard {
  const item = node.projectItems.nodes.find((i) => i.project.number === projectNumber);

  return {
    number: node.number,
    title: node.title,
    type: node.issueType?.name ?? null,
    url: node.url,
    status: item?.fieldValueByName?.name ?? null,
    assignees: node.assignees.nodes.map((a) => a.login),
    updatedAt: node.updatedAt,
  };
}

/**
 * Pages the assigned-issue search and maps it to cards. Refuses to query with no logins: an unqualified
 * search returns the whole repo's open issues, which the board would then show as the developer's own.
 */
export async function fetchAssignedIssues(cfg: GithubConfig, runner?: GhRunner): Promise<Result<AssignedIssues>> {
  if (cfg.logins.length === 0) {
    return {
      ok: false,
      error: {
        kind: 'no-logins',
        message: 'No GitHub account is configured, so the board cannot tell which issues are yours.',
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

  for (let page = 0; page < cfg.maxPages; page++) {
    const args = ['api', 'graphql', '-f', `query=${ASSIGNED_ISSUES_QUERY}`, '-f', `cards=${cardsQuery}`, '-f', `all=${allQuery}`];

    if (after) {
      args.push('-f', `after=${after}`);
    }

    const raw = await run(args);

    if (!raw.ok) {
      return raw;
    }

    const parsed = searchResponse.safeParse(raw.value);

    if (!parsed.success) {
      return {
        ok: false,
        error: {
          kind: 'bad-response',
          message: `GitHub returned a shape the board does not understand: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`,
          remedy: 'The GitHub API may have changed. Refresh, and report it if it persists.',
        },
      };
    }

    const { cards, assignedTotal } = parsed.data.data;
    matched = cards.issueCount;
    totalAssigned = assignedTotal.issueCount;
    hasNextPage = cards.pageInfo.hasNextPage;

    for (const node of cards.nodes) {
      seen.set(node.number, toCard(node, cfg.projectNumber));
    }

    // The schema allows a null cursor alongside hasNextPage; without this the next request drops `after`
    // and re-reads page one, burning the page budget while the Map hides the duplication.
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
    },
  };
}
