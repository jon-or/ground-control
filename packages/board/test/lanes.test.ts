import { describe, expect, it } from 'vitest';
import { assignLanes, mergeBoard, nextMemory, readMemory, withPlacement, EMPTY_MEMORY, LANE_ORDER } from '../src/index.js';
import { DEFAULT_BOARD_STATUSES, PLACEABLE_LANES, boardStatuses, isTerminal } from '../src/lanes.js';
import { cwdKey } from '../src/merge.js';
import type { CardMemory, Lane, LaneId } from '../src/index.js';
import type { IssueCard, Session } from '../src/types.js';
import { issues, sessions } from './helpers.js';

function lanes(cards: IssueCard[], live: Session[], memory: CardMemory = EMPTY_MEMORY): Lane[] {
  return assignLanes(mergeBoard(cards, live), DEFAULT_BOARD_STATUSES, memory);
}

function lane(all: Lane[], id: LaneId): Lane {
  return all.find((l) => l.id === id)!;
}

function issueIn(all: Lane[], number: number): LaneId | undefined {
  return all.flatMap((l) => l.cards).find((c) => c.issueNumber === number)?.lane;
}

/** The recording carries only 🆕 New, 🎁 Assigned and ⚒️ Dev, so any other status is derived here, never saved back. */
function restatus(number: number, status: string | null): IssueCard[] {
  return issues.map((issue) => (issue.number === number ? { ...issue, status } : issue));
}

const board = lanes(issues, sessions);

describe('the recording these tests rest on', () => {
  it('carries statuses on both sides of the board membership rule', () => {
    const statuses = new Set(issues.map((issue) => issue.status));

    expect(statuses).toContain('🎁 Assigned');
    expect(statuses).toContain('⚒️ Dev');
    expect(statuses).toContain('🆕 New');
    expect(DEFAULT_BOARD_STATUSES).not.toContain('🆕 New');
  });

  it('carries live sessions whose agent never reported a finish', () => {
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((session) => !isTerminal(session))).toBe(true);
  });
});

describe('isTerminal', () => {
  it('reads the agent own word for finished', () => {
    const live = sessions[0]!;

    expect(isTerminal({ ...live, state: 'done' })).toBe(true);
    expect(isTerminal({ ...live, state: 'stopped' })).toBe(true);
    expect(isTerminal({ ...live, state: 'working' })).toBe(false);
  });

  it('refuses to read idle as finished — an interactive session is idle whenever nobody is typing', () => {
    const idle = sessions.find((session) => session.status === 'idle');

    expect(idle).toBeDefined();
    expect(isTerminal(idle!)).toBe(false);
    expect(isTerminal({ ...idle!, state: null })).toBe(false);
  });
});

