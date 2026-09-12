import { z } from 'zod';
import type { ReadFailure } from './types.js';

/** The team function that owns a board status. Both clients colour by function, so a bounce between two reads as alternating stripes. */
export const CUSTODY_FUNCTIONS = ['intake', 'dev', 'product', 'qa', 'release'] as const;
export type CustodyFunction = (typeof CUSTODY_FUNCTIONS)[number];

/** One board status in workflow order, the function that owns it, and the hold length that counts as a stall there. */
export interface CustodyStage {
  status: string;
  function: CustodyFunction;
  stallDays: number;
}

/**
 * Stages in workflow order, and the machine actors whose moves are automated. Any login ending in `[bot]` is a
 * machine whether or not it is listed. Statuses outside the list still render; they rank nowhere and never count
 * as a send-back.
 */
export interface CustodySettings {
  stages: CustodyStage[];
  bots: string[];
}

export const DEFAULT_CUSTODY: CustodySettings = {
  stages: [
    { status: '🆕 New', function: 'intake', stallDays: 5 },
    { status: '🔖 Planned', function: 'intake', stallDays: 5 },
    { status: '🎁 Assigned', function: 'dev', stallDays: 7 },
    { status: '⚒️ Dev', function: 'dev', stallDays: 7 },
    { status: '🔍 Dev Review', function: 'dev', stallDays: 7 },
    { status: '🎯 Product Review', function: 'product', stallDays: 3 },
    { status: '👟 Ready For Testing', function: 'qa', stallDays: 5 },
    { status: '🏃 Testing', function: 'qa', stallDays: 5 },
    { status: '🚀 Releasable', function: 'release', stallDays: 1 },
  ],
  bots: ['orez-codebot', 'ownerrez-gh-actions', 'github-actions', 'github-project-automation[bot]', 'claude[bot]'],
};

const stage = z.object({
  status: z.string().trim().min(1),
  function: z.enum(CUSTODY_FUNCTIONS),
  stallDays: z.number().finite().min(0).catch(7).default(7),
});

/** A malformed stage drops itself, not the list; a malformed list keeps the default. Duplicate statuses keep the first. */
export const custodySettings = z
  .object({
    stages: z
      .array(z.unknown())
      .catch(() => [...DEFAULT_CUSTODY.stages])
      .default(() => [...DEFAULT_CUSTODY.stages])
      .transform((raw) => {
        const stages: CustodyStage[] = [];

        for (const entry of raw) {
          const parsed = stage.safeParse(entry);

          if (parsed.success && !stages.some((known) => known.status === parsed.data.status)) {
            stages.push(parsed.data);
          }
        }

        return stages;
      }),
    bots: z
      .array(z.unknown())
      .catch(() => [...DEFAULT_CUSTODY.bots])
      .default(() => [...DEFAULT_CUSTODY.bots])
      .transform((raw) => raw.filter((login): login is string => typeof login === 'string' && login.trim() !== '').map((login) => login.trim())),
  })
  .catch(() => ({ stages: [...DEFAULT_CUSTODY.stages], bots: [...DEFAULT_CUSTODY.bots] }))
  .default(() => ({ stages: [...DEFAULT_CUSTODY.stages], bots: [...DEFAULT_CUSTODY.bots] }));

/** One status change, assignment, or unassignment on the issue timeline, with linked accounts already resolved. */
export interface CustodyEvent {
  at: string;
  actor: string | null;
  /** The source recorded the move as automation, whoever the actor is. */
  automated: boolean;
  /** `from` null before the first status; `to` null when the status was cleared. */
  status: { from: string | null; to: string | null } | null;
  assigned: string | null;
  unassigned: string | null;
}

/** An issue's whole custody history as the source reports it. The board package folds it into legs. */
export interface CustodyHistory {
  number: number;
  title: string;
  url: string;
  /** `OPEN` or `CLOSED`. */
  state: string;
  createdAt: string;
  closedAt: string | null;
  /** Who closed it last, or null while open or when the closer is unavailable. */
  closedBy: string | null;
  /** Oldest first. */
  events: CustodyEvent[];
  /** The read stopped before the newest events, so legs after the last one read are missing. */
  truncated: boolean;
}

/** Null history beside no failure is an issue the source served and found nothing for. */
export interface CustodyReading {
  history: CustodyHistory | null;
  failure: ReadFailure | null;
}

/** One leg of the custody bar. `title` is what hovering it says. */
export interface CustodySegment {
  label: string;
  function: CustodyFunction | null;
  held: boolean;
  /** Share of the issue's life, 0 to 1. */
  share: number;
  title: string;
}

export interface CustodyFigure {
  label: string;
  value: string;
  bad: boolean;
}

/** Whether the issue is stuck, and how badly. Names statuses and durations, never people. */
export interface CustodyHealth {
  headline: string;
  subline: string;
  bad: boolean;
  figures: CustodyFigure[];
  now: { label: string; function: CustodyFunction | null; holder: string; held: boolean; since: string };
}

/** One of the longest legs. `holder` null is nobody assigned. */
export interface CustodyTimeRow {
  label: string;
  function: CustodyFunction | null;
  holder: string | null;
  duration: string;
  bad: boolean;
  /** Share of the longest row, 0 to 1. */
  share: number;
}

/** Time in one status across every leg there. */
export interface CustodyTotalRow {
  label: string;
  function: CustodyFunction | null;
  duration: string;
  /** Share of the issue's life, 0 to 1. */
  share: number;
}

/**
 * One stretch of the route. A plain stop has one label; a loop stop has two and `rounds` returns to the first.
 * A folded stop stands for `folded` stops the card has no room for. `holders` is already worded.
 */
export interface CustodyStop {
  labels: string[];
  functions: (CustodyFunction | null)[];
  rounds: number;
  holders: string;
  duration: string;
  current: boolean;
  folded: number;
}

/** Everything the popup draws, worded by the board package so both clients show the same text. */
export interface Custody {
  number: number;
  title: string;
  url: string;
  closed: boolean;
  /** The left end of the bar: the creation date, with its year when the life spans two. */
  createdLabel: string;
  /** `closed` or `today`: what the right end of the bar is. */
  endLabel: string;
  age: string;
  truncated: boolean;
  bar: CustodySegment[];
  health: CustodyHealth;
  time: { longest: CustodyTimeRow[]; totals: CustodyTotalRow[] };
  route: CustodyStop[];
}
