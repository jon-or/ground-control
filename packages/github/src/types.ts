import { z } from 'zod';
import type { CardAvatar, CardPullRequest, IssueCard } from '@ground-control/core';

export type { CardAvatar, CardPullRequest, IssueCard };

/** project adds a project: search qualifier; issueSearch does not. */
export type CardSource = 'project' | 'issueSearch';

export interface GithubConfig {
  ghPath: string;
  repo: string;
  logins: string[];
  projectNumber: number;
  cardSource: CardSource;
  maxPages: number;
}

export interface AssignedIssues {
  cards: IssueCard[];
  /** Matches for the filtered query, used to calculate truncation. */
  matched: number;
  /** Issues assigned to these logins regardless of the project filter. */
  totalAssigned: number;
  /** Assigned issues excluded by the project filter, reported on the board (R1). */
  notOnProject: number;
  /** More matches exist than were fetched within `maxPages`. */
  truncated: boolean;
  fetchedAt: string;
  sourceQuery: string;
}

export type FailureKind =
  | 'gh-missing'
  | 'not-authenticated'
  | 'no-logins'
  | 'offline'
  | 'timed-out'
  | 'query-failed'
  | 'bad-response';

export interface Failure {
  kind: FailureKind;
  message: string;
  remedy: string;
  /** Transient offline and timed-out failures retain cached cards while the hub retries. */
  transient?: boolean;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: Failure };

const projectItem = z.object({
  project: z.object({ number: z.number() }),
  // Older fixtures omit updatedAt. It tracks Status changes, not assignments (M32).
  fieldValueByName: z
    .object({ name: z.string(), color: z.string().nullable(), updatedAt: z.string().nullable().default(null) })
    .nullable(),
});

const searchNode = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  // Older fixtures omit state; the assigned search requests open issues.
  state: z.string().default('OPEN'),
  updatedAt: z.string(),
  issueType: z.object({ name: z.string(), color: z.string().nullable() }).nullable(),
  repository: z.object({ nameWithOwner: z.string() }),
  assignees: z.object({
    nodes: z.array(z.object({ login: z.string(), avatarUrl: z.string().optional() })),
  }),
  // Older fixtures omit PR avatars; production queries request them.
  pullRequests: z
    .object({
      nodes: z.array(
        z.object({
          number: z.number(),
          url: z.string(),
          state: z.string(),
          updatedAt: z.string(),
          // Older fixtures omit these fields; production queries request both.
          isDraft: z.boolean().default(false),
          reviewDecision: z.string().nullable().default(null),
          author: z.object({ login: z.string(), avatarUrl: z.string() }).nullable(),
          commits: z
            .object({
              nodes: z.array(
                z.object({
                  commit: z.object({
                    oid: z.string(),
                    statusCheckRollup: z.object({ state: z.string() }).nullable().default(null),
                  }),
                }),
              ),
            })
            .optional(),
        }),
      ),
    })
    .optional(),
  projectItems: z.object({ nodes: z.array(projectItem) }),
});

export const searchResponse = z.object({
  data: z.object({
    cards: z.object({
      issueCount: z.number(),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      nodes: z.array(searchNode),
    }),
    assignedTotal: z.object({ issueCount: z.number() }),
  }),
});

/** Null represents an unreadable repository or missing issue, without an error (R4). */
export const issueResponse = z.object({
  data: z.object({
    repository: z.object({ issue: searchNode.nullable() }).nullable(),
  }),
});

export type SearchResponse = z.infer<typeof searchResponse>;
export type SearchNode = z.infer<typeof searchNode>;