describe('assignLanes', () => {
  it('offers one Review lane, and Archived is not one a card can be moved to', () => {
    expect(LANE_ORDER).toEqual(['unstarted', 'plan', 'build', 'review', 'done', 'icebox', 'archived']);
    expect(PLACEABLE_LANES).toEqual(LANE_ORDER.slice(0, -1));
    expect(lanes([], []).map((l) => l.id)).toEqual([...LANE_ORDER]);
  });

  it('puts every card in exactly one lane — R8', () => {
    const cards = mergeBoard(issues, sessions);
    const placed = board.flatMap((l) => l.cards.map((c) => c.key));

    expect(placed).toHaveLength(cards.length);
    expect(new Set(placed)).toEqual(new Set(cards.map((c) => c.key)));
  });

  it('starts an issue card the developer has not moved in Unstarted, whatever its status', () => {
    const unmoved = lane(board, 'unstarted').cards;

    expect(unmoved.length).toBeGreaterThan(0);
    expect(unmoved.every((c) => c.issue !== null)).toBe(true);

    // Which of the two forms is not a choice: a status the board keeps says only itself, and one it would archive
    // says why it is still here. Accepting either would let the suffix appear on an ordinary card unnoticed.
    for (const card of unmoved) {
      const status = card.issue?.status;

      expect(card.reason).toBe(
        status === null || DEFAULT_BOARD_STATUSES.includes(status!)
          ? status
          : `${status} — past your hands, but an agent is still running.`,
      );
    }
  });

  it('starts a card with no issue in Build — its agent is running, so it is not unstarted', () => {
    const started = lane(board, 'build').cards;

    expect(started.length).toBeGreaterThan(0);
    expect(started.every((c) => c.issue === null)).toBe(true);
    expect(new Set(started.map((c) => c.reason))).toEqual(
      new Set(['Ad-hoc work with no issue.', 'Not among your assigned issues.']),
    );
  });

  it('puts nothing in a lane the developer has not moved a card into', () => {
    const untouched = board.filter((l) => !['unstarted', 'build', 'archived'].includes(l.id));

    expect(untouched.flatMap((l) => l.cards)).toEqual([]);
  });

  it('keeps the card where the developer put it, whatever its status says', () => {
    const memory: CardMemory = { placements: { 'issue:19072': 'review' }, seenPastMyHands: [] };

    expect(issueIn(lanes(issues, sessions, memory), 19072)).toBe('review');
    expect(issueIn(lanes(restatus(19072, '⚒️ Dev'), sessions, memory), 19072)).toBe('review');
  });

  it('ignores a stored lane the developer cannot choose', () => {
    const memory: CardMemory = { placements: { 'issue:19072': 'archived' }, seenPastMyHands: [] };

    expect(issueIn(lanes(issues, sessions, memory), 19072)).toBe('unstarted');
  });

  it('archives a status the board does not keep — R9', () => {
    const off = [
      '🆕 New',
      '🔖 Planned',
      '👀 Tasking Review',
      '🧊 On Ice',
      '🎨 Design Assigned',
      '🔍 Dev Review',
      '🏃 Testing',
      '🚀 Releasable',
    ];

    for (const status of off) {
      expect(issueIn(lanes(restatus(19072, status), []), 19072)).toBe('archived');
    }
  });

  it('archives a card even where the developer had placed it, because the work is not theirs', () => {
    const memory: CardMemory = { placements: { 'issue:19072': 'build' }, seenPastMyHands: [] };

    expect(issueIn(lanes(restatus(19072, '🏃 Testing'), [], memory), 19072)).toBe('archived');
  });

  it('keeps an assigned issue that is not on the project board — R1 outranks a missing status', () => {
    const off = lanes(restatus(19072, null), []);

    expect(issueIn(off, 19072)).toBe('unstarted');
    expect(lane(off, 'unstarted').cards.find((c) => c.issueNumber === 19072)?.reason).toBe('Not on the project board.');
  });

  it('holds an archiving card on the board while an agent is still running on it — R2 outranks R9', () => {
    const live: Session = { ...sessions[0]!, issueNumber: 19072, state: 'working' };
    const held = lanes(restatus(19072, '🏃 Testing'), [live]);

    expect(issueIn(held, 19072)).toBe('unstarted');
    expect(lane(held, 'unstarted').cards.find((c) => c.issueNumber === 19072)?.reason).toContain('still running');
  });

  it('archives that same card once its agents have finished', () => {
    const finished: Session = { ...sessions[0]!, issueNumber: 19072, state: 'done' };

    expect(issueIn(lanes(restatus(19072, '🏃 Testing'), [finished]), 19072)).toBe('archived');
  });

  /**
   * The recording carries no reported activity — the hooks that write it were not installed when it was made — so
   * each phase is derived here. An idle interactive session is live, not finished: R2 still outranks R9.
   */
  it.each(['running', 'waiting', 'idle'] as const)('holds an archiving card for a %s session too', (phase) => {
    const live: Session = {
      ...sessions[0]!,
      issueNumber: 19072,
      state: 'working',
      activity: { phase, since: 1, event: 'Stop' },
    };

    expect(issueIn(lanes(restatus(19072, '🏃 Testing'), [live]), 19072)).toBe('unstarted');
  });

  // R8: nothing but the developer moves a card. A phase flips on its own every few minutes.
  it.each(['running', 'waiting', 'idle'] as const)('puts a %s session in the lane the developer chose', (phase) => {
    const memory: CardMemory = { placements: { 'issue:18954': 'review' }, seenPastMyHands: [] };
    const session: Session = { ...sessions[0]!, issueNumber: 18954, activity: { phase, since: 1, event: 'Stop' } };
    const board = lanes(issues, [session], memory);

    expect(issueIn(board, 18954)).toBe('review');
    expect(nextMemory(board, memory, true).placements).toEqual(memory.placements);
  });

  it('gives ad-hoc work a card per directory rather than hiding it — R4', () => {
    const adHoc = sessions.filter((session) => session.issueNumber === null);
    const directories = new Set(adHoc.map((session) => cwdKey(session.cwd)));
    const only = lanes([], adHoc);

    expect(adHoc.length).toBeGreaterThan(directories.size);
    expect(lane(only, 'build').cards).toHaveLength(directories.size);
    expect(lane(only, 'build').cards.every((c) => c.reason === 'Ad-hoc work with no issue.')).toBe(true);
  });

  it('keeps a card with no issue where the developer dragged it, entry lane notwithstanding', () => {
    const adHoc = sessions.find((session) => session.issueNumber === null)!;
    const key = `session:${cwdKey(adHoc.cwd)}`;
    const memory: CardMemory = { placements: { [key]: 'unstarted' }, seenPastMyHands: [] };
    const moved = lanes([], [adHoc], memory);

    expect(lane(moved, 'unstarted').cards.map((c) => c.key)).toEqual([key]);
    expect(lane(moved, 'build').cards).toEqual([]);
  });

  it('leaves a placed card alone when a session starts or stops — R8 says only the developer moves a card', () => {
    const memory: CardMemory = { placements: { 'issue:18954': 'plan' }, seenPastMyHands: [] };
    const running: Session = { ...sessions[0]!, issueNumber: 18954, state: 'working' };
    const finished: Session = { ...running, state: 'done' };

    expect(issueIn(lanes(issues, [], memory), 18954)).toBe('plan');
    expect(issueIn(lanes(issues, [running], memory), 18954)).toBe('plan');
    expect(issueIn(lanes(issues, [finished], memory), 18954)).toBe('plan');
  });

  it('says so on a card for an issue the developer does not own', () => {
    const off = sessions.find((s) => s.issueNumber !== null && !issues.some((i) => i.number === s.issueNumber))!;
    const card = lanes(issues, [off])
      .flatMap((l) => l.cards)
      .find((c) => c.issueNumber === off.issueNumber);

    expect(card?.lane).toBe('build');
    expect(card?.reason).toBe('Not among your assigned issues.');
  });
});

