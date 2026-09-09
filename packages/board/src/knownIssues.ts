import { z } from 'zod';
import type { IssueCard } from './types.js';

/** Cached issue lookup, including missing issues so invalid branch-derived numbers are not queried every poll. */
export type KnownIssue = { card: IssueCard; at: number } | { missing: true; at: number };

/** Every issue looked up by number, keyed `<repositoryKey>#<number>`. */
export interface KnownIssues {
  entries: Record<string, KnownIssue>;
}

export const EMPTY_KNOWN_ISSUES: KnownIssues = { entries: {} };

/** Retention after the last session reference, allowing later session reopening without unbounded cache growth. */
export const KNOWN_ISSUE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Lookup refresh interval for cached and missing issues. Continue displaying cached data during refresh. */
export const READING_STANDS_MS = 6 * 60 * 60 * 1000;

/** Whether the cached lookup is still fresh. */
export function knownIssueHolds(entry: KnownIssue | undefined, now: number): boolean {
  return entry !== undefined && now - entry.at < READING_STANDS_MS;
}

export function knownIssueKey(repository: string, number: number): string {
  return `${repository}#${number}`;
}

const avatar = z.object({ login: z.string(), url: z.string(), source: z.enum(['pull-request', 'issue']) });

const pullRequest = z.object({
  number: z.number(),
  url: z.string(),
  state: z.string(),
  author: z.string().nullable(),
  isDraft: z.boolean(),
  reviewDecision: z.string().nullable(),
  // Default missing legacy fields to null so cached cards remain parseable.
  updatedAt: z.string().nullable().default(null),
  headOid: z.string().nullable().default(null),
  checksRed: z.boolean().nullable().default(null),
});

/** Preserve optional fields when parsing cards written by older builds. */
const issueCard = z.object({
  number: z.number(),
  title: z.string(),
  repository: z.string().optional(),
  state: z.string().optional(),
  type: z.string().nullable(),
  typeColor: z.string().nullable(),
  url: z.string(),
  status: z.string().nullable(),
  statusColor: z.string().nullable(),
  statusChangedAt: z.string().nullable(),
  assignees: z.array(z.string()),
  avatar: avatar.nullable(),
  pullRequest: pullRequest.nullable(),
  updatedAt: z.string(),
});

/** Check the schema against IssueCard and omit absent optional keys for exactOptionalPropertyTypes. */
function pinned(parsed: z.infer<typeof issueCard>): IssueCard {
  const { repository, state, ...rest } = parsed;

  return {
    ...rest,
    ...(repository === undefined ? {} : { repository }),
    ...(state === undefined ? {} : { state }),
  };
}

const knownIssue = z.union([
  z.object({ card: issueCard.transform(pinned), at: z.number() }),
  z.object({ missing: z.literal(true), at: z.number() }),
]);

const knownIssues = z.object({ entries: z.record(z.string(), z.unknown()) });

/** Parse saved lookups, discarding invalid entries individually. */
export function readKnownIssues(stored: unknown): KnownIssues {
  const outer = knownIssues.safeParse(stored);

  if (!outer.success) {
    return { entries: {} };
  }

  const entries: Record<string, KnownIssue> = {};

  for (const [key, value] of Object.entries(outer.data.entries)) {
    const entry = knownIssue.safeParse(value);

    if (entry.success) {
      entries[key] = entry.data;
    }
  }

  return { entries };
}

/** Keep referenced or recently used lookups to bound cache growth. */
export function pruneKnownIssues(state: KnownIssues, referenced: ReadonlySet<string>, now: number): KnownIssues {
  const entries: Record<string, KnownIssue> = {};

  for (const [key, entry] of Object.entries(state.entries)) {
    if (referenced.has(key) || now - entry.at < KNOWN_ISSUE_TTL_MS) {
      entries[key] = entry;
    }
  }

  return { entries };
}

/** Compare card values independent of key order, which differs between source reads and schema parsing. */
export function sameKnownCard(stored: KnownIssue | undefined, card: IssueCard): boolean {
  return stored !== undefined && 'card' in stored && canonical(stored.card) === canonical(card);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, held]) => held !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, held]) => `${JSON.stringify(key)}:${canonical(held)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

/** Record an issue lookup, including a missing result. */
export function withKnownIssue(state: KnownIssues, key: string, card: IssueCard | null, now: number): KnownIssues {
  return { entries: { ...state.entries, [key]: card === null ? { missing: true, at: now } : { card, at: now } } };
}
