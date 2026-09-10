import { z } from 'zod';
import type {
  DetailEvent,
  DetailPost,
  DetailReaction,
  DetailReading,
  DetailSubject,
  DetailThread,
  IssueCard,
  ItemDetail,
} from '@ground-control/core';
import { DETAIL_EVENTS_QUERY, DETAIL_QUERY, DETAIL_THREADS_QUERY } from './queries.js';
import type { GhRunner } from './gh.js';
import type { GithubConfig } from './types.js';

/** Bound one page; a card's conversation is not worth a long-running gh process. */
const DETAIL_TIMEOUT_MS = 20_000;

/**
 * Page limits. Reads run backwards from the newest entry, so stopping early drops the oldest, never the latest.
 * The hub's own budget usually stops a long read first; either way the conversation is reported as clipped.
 */
const MAX_EVENT_PAGES = 20;
const MAX_THREAD_PAGES = 5;

const actor = z.object({ login: z.string(), avatarUrl: z.string().nullable().default(null) }).nullable();

const reactionGroups = z
  .array(z.object({ content: z.string(), reactors: z.object({ totalCount: z.number() }) }))
  .nullable()
  .default([]);

const reference = z
  .object({ number: z.number().optional(), url: z.string().optional(), repository: z.object({ nameWithOwner: z.string() }).optional() })
  .nullable()
  .optional();

/**
 * One timeline node. GraphQL returns a different shape per `__typename`, so every field past the discriminator is
 * optional here and read by the mapper that knows the type.
 */
const timelineNode = z.object({
  __typename: z.string(),
  createdAt: z.string().optional(),
  actor: actor.optional(),
  author: actor.optional(),
  id: z.string().optional(),
  state: z.string().optional(),
  bodyHTML: z.string().optional(),
  lastEditedAt: z.string().nullable().optional(),
  isMinimized: z.boolean().optional(),
  minimizedReason: z.string().nullable().optional(),
  reactionGroups: reactionGroups.optional(),
  commit: z
    .object({
      abbreviatedOid: z.string(),
      messageHeadline: z.string().optional(),
      committedDate: z.string().optional(),
      author: z.object({ user: z.object({ login: z.string() }).nullable(), name: z.string().nullable() }).nullable().optional(),
    })
    .nullable()
    .optional(),
  stateReason: z.string().nullable().optional(),
  mergeRefName: z.string().nullable().optional(),
  label: z.object({ name: z.string() }).nullable().optional(),
  assignee: z.object({ login: z.string().optional() }).nullable().optional(),
  milestoneTitle: z.string().nullable().optional(),
  previousTitle: z.string().optional(),
  currentTitle: z.string().optional(),
  source: reference,
  subject: reference,
  canonical: reference,
  previousStatus: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  requestedReviewer: z.object({ login: z.string().optional(), slug: z.string().optional() }).nullable().optional(),
  dismissalMessage: z.string().nullable().optional(),
  beforeCommit: z.object({ abbreviatedOid: z.string() }).nullable().optional(),
  afterCommit: z.object({ abbreviatedOid: z.string() }).nullable().optional(),
  headRefName: z.string().nullable().optional(),
  previousRefName: z.string().optional(),
  currentRefName: z.string().optional(),
  lockReason: z.string().nullable().optional(),
  fromRepository: z.object({ nameWithOwner: z.string() }).nullable().optional(),
});

const page = z.object({ pageInfo: z.object({ hasPreviousPage: z.boolean(), startCursor: z.string().nullable().default(null) }) });

const timeline = page.extend({ nodes: z.array(timelineNode.nullable()) });

const threadPage = page.extend({
  nodes: z.array(
    z.object({
      path: z.string(),
      line: z.number().nullable().default(null),
      originalLine: z.number().nullable().default(null),
      isResolved: z.boolean(),
      isOutdated: z.boolean(),
      comments: z.object({
        pageInfo: z.object({ hasPreviousPage: z.boolean() }),
        nodes: z.array(
          z.object({
            bodyHTML: z.string().default(''),
            createdAt: z.string(),
            lastEditedAt: z.string().nullable().default(null),
            isMinimized: z.boolean().default(false),
            minimizedReason: z.string().nullable().default(null),
            author: actor,
            reactionGroups: reactionGroups.optional(),
            pullRequestReview: z.object({ id: z.string() }).nullable().default(null),
          }),
        ),
      }),
    }),
  ),
});