describe('the returned badge', () => {
  const memory: CardMemory = { placements: {}, seenPastMyHands: ['issue:18954'] };

  it('marks a card that is back on the board after having left it', () => {
    const back = lanes(issues, sessions, memory)
      .flatMap((l) => l.cards)
      .find((c) => c.issueNumber === 18954);

    expect(back?.returned).toBe(true);
  });

  it('marks a returned card the developer had parked, wherever they parked it', () => {
    const parked: CardMemory = { placements: { 'issue:18954': 'icebox' }, seenPastMyHands: ['issue:18954'] };
    const card = lanes(issues, sessions, parked)
      .flatMap((l) => l.cards)
      .find((c) => c.issueNumber === 18954);

    expect(card?.lane).toBe('icebox');
    expect(card?.returned).toBe(true);
  });

  it('marks nothing when the memory has never seen the card leave', () => {
    expect(board.flatMap((l) => l.cards).some((c) => c.returned)).toBe(false);
  });

  it('does not mark a card that is still off the board', () => {
    const away = lanes(restatus(18954, '🏃 Testing'), [], memory);
    const card = away.flatMap((l) => l.cards).find((c) => c.issueNumber === 18954);

    expect(card?.returned).toBe(false);
  });

  it('never marks a card with no issue — it was never on the board to leave it', () => {
    const adHoc = sessions.find((s) => s.issueNumber === null)!;
    const key = `session:${cwdKey(adHoc.cwd)}`;
    const marked = lanes([], [adHoc], { placements: {}, seenPastMyHands: [key] });

    expect(marked.flatMap((l) => l.cards).find((c) => c.key === key)?.returned).toBe(false);
  });

  it('sorts returned cards to the top of their lane', () => {
    const unstarted = lane(lanes(issues, [], { placements: {}, seenPastMyHands: ['issue:18655'] }), 'unstarted');

    expect(unstarted.cards.length).toBeGreaterThan(1);
    expect(unstarted.cards[0]?.issueNumber).toBe(18655);
    expect(unstarted.cards.slice(1).every((c) => !c.returned)).toBe(true);
  });
});

describe('boardStatuses', () => {
  it('takes the developer own list when they set one', () => {
    expect(boardStatuses(['⚒️ Dev'])).toEqual(['⚒️ Dev']);
  });

  it('falls back to the shipped default for anything unusable', () => {
    for (const bad of [undefined, null, '⚒️ Dev', [], {}, [1, 2]]) {
      expect(boardStatuses(bad)).toEqual([...DEFAULT_BOARD_STATUSES]);
    }
  });

  it('keeps only the strings out of a mixed list', () => {
    expect(boardStatuses(['⚒️ Dev', 7, null])).toEqual(['⚒️ Dev']);
  });
});

