import type { TriageComment, TriageStateEvent } from '@ground-control/core';

/**
 * Group consecutive status and assignment events from one actor within this interval. GitHub records each mutation
 * separately.
 */
const STATE_CHANGE_GAP_MS = 60_000;

/** Consecutive state changes by one actor, each within a minute of the previous event. */
export interface TriageStateChange {
  /** First event timestamp; comments during the group belong to this instruction. */
  at: string;
  actor: string | null;
  actorName: string | null;
  /** Status transition, or null for assignment-only changes. */
  from: string | null;
  to: string | null;
  assigned: string[];
  unassigned: string[];
}

/** Latest state instruction and actor. Comments before `at` are background. */
export interface TriageInstruction {
  at: string;
  actor: string | null;
  actorName: string | null;
  /** Previous status from the latest group that changed status, which may precede the latest assignment. */
  from: string | null;
  /** Whether the latest change assigned the card to the developer. */
  handedOver: boolean;
}

function isDeveloperLogin(login: string | null, logins: readonly string[]): boolean {
  return login !== null && logins.some((developerLogin) => developerLogin.toLowerCase() === login.toLowerCase());
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

  // Measure each gap from the preceding event, not the start of the group.
  let previousEventAt = 0;

  for (const { event, at } of ordered) {
    if (event.status !== null && event.status.from === '') {
      continue;
    }

    const last = changes[changes.length - 1];
    const sameChangeGroup = last !== undefined && last.actor !== null && last.actor === event.actor && at - previousEventAt <= STATE_CHANGE_GAP_MS;

    previousEventAt = at;

    if (!sameChangeGroup) {
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

    // Keep the first timestamp so comments between grouped events remain part of this instruction.
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

  const statusChange = [...changes].reverse().find((change) => change.to !== null);

  return {
    at: last.at,
    actor: last.actor,
    actorName: last.actorName,
    from: statusChange?.from ?? null,
    handedOver: last.assigned.some((login) => isDeveloperLogin(login, logins)),
  };
}

/** Keep comments at or after the latest instruction, including same-second comments. Earlier comments are background. */
export function liveComments(
  comments: readonly TriageComment[],
  instruction: TriageInstruction | null,
): TriageComment[] {
  if (instruction === null) {
    return [...comments];
  }

  const at = Date.parse(instruction.at);

  // Keep comments with invalid dates rather than silently excluding them (R24).
  return Number.isNaN(at)
    ? [...comments]
    : comments.filter((comment) => {
        const commentAt = Date.parse(comment.createdAt);

        return Number.isNaN(commentAt) || commentAt >= at;
      });
}