const item = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  createdAt: z.string(),
  // GitHub renders an empty body as an empty string; older fixtures omit the field.
  bodyHTML: z.string().default(''),
  lastEditedAt: z.string().nullable().default(null),
  author: actor,
  reactionGroups: reactionGroups.optional(),
  assignees: z.object({ nodes: z.array(z.object({ login: z.string() })) }).nullable().default(null),
  milestone: z.object({ title: z.string() }).nullable().default(null),
  labels: z.object({ nodes: z.array(z.object({ name: z.string(), color: z.string() })) }).nullable().default(null),
  isDraft: z.boolean().optional(),
  reviewDecision: z.string().nullable().optional(),
  baseRefName: z.string().optional(),
  headRefName: z.string().optional(),
  commits: z
    .object({ nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }) })) })
    .optional(),
  timelineItems: timeline,
  reviewThreads: threadPage.optional(),
});

/** A null repository or absent item is an unreadable repository or missing subject, without an error. */
const detailResponse = z.object({
  data: z.object({
    repository: z
      .object({
        nameWithOwner: z.string(),
        issue: item.nullable().optional(),
        pullRequest: item.nullable().optional(),
      })
      .nullable(),
  }),
});

const eventsResponse = z.object({
  data: z.object({
    repository: z
      .object({
        issue: z.object({ timelineItems: timeline }).nullable().optional(),
        pullRequest: z.object({ timelineItems: timeline }).nullable().optional(),
      })
      .nullable(),
  }),
});

const threadsResponse = z.object({
  data: z.object({
    repository: z.object({ pullRequest: z.object({ reviewThreads: threadPage }).nullable() }).nullable(),
  }),
});

type TimelineNode = z.infer<typeof timelineNode>;
type ThreadNode = z.infer<typeof threadPage>['nodes'][number];

function toReactions(groups: z.infer<typeof reactionGroups> | undefined): DetailReaction[] {
  return (groups ?? []).filter((group) => group.reactors.totalCount > 0).map((group) => ({ content: group.content, count: group.reactors.totalCount }));
}

/** Read a GraphQL enum as prose: every underscore, not just the first. */
function words(value: string): string {
  return value.toLowerCase().replaceAll('_', ' ');
}

/** Name whoever GitHub reports for a reference: a login for a user or bot, a slug for a team. */
function nameOf(who: { login?: string | undefined; slug?: string | undefined } | null | undefined): string {
  return who?.login ?? who?.slug ?? 'someone';
}

/** Name a referenced item. Another repository is spelled out; this one is not, because the reader is already in it. */
function referenceOf(ref: z.infer<typeof reference>, repository: string): { name: string; url: string | null } {
  const where = ref?.repository?.nameWithOwner;

  return { name: `${where === undefined || where === repository ? '' : where}#${ref?.number ?? '?'}`, url: ref?.url ?? null };
}

/**
 * Compose the one line a state change reads as. The wording is a product decision, so it is settled here rather
 * than in each client. A type outside the query's `itemTypes` cannot arrive, so an unknown one is dropped.
 */
