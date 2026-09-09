import { z } from 'zod';
import type {
  ContextReading,
  IssueCard,
  TriageComment,
  TriageContext,
  TriagePullRequest,
  TriageStateEvent,
} from '@ground-control/core';
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

const actor = z.object({ login: z.string(), name: z.string().nullable().default(null) }).nullable();

const comment = z.object({
  body: z.string(),
  createdAt: z.string(),
  authorAssociation: z.string().nullable().default(null),
  author: actor,
});

/**
 * One timeline entry the board asked for. Every field but the type is optional because three event types share the
 * shape, and an unrecognised one is dropped rather than refused — a new type on the timeline is not a bad response.
 */
const timelineItem = z.object({
  __typename: z.string(),
  createdAt: z.string().optional(),
  actor: actor.optional(),
  assignee: z.object({ login: z.string().optional() }).nullable().optional(),
  // Nullable as well as optional: GitHub declares both `String`, and a cleared status answers null rather than absent.
  previousStatus: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  project: z.object({ number: z.number() }).nullable().optional(),
});

const contextResponse = z.object({
  data: z.object({
    repository: z
      .object({
        // Defaulted: a context fixture recorded before it was selected must stay readable, and a repository whose
        // default branch cannot be read refuses every action rather than assuming one (R39).
        defaultBranchRef: z.object({ name: z.string() }).nullable().default(null),
        issue: z
          .object({
            number: z.number(),
            title: z.string(),
            body: z.string().nullable(),
            comments: z.object({ nodes: z.array(comment) }),
            // Defaulted: the context fixtures recorded before the timeline was selected must stay readable.
            timelineItems: z.object({ nodes: z.array(timelineItem) }).default({ nodes: [] }),
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
            // Defaulted for the same reason `defaultBranchRef` is. An empty base or head refuses every action: the
            // board will not merge a branch it could not name.
            baseRefName: z.string().default(''),
            headRefName: z.string().default(''),
            commits: z.object({
              nodes: z.array(
                z.object({
                  commit: z.object({
                    oid: z.string().default(''),
                    statusCheckRollup: z.object({ state: z.string() }).nullable(),
                  }),
                }),
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
                    .object({ login: z.string().optional(), name: z.string().nullable().optional(), slug: z.string().optional() })
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
 * Keep both ends of text, bounded by UTF-16 code units of original content. Add the omission marker outside
 * that limit. Preserving the tail retains requests commonly placed at the end of comments; wire bytes may
 * exceed the character count.
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
    authorName: node.author?.name ?? null,
    authorAssociation: node.authorAssociation,
    body: clip(node.body, limit),
    createdAt: node.createdAt,
  }));
}

/**
 * The status moves and assignments on one project, oldest first. Anything the board cannot place is dropped: an
 * event on another project the issue also sits on, one GitHub gave no time, and any type added to the timeline
 * since. What a run of these means is the board's to decide — this only reports what happened.
 */
function stateEventsOf(nodes: z.infer<typeof timelineItem>[], projectNumber: number): TriageStateEvent[] {
  const events: TriageStateEvent[] = [];

  for (const node of nodes) {
    if (node.createdAt === undefined) {
      continue;
    }

    const at = { at: node.createdAt, actor: node.actor?.login ?? null, actorName: node.actor?.name ?? null };

    // A move with no destination is a status cleared, which names no work — and an empty `from` already means the
    // card being added to the board, so the same sentinel cannot stand for both.
    if (node.__typename === 'ProjectV2ItemStatusChangedEvent' && node.project?.number === projectNumber && node.status) {
      events.push({ ...at, status: { from: node.previousStatus ?? '', to: node.status }, assigned: null, unassigned: null });
    }

    if (node.__typename === 'AssignedEvent' && node.assignee?.login) {
      events.push({ ...at, status: null, assigned: node.assignee.login, unassigned: null });
    }

    if (node.__typename === 'UnassignedEvent' && node.assignee?.login) {
      events.push({ ...at, status: null, assigned: null, unassigned: node.assignee.login });
    }
  }

  return events;
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
    authorName: raw.author?.name ?? null,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    headOid: raw.commits.nodes[0]?.commit.oid ?? '',
    // Null where the repository runs no checks at all, which is not the same as checks that have not passed.
    checkState: raw.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    comments: commentsOf(raw.comments.nodes),
    reviews: raw.reviews.nodes.map((review) => ({
      author: review.author?.login ?? null,
      authorName: review.author?.name ?? null,
      state: review.state,
      submittedAt: review.submittedAt,
    })),
    reviewRequests: raw.reviewRequests.nodes.flatMap((request) => {
      const reviewer = request.requestedReviewer;
      const login = reviewer?.login ?? reviewer?.slug;

      return login ? [{ login, name: reviewer?.name ?? null }] : [];
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
        message: `Repository unknown for issue #${card.number}.`,
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
        message: `GitHub returned an unexpected response for issue #${card.number}.`,
        remedy: 'Refresh the board. If the error persists, report it.',
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
      stateEvents: stateEventsOf(issue.timelineItems.nodes, config.projectNumber),
      comments: commentsOf(issue.comments.nodes),
      pullRequest: pullRequestOf(parsed.data.data.repository.pullRequest),
      logins: config.logins,
      repository: `${repository.owner}/${repository.name}`,
      defaultBranch: parsed.data.data.repository.defaultBranchRef?.name ?? null,
    },
    failure: null,
  };
}
