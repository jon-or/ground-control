import { z } from 'zod';
import type { CustodyEvent, CustodyReading, IssueCard, ReadFailure } from '@ground-control/core';
import { resolveActor } from './accounts.js';
import { TIMELINE_STATUS_FIELD, repositoryOfUrl } from './context.js';
import type { GhRunner } from './gh.js';
import { onConfiguredProject } from './project.js';
import { CUSTODY_QUERY } from './queries.js';
import type { GithubConfig } from './types.js';

/** Duplicated to avoid a circular import with source.ts. */
const GITHUB_SOURCE_ID = 'github';

const CUSTODY_TIMEOUT_MS = 20_000;

/** Pages of 100 events. The sampled issues needed one to five; a read that stops here is reported as truncated. */
const MAX_PAGES = 10;

const actor = z.object({ login: z.string() }).nullable().optional();

/** Timeline event fields vary by type. Ignore unknown event types. */
const node = z
  .object({
    __typename: z.string(),
    createdAt: z.string().optional(),
    actor,
    assignee: z.object({ login: z.string().optional() }).nullable().optional(),
    previousStatus: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    wasAutomated: z.boolean().optional(),
    project: z
      .object({ number: z.number(), owner: z.object({ login: z.string().optional() }).nullable().default(null) })
      .nullable()
      .optional(),
  })
  .nullable();

const timeline = z.object({
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable().default(null) }),
  nodes: z.array(node),
});

const response = z.object({
  data: z.object({
    repository: z
      .object({
        issue: z
          .object({
            number: z.number(),
            title: z.string(),
            url: z.string(),
            state: z.string(),
            createdAt: z.string(),
            closedAt: z.string().nullable().default(null),
            timelineItems: timeline,
          })
          .nullable(),
      })
      .nullable(),
  }),
});

type Node = NonNullable<z.infer<typeof node>>;

function failure(kind: ReadFailure['kind'], message: string, remedy: string): CustodyReading {
  return { history: null, failure: { subject: GITHUB_SOURCE_ID, kind, message, remedy } };
}

/**
 * Read one issue's custody history, oldest events first. A page that fails after the first leaves the history
 * short and marked truncated rather than failing the read. Linked accounts are resolved here, so a linked bot
 * reaches the board package as its person.
 */
export async function fetchCustody(cfg: GithubConfig, card: IssueCard, run: GhRunner, signal: AbortSignal): Promise<CustodyReading> {
  const repository = repositoryOfUrl(card.url);

  if (repository === null) {
    return failure('bad-response', `Repository unknown for issue #${card.number}.`, 'Refresh the board so the card is read again.');
  }

  const vars = { query: CUSTODY_QUERY, owner: repository.owner, name: repository.name, number: card.number };
  const page = (after: string | null) =>
    run(
      ['api', 'graphql', '-f', `query=${vars.query}`, '-f', `owner=${vars.owner}`, '-f', `name=${vars.name}`, '-F', `number=${vars.number}`, ...(after === null ? [] : ['-f', `after=${after}`])],
      { timeoutMs: CUSTODY_TIMEOUT_MS, signal },
    );
  const first = await page(null);

  if (!first.ok) {
    return { history: null, failure: { ...first.error, subject: GITHUB_SOURCE_ID } };
  }

  const parsed = response.safeParse(first.value);

  if (!parsed.success) {
    return failure('bad-response', `GitHub returned an unexpected response for issue #${card.number}.`, 'Try again, and report it if it persists.');
  }

  const issue = parsed.data.data.repository?.issue ?? null;

  if (issue === null) {
    return { history: null, failure: null };
  }

  const nodes: (Node | null)[] = [...issue.timelineItems.nodes];
  let info = issue.timelineItems.pageInfo;
  let read = 1;

  while (info.hasNextPage && info.endCursor !== null && read < MAX_PAGES) {
    const more = await page(info.endCursor);
    const parsedMore = more.ok ? response.safeParse(more.value) : null;
    const timelineItems = parsedMore?.data?.data.repository?.issue?.timelineItems;

    if (!timelineItems) {
      break;
    }

    nodes.push(...timelineItems.nodes);
    info = timelineItems.pageInfo;
    read += 1;
  }

  const resolve = (login: string) => resolveActor(cfg.linkedAccounts, cfg.profiles, { login }).login;
  const statusEvents = cfg.statusField === TIMELINE_STATUS_FIELD;
  const events: CustodyEvent[] = [];
  let closedBy: string | null = null;

  for (const item of nodes) {
    if (item === null || item.createdAt === undefined) {
      continue;
    }

    const who = item.actor?.login === undefined ? null : resolve(item.actor.login);
    const base = { at: item.createdAt, actor: who, automated: false, status: null, assigned: null, unassigned: null };

    if (item.__typename === 'ProjectV2ItemStatusChangedEvent' && statusEvents && item.project && onConfiguredProject(item.project, cfg)) {
      events.push({ ...base, automated: item.wasAutomated === true, status: { from: item.previousStatus || null, to: item.status || null } });
    }

    if (item.__typename === 'AssignedEvent' && item.assignee?.login) {
      events.push({ ...base, assigned: resolve(item.assignee.login) });
    }

    if (item.__typename === 'UnassignedEvent' && item.assignee?.login) {
      events.push({ ...base, unassigned: resolve(item.assignee.login) });
    }

    // Events are oldest first, so the last close seen is the one that stands.
    if (item.__typename === 'ClosedEvent') {
      closedBy = who;
    }
  }

  return {
    history: {
      number: issue.number,
      title: issue.title,
      url: issue.url,
      state: issue.state,
      createdAt: issue.createdAt,
      closedAt: issue.closedAt,
      closedBy: issue.state === 'CLOSED' ? closedBy : null,
      events,
      truncated: info.hasNextPage,
    },
    failure: null,
  };
}
