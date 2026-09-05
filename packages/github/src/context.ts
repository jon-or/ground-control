import { z } from 'zod';
import type { ContextReading, IssueCard, TriageComment, TriageContext, TriagePullRequest } from '@ground-control/core';
import { CARD_CONTEXT_QUERY } from './queries.js';
import type { GhRunner } from './gh.js';
import type { GithubConfig } from './types.js';

/** Duplicated from `source.ts` rather than imported: the two would import each other, and this is one string. */
const GITHUB_SOURCE_ID = 'github';

/**
 * How much of each body reaches the prompt, in characters — UTF-16 code units, so a body of CJK or emoji is longer
 * on the wire than it is here. Anything longer keeps its first and last thousand and says what came out between.
 */
const BODY_LIMIT = 2_000;
const COMMENT_LIMIT = 2_000;

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

/**
 * How the kept characters are split when a body is too long. Evenly, because a comment's opening frames what it is
 * about and its last line is usually what it asks for — either end alone loses half of why the board is reading it.
 */
const HEAD_SHARE = 0.5;

/** How far from a cut a word boundary has to be to be worth backing up to, rather than cutting mid-token. */
const WORD_REACH = 200;

/** The last word boundary at or before `at`, or `at` where the text has none near enough to be worth taking. */
function backTo(text: string, at: number): number {
  const space = text.lastIndexOf(' ', at);

  return space > 0 && space > at - WORD_REACH ? space : at;
}

/** The next word boundary at or after `at`, or `at` where there is none near enough. */
function forwardTo(text: string, at: number): number {
  const space = text.indexOf(' ', at);

  return space > 0 && space < at + WORD_REACH ? space + 1 : at;
}

/**
 * Text bounded to `limit` characters of the original, keeping both ends and saying what came out of the middle.
 * Characters, not bytes: this counts UTF-16 code units, so a body of CJK or emoji is longer on the wire than it is
 * here. The middle is what goes because a comment's last line is usually the ask — the whole reason the board is
 * reading it — where a clip that took the tail would carry the preamble and drop the request.
 *
 * The marker is added on top of `limit`, so what is bounded is how much of the original text travels.
 */
export function clip(text: string | null, limit: number): string {
  const trimmed = (text ?? '').trim();

  if (trimmed.length <= limit) {
    return trimmed;
  }

  const head = trimmed.slice(0, backTo(trimmed, Math.ceil(limit * HEAD_SHARE))).trimEnd();
  const tail = trimmed.slice(forwardTo(trimmed, trimmed.length - (limit - head.length))).trimStart();

  return `${head}
[…${trimmed.length - head.length - tail.length} characters omitted…]
${tail}`;
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
