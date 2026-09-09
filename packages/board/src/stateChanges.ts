import type { TriageComment, TriageStateEvent } from '@ground-control/core';

/**
 * How far apart two events may be and still be one act. A hand-over is three or four separate mutations — the status
 * moved, the last person taken off, the next one put on — and GitHub timestamps each as it lands, seconds apart.
 * Read singly they are three instructions, the last of which is usually the least informative one.
 */
const SAME_ACT_MS = 60_000;

/** One act on a card's state: the run of things one person did to it, each within a minute of the last. */
export interface TriageStateChange {
  /** When the act began. What was said during it belongs to it, not to whatever it answered. */
  at: string;
  actor: string | null;
  actorName: string | null;
  /** Where the status went, or null where the act only moved people. */
  from: string | null;
  to: string | null;
  assigned: string[];
  unassigned: string[];
}

/** What the card was last told to be, and by whom. Every comment older than `at` is background to it. */
export interface TriageInstruction {
  at: string;
  actor: string | null;
  actorName: string | null;
  /** The status the most recent act that moved it came out of, which is not always the most recent act. */
  from: string | null;
  /** Whether the act that reached this state also put the card in the developer's hands. */
  handedOver: boolean;
}

function own(login: string | null, logins: readonly string[]): boolean {
  return login !== null && logins.some((mine) => mine.toLowerCase() === login.toLowerCase());
}

/**
 * Sort valid events by time and group adjacent events by the same identified actor when each gap is at most
 * one minute. Do not group unknown actors. Ignore project-addition status events with an empty previous status
 * (mechanics M32). Grouping uses adjacent gaps, not total duration.
 */
export function collapseStateChanges(events: readonly TriageStateEvent[]): TriageStateChange[] {
  const changes: TriageStateChange[] = [];
  const ordered = events
    .filter((event) => !Number.isNaN(Date.parse(event.at)))
    .map((event) => ({ event, at: Date.parse(event.at) }))
    .sort((a, b) => a.at - b.at);

  // The end of the act so far, which is what the gap is measured from — an act runs as long as somebody keeps at it.
  let previous = 0;

  for (const { event, at } of ordered) {
    if (event.status !== null && event.status.from === '') {
      continue;
    }

    const last = changes[changes.length - 1];
    const together = last !== undefined && last.actor !== null && last.actor === event.actor && at - previous <= SAME_ACT_MS;

    previous = at;

    if (!together) {
      changes.push({
        at: event.at,
        actor: event.actor,
        actorName: event.actorName,
        from: event.status?.from ?? null,
        to: event.status?.to ?? null,
        assigned: event.assigned === null ? [] : [event.assigned],
        unassigned: event.unassigned === null ? [] : [event.unassigned],
      });

      continue;
    }

    // A later event in the same act carries it forward, but never restamps it: the act began when its first write
    // landed, and a comment written between the writes belongs to the hand-over rather than to what it answered.
    if (event.status !== null) {
      last.from = last.from ?? event.status.from;
      last.to = event.status.to;
    }

    if (event.assigned !== null) {
      last.assigned.push(event.assigned);
    }

    if (event.unassigned !== null) {
      last.unassigned.push(event.unassigned);
    }
  }

  return changes;
}

/**
 * Use the card's current status rather than reconstructing it from timeline option names. Take the previous
 * status from the latest status-changing group, which may precede a separate assignment event.
 */
export function foldInstruction(
  changes: readonly TriageStateChange[],
  logins: readonly string[],
): TriageInstruction | null {
  const last = changes[changes.length - 1];

  if (last === undefined) {
    return null;
  }

  const moved = [...changes].reverse().find((change) => change.to !== null);

  return {
    at: last.at,
    actor: last.actor,
    actorName: last.actorName,
    from: moved?.from ?? null,
    handedOver: last.assigned.some((login) => own(login, logins)),
  };
}

/**
 * The comments the instruction has not already answered. What was said before it has been — a question closed by a
 * rewritten issue body and a move to the next status leaves no reply on the thread, and reading the card off that
 * question is the failure this whole split exists to stop. A comment sharing the instruction's second counts as
 * still open: hiding something somebody said is the worse miss of the two.
 */
export function liveComments(
  comments: readonly TriageComment[],
  instruction: TriageInstruction | null,
): TriageComment[] {
  if (instruction === null) {
    return [...comments];
  }

  const at = Date.parse(instruction.at);

  // Neither side is trusted to be a date. A comparison against a NaN is false both ways, which would drop a comment
  // out of the reading altogether — so anything undatable stays open, because suppressing what somebody said is the
  // failure that matters here (R24).
  return Number.isNaN(at)
    ? [...comments]
    : comments.filter((comment) => {
        const said = Date.parse(comment.createdAt);

        return Number.isNaN(said) || said >= at;
      });
}
