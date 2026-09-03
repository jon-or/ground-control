import { z } from 'zod';
import type { CardAvatar, CardPullRequest, IssueCard } from '@ground-control/core';

export type { CardAvatar, CardPullRequest, IssueCard };

/** How the board is allowed to narrow the search. `project` adds a `project:` qualifier; `issueSearch` does not. */
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
  /** Issues the board's own query matched. The denominator for truncation — `totalAssigned` is a wider set. */
  matched: number;
  /** Issues assigned to these logins regardless of the project filter. */
  totalAssigned: number;
  /** Assigned issues the project filter excluded. R1 says only unassigned issues may be absent, so the board states this. */
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
  | 'query-failed'
  | 'bad-response';

export interface Failure {
  kind: FailureKind;
  message: string;
  remedy: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: Failure };

const projectItem = z.object({
  project: z.object({ number: z.number() }),
  fieldValueByName: z.object({ name: z.string(), color: z.string().nullable() }).nullable(),
});

const searchNode = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  updatedAt: z.string(),
  issueType: z.object({ name: z.string(), color: z.string().nullable() }).nullable(),
  repository: z.object({ nameWithOwner: z.string() }),
  assignees: z.object({
    nodes: z.array(z.object({ login: z.string(), avatarUrl: z.string().optional() })),
  }),
  // Optional keeps recordings made before avatars were selected readable. The production query always requests it.
  pullRequests: z
    .object({
      nodes: z.array(
        z.object({
          number: z.number(),
          url: z.string(),
          state: z.string(),
          updatedAt: z.string(),
          // Defaulted, not required: a recording made before these were selected must stay readable. The production query requests both.
          isDraft: z.boolean().default(false),
          reviewDecision: z.string().nullable().default(null),
          author: z.object({ login: z.string(), avatarUrl: z.string() }).nullable(),
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

export type SearchResponse = z.infer<typeof searchResponse>;
export type SearchNode = z.infer<typeof searchNode>;