function noteOf(node: TimelineNode, repository: string): { summary: string; url: string | null } | null {
  switch (node.__typename) {
    case 'ClosedEvent':
      return { summary: node.stateReason ? `closed this as ${words(node.stateReason)}` : 'closed this', url: null };
    case 'ReopenedEvent':
      return { summary: 'reopened this', url: null };
    case 'MergedEvent':
      return { summary: `merged this into ${node.mergeRefName ?? 'the base branch'}`, url: null };
    case 'LabeledEvent':
      return { summary: `added the ${node.label?.name ?? 'unnamed'} label`, url: null };
    case 'UnlabeledEvent':
      return { summary: `removed the ${node.label?.name ?? 'unnamed'} label`, url: null };
    case 'AssignedEvent':
      return { summary: `assigned ${nameOf(node.assignee)}`, url: null };
    case 'UnassignedEvent':
      return { summary: `unassigned ${nameOf(node.assignee)}`, url: null };
    case 'MilestonedEvent':
      return { summary: `added this to the ${node.milestoneTitle ?? 'unnamed'} milestone`, url: null };
    case 'DemilestonedEvent':
      return { summary: `removed this from the ${node.milestoneTitle ?? 'unnamed'} milestone`, url: null };
    case 'RenamedTitleEvent':
      return { summary: `renamed this to ${node.currentTitle ?? ''}`, url: null };
    case 'CrossReferencedEvent': {
      const at = referenceOf(node.source, repository);

      return { summary: `referenced this in ${at.name}`, url: at.url };
    }
    case 'ReferencedEvent':
      return { summary: `referenced this in commit ${node.commit?.abbreviatedOid ?? 'an unreadable commit'}`, url: null };
    case 'ProjectV2ItemStatusChangedEvent':
      return {
        summary: node.previousStatus ? `moved this from ${node.previousStatus} to ${node.status ?? 'no status'}` : `set the status to ${node.status ?? 'no status'}`,
        url: null,
      };
    case 'ConnectedEvent': {
      const linked = referenceOf(node.subject, repository);

      return { summary: `linked ${linked.name}`, url: linked.url };
    }
    case 'DisconnectedEvent': {
      const unlinked = referenceOf(node.subject, repository);

      return { summary: `unlinked ${unlinked.name}`, url: unlinked.url };
    }
    case 'ReviewRequestedEvent':
      return { summary: `requested a review from ${nameOf(node.requestedReviewer)}`, url: null };
    case 'ReviewRequestRemovedEvent':
      return { summary: `removed the review request for ${nameOf(node.requestedReviewer)}`, url: null };
    case 'ReviewDismissedEvent':
      return { summary: node.dismissalMessage ? `dismissed a review: ${node.dismissalMessage}` : 'dismissed a review', url: null };
    case 'HeadRefForcePushedEvent':
      return { summary: `force-pushed from ${node.beforeCommit?.abbreviatedOid ?? '?'} to ${node.afterCommit?.abbreviatedOid ?? '?'}`, url: null };
    case 'HeadRefDeletedEvent':
      return { summary: `deleted the ${node.headRefName ?? 'head'} branch`, url: null };
    case 'HeadRefRestoredEvent':
      return { summary: 'restored the head branch', url: null };
    case 'BaseRefChangedEvent':
      return { summary: `changed the base from ${node.previousRefName ?? '?'} to ${node.currentRefName ?? '?'}`, url: null };
    case 'ReadyForReviewEvent':
      return { summary: 'marked this ready for review', url: null };
    case 'ConvertToDraftEvent':
      return { summary: 'converted this to a draft', url: null };
    case 'LockedEvent':
      return { summary: node.lockReason ? `locked this as ${words(node.lockReason)}` : 'locked this', url: null };
    case 'UnlockedEvent':
      return { summary: 'unlocked this', url: null };
    case 'MarkedAsDuplicateEvent': {
      const canonical = referenceOf(node.canonical, repository);

      return { summary: `marked this a duplicate of ${canonical.name}`, url: canonical.url };
    }
    case 'UnmarkedAsDuplicateEvent':
      return { summary: 'removed the duplicate mark', url: null };
    case 'TransferredEvent':
      return { summary: `transferred this from ${node.fromRepository?.nameWithOwner ?? 'another repository'}`, url: null };
    default:
      return null;
  }
}

