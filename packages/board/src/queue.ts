import { z } from 'zod';
import { AUTOMATABLE_ACTIONS, CREATE_WORKTREE, QUEUE_SECTIONS } from '@ground-control/core';
import type { ActionHistoryEntry, DispatchedAction, DoneVisit, Lane, LanedCard, QueueSection, QueueSectionId, QueueView, QueuedCard } from '@ground-control/core';
import { queueTime } from './lanes.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Attended ended visits Done keeps at most, newest first; an unattended one stays until acknowledged. */
export const ENDED_VISIT_LIMIT = 200;

/** A run a visit started, by its history id, so the visit keeps its name after the action history drops it. */
export interface VisitRun {
  id: string;
  action: DispatchedAction;
}

/** A visit still on the board: when it began, where the card is now, and whether it ever waited on the developer. */
export interface OpenVisit {
  startedAt: number;
  section: QueueSectionId;
  /** Epoch milliseconds the card entered `section`. */
  since: number;
  /** The card entered Waiting for you during the visit. */
  waited: boolean;
  issueNumber: number;
  title: string;
  url: string;
  repository: string | null;
  status: string | null;
  /** Oldest first. */
  runs: VisitRun[];
}

export interface EndedVisit {
  id: string;
  key: string;
  issueNumber: number;
  title: string;
  url: string;
  repository: string | null;
  startedAt: number;
  endedAt: number;
  waited: boolean;
  left: string;
  runs: VisitRun[];
}

/** Visits by card key while the card is on the board, and the ended ones Done lists, newest first (R53). */
export interface VisitMemory {
  open: Record<string, OpenVisit>;
  ended: EndedVisit[];
}

export const EMPTY_VISITS: VisitMemory = { open: {}, ended: [] };

const section = z.enum(QUEUE_SECTIONS);

const visitRun = z.object({ id: z.string(), action: z.enum([...AUTOMATABLE_ACTIONS, CREATE_WORKTREE]) });

/** Runs written by a build before they were kept read as none; an unreadable one drops alone. */
const visitRuns = z.array(z.unknown()).catch([]).default([]).transform((all) => all.flatMap((one) => {
  const read = visitRun.safeParse(one);

  return read.success ? [read.data] : [];
}));

const openVisit = z.object({
  startedAt: z.number(),
  section,
  since: z.number(),
  waited: z.boolean(),
  issueNumber: z.number(),
  title: z.string(),
  url: z.string(),
  repository: z.string().nullable(),
  status: z.string().nullable(),
  runs: visitRuns,
});

const endedVisit = z.object({
  id: z.string(),
  key: z.string(),
  issueNumber: z.number(),
  title: z.string(),
  url: z.string(),
  repository: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number(),
  waited: z.boolean(),
  left: z.string(),
  runs: visitRuns,
});

const visitMemory = z.object({
  open: z.record(z.string(), z.unknown()).catch({}).default({}),
  ended: z.array(z.unknown()).catch([]).default([]),
});

/** Validate stored visits, dropping unreadable entries one at a time. */
export function readVisits(stored: unknown): VisitMemory {
  const outer = visitMemory.safeParse(stored);

  if (!outer.success) {
    return { open: {}, ended: [] };
  }

  const open: Record<string, OpenVisit> = {};

  for (const [key, value] of Object.entries(outer.data.open)) {
    const read = openVisit.safeParse(value);

    if (read.success) open[key] = read.data;
  }

  const ended = outer.data.ended.flatMap((value) => {
    const read = endedVisit.safeParse(value);

    return read.success ? [read.data] : [];
  });

  return { open, ended };
}

/** A run's own outcome waits on the developer: one that finished, or one whose session asked a question (R53). */
function runWaits(card: LanedCard): boolean {
  return card.action?.state === 'done' || (card.action?.state === 'running' && card.action.stage === 'waiting');
}

/** Something is running on the card: a run, a worktree run, or a working session. */
function runs(card: LanedCard): boolean {
  return card.attention === 'running' || card.action?.state === 'running' || card.creation?.state === 'running' ||
    card.sessions.some((session) => !session.finished && session.activity?.phase === 'running');
}

/** Whether the queue view lists the card: an issue on the board. Ad-hoc and archived cards stay in the lane view. */
export function queued(card: LanedCard): boolean {
  return card.issue !== null && card.issueNumber !== null && card.lane !== 'archived';
}

/**
 * The section that holds the card now, or null where the queue view does not list it (R53). Anything waiting on the
 * developer places it in Waiting for you whatever else runs; Icebox suppresses every waiting reason but Needs you (R6).
 */
export function queueSectionOf(card: LanedCard): QueueSectionId | null {
  if (!queued(card)) {
    return null;
  }

  if (card.lane === 'icebox') {
    return card.attention === 'blocked' ? 'waiting' : 'icebox';
  }

  if (card.attention === 'failed' || card.attention === 'blocked' || card.attention === 'your-turn' || runWaits(card) ||
    card.stage?.stage === 'review') {
    return 'waiting';
  }

  return runs(card) ? 'working' : 'unstarted';
}

/** When the card's state says it entered `id`, where it says; the reading time otherwise. Never in the future. */
function enteredAt(card: LanedCard, id: QueueSectionId, now: number): number {
  const action = card.action;
  const evidence = id === 'working' && action?.state === 'running'
    ? action.since
    : id === 'working' && card.creation?.state === 'running'
      ? card.creation.since
      : id === 'waiting' && action?.state === 'done'
      ? action.at
        : id === 'waiting' && card.stage?.stage === 'review'
          ? card.stage.since
          : now;

  return Math.min(evidence, now);
}

