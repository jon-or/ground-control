import { describe, expect, it } from 'vitest';
import { mergeBoard } from '../src/index.js';
import { dirKey } from '@ground-control/sessions';
import type { Session } from '../src/types.js';
import { issues, linkedOffBoard, linkedOnBoard, onBoard, sessions, unlinked, unlinkedCwds } from './helpers.js';

const board = mergeBoard(issues, sessions);

describe('the recording these tests rest on', () => {
  it('covers all three ways a session reaches the board', () => {
    expect(linkedOnBoard.length).toBeGreaterThan(0);
    expect(linkedOffBoard.length).toBeGreaterThan(0);
    expect(unlinked.length).toBeGreaterThan(0);
  });

  it('covers two directories of issue-less work, one of them holding several sessions', () => {
    expect(unlinkedCwds.size).toBeGreaterThan(1);
    expect(unlinked.length).toBeGreaterThan(unlinkedCwds.size);
  });

  it('covers an issue card holding more than one session', () => {
    const counts = new Map<number, number>();

    for (const session of linkedOnBoard) {
      counts.set(session.issueNumber!, (counts.get(session.issueNumber!) ?? 0) + 1);
    }

    expect([...counts.values()].filter((n) => n > 1).length).toBeGreaterThan(0);
  });

  it('covers an issue with no session at all', () => {
    const withSessions = new Set(linkedOnBoard.map((s) => s.issueNumber));

    expect(issues.filter((issue) => !withSessions.has(issue.number)).length).toBeGreaterThan(0);
  });
});

describe('mergeBoard', () => {
  it('puts every session on exactly one card — R2 allows none to be invisible', () => {
    const placed = board.flatMap((card) => card.sessions.map((s) => s.sessionId));

    expect(placed).toHaveLength(sessions.length);
    expect(new Set(placed).size).toBe(sessions.length);
    expect(new Set(placed)).toEqual(new Set(sessions.map((s) => s.sessionId)));
  });

  it('gives every issue a card, in the order they were read', () => {
    expect(board.slice(0, issues.length).map((card) => card.issue?.number)).toEqual(issues.map((i) => i.number));
  });

  it('gives every card a unique key', () => {
    expect(new Set(board.map((card) => card.key)).size).toBe(board.length);
  });

  it('nests a session under its issue card', () => {
    const session = linkedOnBoard[0]!;
    const card = board.find((c) => c.issue?.number === session.issueNumber);

    expect(card?.sessions.map((s) => s.sessionId)).toContain(session.sessionId);
  });

  it('holds several sessions on one issue card, newest started first', () => {
    const busiest = board
      .filter((card) => card.sessions.length > 1)
      .sort((a, b) => b.sessions.length - a.sessions.length)[0];

    expect(busiest).toBeDefined();
    expect(busiest!.sessions.map((s) => s.startedAt)).toEqual(
      [...busiest!.sessions.map((s) => s.startedAt)].sort((a, b) => b - a),
    );
  });

  it('leaves an issue with no session an empty card rather than dropping it', () => {
    const withSessions = new Set(linkedOnBoard.map((s) => s.issueNumber));
    const bare = issues.find((issue) => !withSessions.has(issue.number))!;

    expect(board.find((card) => card.issue?.number === bare.number)?.sessions).toEqual([]);
  });

  it('names the issue on a card for a session whose issue is not the developer own', () => {
    const off = linkedOffBoard[0]!;
    const card = board.find((c) => c.issueNumber === off.issueNumber);

    expect(card?.issue).toBeNull();
    expect(card?.issueNumber).toBe(off.issueNumber);
    expect(card?.sessions.map((s) => s.sessionId)).toContain(off.sessionId);
    expect(onBoard.has(off.issueNumber!)).toBe(false);
  });

  it('gives each directory of issue-less work one card, holding every session running there', () => {
    const cards = board.filter((c) => c.issueNumber === null);

    expect(cards).toHaveLength(unlinkedCwds.size);

    for (const card of cards) {
      const running = unlinked.filter((s) => dirKey(s.cwd) === dirKey(card.sessions[0]!.cwd));

      expect(card.issue).toBeNull();
      expect(card.key).toBe(`session:${dirKey(card.sessions[0]!.cwd)}`);
      expect(card.sessions).toHaveLength(running.length);
      expect(card.sessions.map((s) => s.startedAt)).toEqual([...running.map((s) => s.startedAt)].sort((a, b) => b - a));
    }
  });

  it('orders the board as issues, then issues the developer does not own, then sessions alone', () => {
    const offBoardNumbers = new Set(linkedOffBoard.map((s) => s.issueNumber));

    expect(board).toHaveLength(issues.length + offBoardNumbers.size + unlinkedCwds.size);
    expect(board.slice(issues.length, issues.length + offBoardNumbers.size).every((c) => c.issueNumber !== null)).toBe(
      true,
    );
    expect(board.slice(issues.length + offBoardNumbers.size).every((c) => c.issueNumber === null)).toBe(true);
  });

  it('is an empty board when the machine is idle and nothing is assigned', () => {
    expect(mergeBoard([], [])).toEqual([]);
  });

  it('shows only issues when no session is running', () => {
    expect(mergeBoard(issues, []).every((card) => card.sessions.length === 0)).toBe(true);
  });

  it('shows only sessions when nothing is assigned', () => {
    const cards = mergeBoard([], sessions);

    expect(cards.flatMap((c) => c.sessions)).toHaveLength(sessions.length);
    expect(cards.every((card) => card.issue === null)).toBe(true);
  });

  it('groups two sessions that name the same absent issue onto one card', () => {
    const off = linkedOffBoard[0]!;
    const twin: Session = { ...off, sessionId: `${off.sessionId}-twin`, startedAt: off.startedAt + 1000 };
    const cards = mergeBoard([], [off, twin]);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.sessions.map((s) => s.sessionId)).toEqual([twin.sessionId, off.sessionId]);
  });

  it('puts two agents in one directory on one card — the directory is the work, not the CLI', () => {
    const mine = unlinked[0]!;
    const twin: Session = { ...mine, agent: 'other-cli', startedAt: mine.startedAt + 1000 };
    const cards = mergeBoard([], [mine, twin]);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.sessions.map((s) => s.agent)).toEqual(['other-cli', mine.agent]);
  });

  it('groups a directory reported with a trailing separator, a backslash, or another case as one', () => {
    const mine = unlinked[0]!;
    const variants: Session[] = [
      mine,
      { ...mine, sessionId: 'trailing', cwd: `${mine.cwd}/` },
      { ...mine, sessionId: 'backslash', cwd: mine.cwd.split('/').join('\\') },
      { ...mine, sessionId: 'upper', cwd: mine.cwd.toUpperCase() },
    ];
    const cards = mergeBoard([], variants);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.sessions).toHaveLength(4);
  });

  it('keeps two directories apart', () => {
    const mine = unlinked[0]!;
    const elsewhere: Session = { ...mine, sessionId: 'elsewhere', cwd: `${mine.cwd}-other` };
    const cards = mergeBoard([], [mine, elsewhere]);

    expect(cards).toHaveLength(2);
  });
});