function toEvent(node: TimelineNode, repository: string): DetailEvent | null {
  if (node.__typename === 'IssueComment' || node.__typename === 'PullRequestReview') {
    const review = node.__typename === 'PullRequestReview';

    return {
      kind: review ? 'review' : 'comment',
      author: node.author?.login ?? null,
      avatarUrl: node.author?.avatarUrl ?? null,
      bodyHtml: node.bodyHTML ?? '',
      createdAt: node.createdAt ?? '',
      editedAt: node.lastEditedAt ?? null,
      reactions: toReactions(node.reactionGroups),
      hidden: node.isMinimized === true ? (node.minimizedReason ?? 'hidden') : null,
      state: review ? (node.state ?? null) : null,
      threads: [],
    };
  }

  if (node.__typename === 'PullRequestCommit') {
    const commit = node.commit;

    return {
      kind: 'commit',
      actor: commit?.author?.user?.login ?? commit?.author?.name ?? null,
      avatarUrl: null,
      createdAt: commit?.committedDate ?? '',
      summary: `${commit?.abbreviatedOid ?? ''} ${commit?.messageHeadline ?? ''}`.trim(),
      url: null,
    };
  }

  const note = noteOf(node, repository);

  return note === null
    ? null
    : { kind: 'note', actor: node.actor?.login ?? null, avatarUrl: node.actor?.avatarUrl ?? null, createdAt: node.createdAt ?? '', summary: note.summary, url: note.url };
}

function toThread(node: ThreadNode): { thread: DetailThread; review: string | null } {
  return {
    review: node.comments.nodes[0]?.pullRequestReview?.id ?? null,
    thread: {
      path: node.path,
      line: node.line ?? node.originalLine,
      resolved: node.isResolved,
      outdated: node.isOutdated,
      comments: node.comments.nodes.map<DetailPost>((comment) => ({
        kind: 'comment',
        author: comment.author?.login ?? null,
        avatarUrl: comment.author?.avatarUrl ?? null,
        bodyHtml: comment.bodyHTML,
        createdAt: comment.createdAt,
        editedAt: comment.lastEditedAt,
        reactions: toReactions(comment.reactionGroups),
        hidden: comment.isMinimized ? (comment.minimizedReason ?? 'hidden') : null,
        state: null,
        threads: [],
      })),
      moreComments: node.comments.pageInfo.hasPreviousPage,
    },
  };
}

/** `-f` sends a string; `-F` types the value, which the query's Int and Boolean variables require. */
function graphql(vars: Record<string, string | number | boolean>): string[] {
  return [
    'api',
    'graphql',
    ...Object.entries(vars).flatMap(([key, value]) => [typeof value === 'string' ? '-f' : '-F', `${key}=${String(value)}`]),
  ];
}

function bounds(signal: AbortSignal | undefined): { timeoutMs: number; signal?: AbortSignal } {
  return signal ? { timeoutMs: DETAIL_TIMEOUT_MS, signal } : { timeoutMs: DETAIL_TIMEOUT_MS };
}

/**
 * Read one conversation for display, newest entries first. A page that fails after the first leaves the
 * conversation short and marked clipped, rather than failing the read.
 */
export async function fetchDetail(
  cfg: GithubConfig,
  owner: string,
  name: string,
  number: number,
  subject: DetailSubject,
  run: GhRunner,
  signal?: AbortSignal,
): Promise<DetailReading> {
  const issue = subject === 'issue';
  const address = { owner, name, number, issue, pr: !issue };
  const raw = await run(graphql({ query: DETAIL_QUERY, ...address }), bounds(signal));

  if (!raw.ok) {
    return { detail: null, failure: { message: raw.error.message, remedy: raw.error.remedy } };
  }

  const parsed = detailResponse.safeParse(raw.value);

  if (!parsed.success) {
    return {
      detail: null,
      failure: {
        message: `GitHub returned an unexpected response for ${issue ? 'issue' : 'pull request'} #${number}.`,
        remedy: 'The GitHub API may have changed. Try again, and report it if it persists.',
      },
    };
  }

  const repository = parsed.data.data.repository;
  const node = (issue ? repository?.issue : repository?.pullRequest) ?? null;

  // A repository the read cannot see, or a subject it does not hold, is an absence rather than a failure.
  if (repository === null || node === null) {
    return { detail: null, failure: null };
  }

  // Each page holds the entries before the ones already read, so it goes in front of them and order is kept.
  const nodes = [...node.timelineItems.nodes];
  let events = node.timelineItems.pageInfo;

  for (let read = 1; read < MAX_EVENT_PAGES && events.hasPreviousPage && events.startCursor !== null; read += 1) {
    const more = await run(graphql({ query: DETAIL_EVENTS_QUERY, ...address, events: events.startCursor }), bounds(signal));
    const parsedMore = more.ok ? eventsResponse.safeParse(more.value) : null;
    const timelineItems = (issue ? parsedMore?.data?.data.repository?.issue : parsedMore?.data?.data.repository?.pullRequest)?.timelineItems;

    if (!timelineItems) {
      break;
    }

    nodes.unshift(...timelineItems.nodes);
    events = timelineItems.pageInfo;
  }

  const threadNodes = [...(node.reviewThreads?.nodes ?? [])];
  let threads = node.reviewThreads?.pageInfo;

  for (let read = 1; read < MAX_THREAD_PAGES && threads?.hasPreviousPage === true && threads.startCursor !== null; read += 1) {
    const more = await run(graphql({ query: DETAIL_THREADS_QUERY, owner, name, number, threads: threads.startCursor }), bounds(signal));
    const parsedMore = more.ok ? threadsResponse.safeParse(more.value) : null;
    const reviewThreads = parsedMore?.data?.data.repository?.pullRequest?.reviewThreads;

    if (!reviewThreads) {
      break;
    }

    threadNodes.unshift(...reviewThreads.nodes);
    threads = reviewThreads.pageInfo;
  }

  return {
    detail: toDetail(node, repository.nameWithOwner, subject, nodes, threadNodes, {
      events: events.hasPreviousPage,
      threads: threads?.hasPreviousPage === true,
    }),
    failure: null,
  };
}