/** How the card left the board, in the words Done shows. */
function leftOf(card: LanedCard | undefined, visit: OpenVisit): string {
  if (card === undefined) {
    return visit.status === null ? 'Left your board' : `${visit.status} · left your board`;
  }

  if (card.issue?.state === 'CLOSED') {
    return 'Closed';
  }

  if (card.unassigned) {
    return card.issue?.status ? `${card.issue.status} · unassigned` : 'Unassigned';
  }

  return card.issue?.status ?? 'No status';
}

function ended(key: string, visit: OpenVisit, card: LanedCard | undefined, now: number): EndedVisit {
  return {
    id: `${key}@${visit.startedAt}`,
    key,
    issueNumber: visit.issueNumber,
    title: visit.title,
    url: visit.url,
    repository: visit.repository,
    startedAt: visit.startedAt,
    endedAt: now,
    waited: visit.waited,
    left: leftOf(card, visit),
    runs: visit.runs,
  };
}

/** The visit's runs with any the history adds since it started, oldest first. */
function withRuns(known: readonly VisitRun[], key: string, startedAt: number, history: readonly ActionHistoryEntry[]): VisitRun[] {
  const ids = new Set(known.map((run) => run.id));
  const added = history
    .filter((run) => run.key === key && run.startedAt >= startedAt && !ids.has(run.id))
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((run) => ({ id: run.id, action: run.action }));

  return added.length === 0 ? [...known] : [...known, ...added];
}

/**
 * Start a visit for each card that arrived, follow each open one into its current section, record the runs it
 * starts, and end the ones whose card was archived or, where `complete` says every source read in full, is gone.
 * Done keeps an unattended visit until it is acknowledged and any other for `doneDays` (R53).
 */
export function nextVisits(
  lanes: readonly Lane[],
  memory: VisitMemory,
  complete: boolean,
  now: number,
  doneDays: number,
  history: readonly ActionHistoryEntry[],
): VisitMemory {
  const cards = new Map(lanes.flatMap((lane) => lane.cards).map((card) => [card.key, card]));
  const open: Record<string, OpenVisit> = {};
  const done: EndedVisit[] = [];

  for (const [key, card] of cards) {
    const id = queueSectionOf(card);

    if (id === null || card.issue === null || card.issueNumber === null) {
      continue;
    }

    const prior = memory.open[key];
    const startedAt = prior?.startedAt ?? now;
    // A move this hub saw happens at the read; a new visit's section dates from the card's own evidence, since the
    // card may have entered it while no hub was running.
    const since = prior === undefined ? enteredAt(card, id, now) : prior.section === id ? prior.since : now;

    open[key] = {
      startedAt,
      section: id,
      since,
      waited: (prior?.waited ?? false) || id === 'waiting',
      issueNumber: card.issueNumber,
      title: card.issue.title,
      url: card.issue.url,
      repository: card.issue.repository ?? null,
      status: card.issue.status,
      runs: withRuns(prior?.runs ?? [], key, startedAt, history),
    };
  }

  for (const [key, visit] of Object.entries(memory.open)) {
    if (open[key] !== undefined) continue;

    const card = cards.get(key);

    // A card missing from the read, or archived as unassigned because a session names it, may only be missing from
    // an incomplete read; a card the read returned in a status outside the membership set has left.
    const left = card === undefined || card.unassigned === true ? complete : card.lane === 'archived';

    if (left) {
      done.push(ended(key, { ...visit, runs: withRuns(visit.runs, key, visit.startedAt, history) }, card, now));
    } else {
      open[key] = visit;
    }
  }

  let attended = 0;
  const kept = [...done, ...memory.ended].filter((visit) =>
    !visit.waited || (now - visit.endedAt < doneDays * DAY_MS && ++attended <= ENDED_VISIT_LIMIT));

  return { open, ended: kept };
}

/** Take an ended visit out of Done. */
export function withAcknowledged(memory: VisitMemory, id: string): VisitMemory {
  return memory.ended.some((visit) => visit.id === id) ? { ...memory, ended: memory.ended.filter((visit) => visit.id !== id) } : memory;
}

/** Earliest first; a card with no time last. `Array.prototype.sort` is stable, so ties keep their order. */
function byTime(cards: QueuedCard[]): QueuedCard[] {
  return [...cards].sort((a, b) => (a.since === null ? (b.since === null ? 0 : 1) : b.since === null ? -1 : a.since - b.since));
}

/**
 * The queue view (R53): each listed card in its section, Waiting for you and Working longest first by time in the
 * section, Unstarted and Icebox by queue time; then the ended visits with the runs each started.
 */
export function queueView(lanes: readonly Lane[], memory: VisitMemory, now: number): QueueView {
  const placed = new Map<QueueSectionId, QueuedCard[]>(QUEUE_SECTIONS.map((id) => [id, []]));

  for (const card of lanes.flatMap((lane) => lane.cards)) {
    const id = queueSectionOf(card);

    if (id === null) continue;

    const visit = memory.open[card.key];
    const since = id === 'unstarted' || id === 'icebox'
      ? queueTime(card)
      : visit?.section === id ? visit.since : enteredAt(card, id, now);

    // A waiting card's reason says when work still runs on it.
    placed.get(id)!.push({ key: card.key, since, running: id === 'waiting' && runs(card) });
  }

  const sections: QueueSection[] = QUEUE_SECTIONS.map((id) => ({ id, cards: byTime(placed.get(id)!) }));
  const done: DoneVisit[] = memory.ended.map((visit) => ({
    id: visit.id,
    issueNumber: visit.issueNumber,
    title: visit.title,
    url: visit.url,
    repository: visit.repository,
    startedAt: visit.startedAt,
    endedAt: visit.endedAt,
    unattended: !visit.waited,
    actions: visit.runs.map((run) => run.action),
    left: visit.left,
  }));

  return { sections, done };
}
