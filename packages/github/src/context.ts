import { z } from 'zod';
import type { ContextReading, IssueCard, TriageComment, TriageContext, TriagePullRequest } from '@ground-control/core';
import { CARD_CONTEXT_QUERY } from './queries.js';
import type { GhRunner } from './gh.js';
import type { GithubConfig } from './types.js';

/** Duplicated from `source.ts` rather than imported: the two would import each other, and this is one string. */
const GITHUB_SOURCE_ID = 'github';

/**
 * How much of each body reaches the prompt. Measured against real review threads on this team's repository, which run
 * to 1–2 KB each: enough to carry what somebody actually asked for, and bounded so a card with a long argument on it
 * costs the same as a card without one.
 */
const BODY_LIMIT = 2_000;
const COMMENT_LIMIT = 1_000;

/** A hung `gh` would hold a triage slot for as long as the hub runs, and the card would claim to be triaging forever. */
const CONTEXT_TIMEOUT_MS = 20_000;

const actor = z.object({ login: z.string() }).nullable();

const comment = z.object({
  body: z.string(),
  createdAt: z.string(),
  authorAssociation: z.string().nullable().default(null),
  author: actor,
});

const contextResponse = z.object({
  data: z.object({
    repository: z
      .object({
        issue: z
          .object({
            number: z.number(),
            title: z.string(),
            body: z.string().nullable(),
            comments: z.object({ nodes: z.array(comment) }),
          })
          .nullable(),
        pullRequest: z
          .object({
            number: z.number(),
            title: z.string(),
            body: z.string().nullable(),
            state: z.string(),
            isDraft: z.boolean(),
            author: actor,
            reviewDecision: z.string().nullable(),
            mergeable: z.string().nullable(),
            mergeStateStatus: z.string().nullable(),
            commits: z.object({
              nodes: z.array(
                z.object({ commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }) }),
              ),
            }),
            comments: z.object({ nodes: z.array(comment) }),
            reviews: z.object({
              nodes: z.array(z.object({ state: z.string(), submittedAt: z.string().nullable(), author: actor })),
            }),
            reviewRequests: z.object({
              nodes: z.array(
                z.object({
                  requestedReviewer: z
                    .object({ login: z.string().optional(), slug: z.string().optional() })
                    .nullable(),
                }),
              ),
            }),
            reviewThreads: z.object({
              nodes: z.array(
                z.object({
                  isResolved: z.boolean(),
                  isOutdated: z.boolean(),
                  comments: z.object({ nodes: z.array(comment) }),
                }),
              ),
            }),
          })
          .optional()
          .nullable(),
      })
      .nullable(),
  }),
});

/** Clipped at a word where one is near the cut, so a body never ends mid-token. Empty text stays empty, not `""…`. */
export function clip(text: string | null, limit: number): string {
  const trimmed = (text ?? '').trim();

  if (trimmed.length <= limit) {
    return trimmed;
  }

  const cut = trimmed.slice(0, limit);
  const space = cut.lastIndexOf(' ');

  // A body with no space near the cut — a long token, a base64 blob — keeps the cut. `lastIndexOf` answering -1 is
  // exactly that case, and taking it as a position would drop the last character of every such body.
  return `${space > 0 && space > limit - 200 ? cut.slice(0, space) : cut}…`;
}

function commentsOf(nodes: z.infer<typeof comment>[], limit = COMMENT_LIMIT): TriageComment[] {
  return nodes.map((node) => ({
    author: node.author?.login ?? null,
    authorAssociation: node.authorAssociation,
    body: clip(node.body, limit),
    createdAt: node.createdAt,
  }));
}

/** The owner and name a card's own URL carries, so a board reading two repositories asks each about its own cards. */
export function repositoryOfUrl(url: string): { owner: string; name: string } | null {
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\//.exec(url);

  return match?.[1] && match[2] ? { owner: match[1], name: match[2] } : null;
}

function pullRequestOf(raw: NonNullable<z.infer<typeof contextResponse>['data']['repository']>['pullRequest']): TriagePullRequest | null {
  if (!raw) {
    return null;
  }

  return {
    number: raw.number,
    title: raw.title,
    body: clip(raw.body, BODY_LIMIT),
    state: raw.state,
    isDraft: raw.isDraft,
    author: raw.author?.login ?? null,
    reviewDecision: raw.reviewDecision,
    mergeable: raw.mergeable,
    mergeStateStatus: raw.mergeStateStatus,
    // Null where the repository runs no checks at all, which is not the same as checks that have not passed.
    checkState: raw.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    comments: commentsOf(raw.comments.nodes),
    reviews: raw.reviews.nodes.map((review) => ({
      author: review.author?.login ?? null,
      state: review.state,
      submittedAt: review.submittedAt,
    })),
    reviewRequests: raw.reviewRequests.nodes.flatMap((request) => {
      const name = request.requestedReviewer?.login ?? request.requestedReviewer?.slug;

      return name ? [name] : [];
    }),
    threads: raw.reviewThreads.nodes.map((thread) => ({
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      comments: commentsOf(thread.comments.nodes),
    })),
  };
}

/**
 * Everything one card's triage reads, in one round trip. The pull request asked for is the one the card is already
 * showing — a second answer to "which pull request is this card about" would let the facts describe one thing while
 * the chip names another.
 */
export async function fetchCardContext(
  config: GithubConfig,
  card: IssueCard,
  run: GhRunner,
  signal: AbortSignal,
): Promise<ContextReading> {
  const repository = repositoryOfUrl(card.url);

  if (repository === null) {
    return {
      context: null,
      failure: {
        subject: GITHUB_SOURCE_ID,
        kind: 'bad-response',
        message: `The board could not tell which repository issue #${card.number} is in.`,
        remedy: 'Refresh the board so the card is read again.',
      },
    };
  }

  const pullRequest = card.pullRequest;
  const result = await run(
    [
      'api',
      'graphql',
      '-f',
      `query=${CARD_CONTEXT_QUERY}`,
      '-f',
      `owner=${repository.owner}`,
      '-f',
      `name=${repository.name}`,
      '-F',
      `issue=${card.number}`,
      '-F',
      `pr=${pullRequest?.number ?? 0}`,
      '-F',
      `withPr=${pullRequest !== null}`,
    ],
    { timeoutMs: CONTEXT_TIMEOUT_MS, signal },
  );

  if (!result.ok) {
    return { context: null, failure: { ...result.error, subject: GITHUB_SOURCE_ID } };
  }

  const parsed = contextResponse.safeParse(result.value);

  if (!parsed.success || !parsed.data.data.repository?.issue) {
    return {
      context: null,
      failure: {
        subject: GITHUB_SOURCE_ID,
        kind: 'bad-response',
        message: `GitHub's answer for issue #${card.number} was not the shape the board reads.`,
        remedy: 'Refresh the board, and re-record the context fixture if the API has changed.',
      },
    };
  }

  const issue = parsed.data.data.repository.issue;

  return {
    context: {
      issueNumber: issue.number,
      title: issue.title,
      body: clip(issue.body, BODY_LIMIT),
      status: card.status,
      comments: commentsOf(issue.comments.nodes),
      pullRequest: pullRequestOf(parsed.data.data.repository.pullRequest),
      logins: config.logins,
    },
    failure: null,
  };
}