/** Order threads by file then line, because GitHub returns them in review order and the panel shows no diff. */
function byPlace(a: DetailThread, b: DetailThread): number {
  return a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0);
}

function toDetail(
  node: z.infer<typeof item>,
  repository: string,
  subject: DetailSubject,
  nodes: (TimelineNode | null)[],
  threadNodes: ThreadNode[],
  more: { events: boolean; threads: boolean },
): ItemDetail {
  const events: DetailEvent[] = [];
  // Keep each review by its node id, so the threads it opened can be hung off it rather than listed apart.
  const reviews = new Map<string, DetailPost>();

  for (const entry of nodes) {
    const event = entry === null ? null : toEvent(entry, repository);

    if (entry === null || event === null) {
      continue;
    }

    events.push(event);

    if (entry.__typename === 'PullRequestReview' && entry.id !== undefined) {
      reviews.set(entry.id, event as DetailPost);
    }
  }

  const orphans: DetailThread[] = [];

  for (const { thread, review } of threadNodes.map(toThread)) {
    const opened = review === null ? undefined : reviews.get(review);

    if (opened) {
      opened.threads.push(thread);
    } else {
      orphans.push(thread);
    }
  }

  for (const review of reviews.values()) {
    review.threads.sort(byPlace);
  }

  return {
    subject,
    number: node.number,
    repository,
    title: node.title,
    url: node.url,
    state: node.state,
    bodyHtml: node.bodyHTML,
    author: node.author?.login ?? null,
    authorAvatarUrl: node.author?.avatarUrl ?? null,
    createdAt: node.createdAt,
    editedAt: node.lastEditedAt,
    reactions: toReactions(node.reactionGroups),
    labels: node.labels?.nodes ?? [],
    assignees: node.assignees?.nodes.map((who) => who.login) ?? [],
    milestone: node.milestone?.title ?? null,
    branches: node.baseRefName && node.headRefName ? { base: node.baseRefName, head: node.headRefName } : null,
    draft: node.isDraft === true,
    reviewDecision: node.reviewDecision ?? null,
    checks: node.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    events,
    moreEvents: more.events,
    moreThreads: more.threads,
    threads: orphans.sort(byPlace),
  };
}

/**
 * Address the item a card points at. Each subject resolves against its own URL: a closing pull request can live in
 * another repository, where the issue's owner and name would name a different item with the same number.
 */
export function itemAddress(card: IssueCard, subject: DetailSubject): { owner: string; name: string; number: number } | null {
  const item = subject === 'issue' ? { url: card.url, number: card.number } : card.pullRequest;

  if (item === null || item === undefined) {
    return null;
  }

  const parts = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\//.exec(item.url);

  return parts === null ? null : { owner: parts[1] ?? '', name: parts[2] ?? '', number: item.number };
}
