import { z } from 'zod';
import type { IssueCard } from './types.js';

/**
 * What the board has read about an issue nobody assigned it. Either the issue itself, or a mark that the source
 * answered with nothing — a branch-derived number that names no issue must not be asked for again every poll.
 */
export type KnownIssue = { card: IssueCard; at: number } | { missing: true; at: number };

/** Every issue looked up by number, keyed `<repositoryKey>#<number>`. */
export interface KnownIssues {
  entries: Record<string, KnownIssue>;
}

export const EMPTY_KNOWN_ISSUES: KnownIssues = { entries: {} };

/**
 * How long an entry outlives the last thing that referenced it. Long enough that finishing an issue, unassigning it
 * and coming back to the session a fortnight later still names the card; short enough that the file stays small.
 */
export const KNOWN_ISSUE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long any reading stands before the board takes it again. Two cases, one window: a number that named nothing
 * when the branch was cut may have an issue filed against it since, and a card nothing has refreshed since the
 * developer was unassigned goes on naming a status the issue has long left. The stale one still answers meanwhile,
 * so nothing on screen blanks while it is re-read.
 */
export const READING_STANDS_MS = 6 * 60 * 60 * 1000;

/** Whether a reading still stands, or has aged into one worth taking again. */
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
});

/**
 * The card as it is stored. Every optional field is optional here too: this file is written by one build and read by
 * the next, and a card that lost its status because a field was added is worse than a card the board reads again.
 */
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

/**
 * Pins the schema to `IssueCard`, so a field added to the type and not to the schema fails the build rather than
 * reading back `undefined` on every cache hit. It also drops the optional keys zod parsed as absent, which under
 * `exactOptionalPropertyTypes` is the difference between a card without a repository and one whose repository is
 * the value `undefined`.
 */
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

/**
 * The stored lookups, or none. Durable state a developer can hand-edit and an older build can have written in
 * another shape, so one unreadable entry costs that issue a fresh read rather than costing every other one.
 */
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

/**
 * The lookups worth keeping: everything a session still names, plus everything read recently enough to save the next
 * one a round trip. Without this the file grows an entry for every issue the developer is ever assigned.
 */
export function pruneKnownIssues(state: KnownIssues, referenced: ReadonlySet<string>, now: number): KnownIssues {
  const entries: Record<string, KnownIssue> = {};

  for (const [key, entry] of Object.entries(state.entries)) {
    if (referenced.has(key) || now - entry.at < KNOWN_ISSUE_TTL_MS) {
      entries[key] = entry;
    }
  }

  return { entries };
}

/**
 * Whether a card read now says what the stored one said. Key order is not a difference: a card comes back through
 * `readKnownIssues` in schema order and out of a source in its own, so a plain stringify never matches.
 */
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

/** The state with one issue's reading recorded, whether the source found it or answered with nothing. */
export function withKnownIssue(state: KnownIssues, key: string, card: IssueCard | null, now: number): KnownIssues {
  return { entries: { ...state.entries, [key]: card === null ? { missing: true, at: now } : { card, at: now } } };
}
