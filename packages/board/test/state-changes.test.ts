import { describe, expect, it } from 'vitest';
import type { TriageComment, TriageStateEvent } from '@ground-control/core';
import { collapseStateChanges, foldInstruction, liveComments } from '../src/stateChanges.js';

const ME = ['dev-1'];

function moved(at: string, actor: string, from: string, to: string): TriageStateEvent {
  return { at, actor, actorName: null, status: { from, to }, assigned: null, unassigned: null };
}

function assigned(at: string, actor: string, login: string): TriageStateEvent {
  return { at, actor, actorName: null, status: null, assigned: login, unassigned: null };
}

function unassigned(at: string, actor: string, login: string): TriageStateEvent {
  return { at, actor, actorName: null, status: null, assigned: null, unassigned: login };
}

function said(at: string, author = 'dev-3'): TriageComment {
  return { author, authorName: null, authorAssociation: 'MEMBER', body: 'x', createdAt: at };
}

/**
 * Recorded status and assignment sequence from ownerrez/orez #19192 (mechanics M32): unassignment after eight
 * seconds, reassignment by another actor 2.5 hours later. All comments predate it.
 */
const HANDOVER: TriageStateEvent[] = [
  moved('2026-08-24T20:41:34Z', 'dev-4', '', '🆕 New'),
  moved('2026-09-02T22:32:32Z', 'dev-3', '🎁 Assigned', '⚒️ Dev'),
  moved('2026-09-04T13:53:36Z', 'dev-3', '⚒️ Dev', '🔍 Dev Review'),
  unassigned('2026-09-04T13:53:44Z', 'dev-3', 'dev-3'),
  assigned('2026-09-04T16:28:42Z', 'dev-5', 'dev-1'),
];

describe('collapsing what happened to a card', () => {
  it('reads one act spread over several mutations as one act', () => {
    // Group adjacent mutations so the latest assignment retains its related status change.
    const changes = collapseStateChanges([
      assigned('2026-09-04T17:46:29Z', 'dev-5', 'dev-1'),
      unassigned('2026-09-04T17:46:32Z', 'dev-5', 'dev-6'),
      moved('2026-09-04T17:46:35Z', 'dev-5', '⚒️ Dev', '🔍 Dev Review'),
    ]);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      // Stamped when the act began, not when it finished: a comment written between the writes is part of it.
      at: '2026-09-04T17:46:29Z',
      actor: 'dev-5',
      from: '⚒️ Dev',
      to: '🔍 Dev Review',
      assigned: ['dev-1'],
      unassigned: ['dev-6'],
    });
  });

  it('keeps different actors in separate state changes', () => {
    const changes = collapseStateChanges([
      moved('2026-09-04T13:53:36Z', 'dev-3', '⚒️ Dev', '🔍 Dev Review'),
      assigned('2026-09-04T13:53:44Z', 'dev-5', 'dev-1'),
    ]);

    expect(changes).toHaveLength(2);
    expect(changes[1]).toMatchObject({ actor: 'dev-5', to: null, assigned: ['dev-1'] });
  });

  it('keeps the same person apart once the minute is up', () => {
    const changes = collapseStateChanges([
      moved('2026-09-04T13:00:00Z', 'dev-3', '⚒️ Dev', '🔍 Dev Review'),
      assigned('2026-09-04T13:01:01Z', 'dev-3', 'dev-1'),
    ]);

    expect(changes).toHaveLength(2);
  });

  it('never chains one unnamed actor to another, since nobody is not somebody', () => {
    // Unknown actors may be different people; do not group their events (R24).
    const nobody = (at: string, status: { from: string; to: string } | null, login: string | null) => ({
      at,
      actor: null,
      actorName: null,
      status,
      assigned: login,
      unassigned: null,
    });
    const changes = collapseStateChanges([
      nobody('2026-09-04T13:00:00Z', { from: '⚒️ Dev', to: '🔍 Dev Review' }, null),
      nobody('2026-09-04T13:00:04Z', null, 'dev-1'),
    ]);

    expect(changes).toHaveLength(2);
  });

  it('reads the events in time order, whatever order they arrived in', () => {
    // Sort events explicitly; response order is not guaranteed.
    const changes = collapseStateChanges([
      assigned('2026-09-04T12:00:00Z', 'dev-5', 'dev-1'),
      moved('2026-09-04T09:00:00Z', 'dev-3', '🎁 Assigned', '⚒️ Dev'),
    ]);

    expect(changes.map((c) => c.at)).toEqual(['2026-09-04T09:00:00Z', '2026-09-04T12:00:00Z']);
    expect(foldInstruction(changes, ME)?.at).toBe('2026-09-04T12:00:00Z');
  });

  it('drops an event GitHub gave no usable time, since nothing can be placed against it', () => {
    expect(collapseStateChanges([assigned('not a date', 'dev-5', 'dev-1')])).toEqual([]);
  });

  it('drops the card being added to the project, which is nobody moving it', () => {
    // Detect project addition by empty previous status, independent of the configurable automation login.
    const changes = collapseStateChanges([moved('2026-08-24T20:41:34Z', 'dev-4', '', '🆕 New')]);

    expect(changes).toEqual([]);
  });

  it('takes the second of two moves one person made in the same minute', () => {
    const changes = collapseStateChanges([
      moved('2026-09-04T13:53:36Z', 'dev-3', '⚒️ Dev', '👟 Ready For Testing'),
      moved('2026-09-04T13:53:44Z', 'dev-3', '👟 Ready For Testing', '🔍 Dev Review'),
    ]);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: '⚒️ Dev', to: '🔍 Dev Review' });
  });
});