describe('withPlacement', () => {
  it('records where the developer moved a card', () => {
    expect(withPlacement(EMPTY_MEMORY, 'issue:1', 'build').placements).toEqual({ 'issue:1': 'build' });
  });

  it('records a move to Unstarted too — a card whose entry lane is Build has to remember leaving it', () => {
    const moved = withPlacement(EMPTY_MEMORY, 'session:claude:1', 'unstarted');

    expect(moved.placements).toEqual({ 'session:claude:1': 'unstarted' });
  });

  it('refuses a lane the developer cannot choose', () => {
    expect(withPlacement(EMPTY_MEMORY, 'issue:1', 'archived')).toBe(EMPTY_MEMORY);
    expect(PLACEABLE_LANES).not.toContain('archived');
  });

  it('leaves the rest of the memory alone', () => {
    const memory: CardMemory = { placements: { 'issue:2': 'plan' }, seenPastMyHands: ['issue:3'] };
    const moved = withPlacement(memory, 'issue:1', 'done');

    expect(moved.placements).toEqual({ 'issue:2': 'plan', 'issue:1': 'done' });
    expect(moved.seenPastMyHands).toEqual(['issue:3']);
  });

  it('clears the returned mark on the card it moves — moving it is the developer seeing it', () => {
    const memory: CardMemory = { placements: {}, seenPastMyHands: ['issue:1', 'issue:2'] };

    expect(withPlacement(memory, 'issue:1', 'build').seenPastMyHands).toEqual(['issue:2']);
  });
});

describe('readMemory', () => {
  it('reads a memory it wrote', () => {
    const memory: CardMemory = { placements: { 'issue:1': 'build' }, seenPastMyHands: ['issue:2'] };

    expect(readMemory(memory)).toEqual(memory);
  });

  it('refuses a shape an older build stored, rather than throwing on every render afterwards', () => {
    expect(readMemory({ iced: ['issue:1'], seenPastMyHands: [] })).toEqual(EMPTY_MEMORY);
  });

  it('refuses a hand-edited value of the wrong type', () => {
    for (const bad of [undefined, null, 'build', [], { placements: [], seenPastMyHands: [] }]) {
      expect(readMemory(bad)).toEqual(EMPTY_MEMORY);
    }
  });

  it('refuses a placement naming a lane that does not exist', () => {
    expect(readMemory({ placements: { 'issue:1': 'blocked' }, seenPastMyHands: [] })).toEqual(EMPTY_MEMORY);
  });
});

describe('nextMemory', () => {
  const onBoard = issues.filter((issue) => DEFAULT_BOARD_STATUSES.includes(issue.status ?? ''));

  it('remembers exactly the cards the board took off it', () => {
    const away = lane(board, 'archived').cards.map((card) => card.key);

    expect(away.length).toBeGreaterThan(0);
    expect(nextMemory(board, EMPTY_MEMORY, true).seenPastMyHands).toEqual(away);
  });

  it('remembers nothing about a card still on the board', () => {
    expect(onBoard.length).toBeGreaterThan(0);
    expect(nextMemory(lanes(onBoard, sessions), EMPTY_MEMORY, true).seenPastMyHands).toEqual([]);
  });

  it('keeps a key after the card comes back, so a second departure is not a first', () => {
    const memory: CardMemory = { placements: {}, seenPastMyHands: ['issue:18954'] };

    expect(nextMemory(lanes(onBoard, sessions, memory), memory, true).seenPastMyHands).toEqual(['issue:18954']);
  });

  it('does not remember a session-only card', () => {
    const adHoc = sessions.filter((session) => session.issueNumber === null);

    expect(nextMemory(lanes([], adHoc), EMPTY_MEMORY, true).seenPastMyHands).toEqual([]);
  });

  it('keeps an issue placement whether or not that issue is on the board', () => {
    const memory: CardMemory = { placements: { 'issue:18954': 'build', 'issue:404': 'plan' }, seenPastMyHands: [] };

    expect(nextMemory(lanes(issues, sessions, memory), memory, true).placements).toEqual(memory.placements);
  });

  it('drops a placement for a session that is gone — its key can never match again', () => {
    const gone = 'session:claude:vanished';
    const memory: CardMemory = { placements: { [gone]: 'build' }, seenPastMyHands: [] };

    expect(nextMemory(lanes(issues, sessions, memory), memory, true).placements).toEqual({});
  });

  it('keeps a placement for a directory that still has a session running', () => {
    const adHoc = sessions.find((s) => s.issueNumber === null)!;
    const key = `session:${cwdKey(adHoc.cwd)}`;
    const memory: CardMemory = { placements: { [key]: 'build' }, seenPastMyHands: [] };

    expect(nextMemory(lanes(issues, sessions, memory), memory, true).placements).toEqual({ [key]: 'build' });
  });

  it('keeps every placement when the session read failed — a failed read reports no sessions, not none running', () => {
    const key = 'session:claude:vanished';
    const memory: CardMemory = { placements: { 'issue:18954': 'build', [key]: 'plan' }, seenPastMyHands: [] };

    expect(nextMemory(lanes(issues, [], memory), memory, false).placements).toEqual(memory.placements);
  });
});