describe('what the card was last told to be', () => {
  it('carries the status move even where a later act only moved people', () => {
    // Retain the preceding status transition when the latest event is a separate assignment.
    const instruction = foldInstruction(collapseStateChanges(HANDOVER), ME);

    expect(instruction).toEqual({
      at: '2026-09-04T16:28:42Z',
      actor: 'dev-5',
      actorName: null,
      from: '⚒️ Dev',
      handedOver: true,
    });
  });

  it('says nothing was handed over where the last act put somebody else on it', () => {
    const changes = collapseStateChanges([
      moved('2026-09-04T13:53:36Z', 'dev-1', '🔍 Dev Review', '⚒️ Dev'),
      assigned('2026-09-04T13:53:40Z', 'dev-1', 'dev-3'),
    ]);

    expect(foldInstruction(changes, ME)?.handedOver).toBe(false);
  });

  it('matches the developer login however it is cased, the way every other rule here does', () => {
    expect(foldInstruction(collapseStateChanges([assigned('2026-09-04T16:00:00Z', 'dev-5', 'DEV-1')]), ME)?.handedOver).toBe(true);
  });

  it('has nothing to say about a card nothing has happened to', () => {
    expect(foldInstruction([], ME)).toBeNull();
    expect(foldInstruction(collapseStateChanges([moved('2026-08-24T20:41:34Z', 'dev-4', '', '🆕 New')]), ME)).toBeNull();
  });
});

describe('which comments are still open', () => {
  it('puts everything said before the hand-over behind it', () => {
    // A later state instruction supersedes earlier questions even without a thread reply.
    const instruction = foldInstruction(collapseStateChanges(HANDOVER), ME);

    expect(liveComments([said('2026-09-03T14:43:28Z'), said('2026-09-03T15:27:10Z'), said('2026-09-04T13:38:50Z')], instruction)).toEqual([]);
  });

  it('keeps what was said after it live, since that is what the instruction has not answered', () => {
    const instruction = foldInstruction(collapseStateChanges(HANDOVER), ME);
    const live = liveComments([said('2026-09-03T14:43:28Z'), said('2026-09-04T17:00:00Z')], instruction);

    expect(live.map((c) => c.createdAt)).toEqual(['2026-09-04T17:00:00Z']);
  });

  it('keeps a comment written during the hand-over live, since it is part of the instruction', () => {
    // Comments between grouped events belong to the instruction, so use its first timestamp.
    const changes = collapseStateChanges([
      assigned('2026-09-04T17:46:29Z', 'dev-5', 'dev-1'),
      moved('2026-09-04T17:46:35Z', 'dev-5', '⚒️ Dev', '🔍 Dev Review'),
    ]);

    expect(liveComments([said('2026-09-04T17:46:30Z')], foldInstruction(changes, ME))).toHaveLength(1);
  });

  it('keeps a comment it cannot date, rather than dropping it out of the reading', () => {
    const instruction = foldInstruction(collapseStateChanges(HANDOVER), ME);

    expect(liveComments([said('not a date')], instruction)).toHaveLength(1);
  });

  it('counts a comment sharing the instruction second as still open, never as answered by it', () => {
    const instruction = foldInstruction(collapseStateChanges(HANDOVER), ME);

    expect(liveComments([said('2026-09-04T16:28:42Z')], instruction)).toHaveLength(1);
  });

  it('leaves every comment live where nothing has instructed the card', () => {
    const comments = [said('2026-09-03T14:43:28Z')];

    expect(liveComments(comments, null)).toEqual(comments);
  });
});
