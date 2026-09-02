import { describe, expect, it } from 'vitest';
import { assignLanes, mergeBoard, nextMemory, readMemory, withPlacement, EMPTY_MEMORY, LANE_ORDER } from '../src/index.js';
import {
  DEFAULT_BOARD_STATUSES,
  DEFAULT_STATUS_LANES,
  PLACEABLE_LANES,
  attentionOf,
  boardStatuses,
  isTerminal,
  statusLanes,
} from '../src/lanes.js';
import { cwdKey } from '../src/merge.js';
import type { CardPullRequest } from '@ground-control/github';
import type { ActivityPhase } from '@ground-control/sessions';
import type { BoardRules, CardMemory, Lane, LaneId } from '../src/index.js';
import type { IssueCard, Session } from '../src/types.js';
import { issues, sessions } from './helpers.js';

/** The shipped rules. No login, so the recording's own pull requests are nobody's and a lane turns only on what a test derives. */
const RULES: BoardRules = { boardStatuses: DEFAULT_BOARD_STATUSES, statusLanes: DEFAULT_STATUS_LANES, logins: [] };

/** A memory as the board stores it, against the membership set these tests run with. */
function remember(placements: Record<string, LaneId> = {}, seenPastMyHands: string[] = []): CardMemory {
  return { placements, seenPastMyHands, statuses: [...DEFAULT_BOARD_STATUSES] };
}

function lanes(
  cards: IssueCard[],
  live: Session[],
  memory: CardMemory = remember(),
  rules: Partial<BoardRules> = {},
): Lane[] {
  return assignLanes(mergeBoard(cards, live), { ...RULES, ...rules }, memory);
}

function cardFor(all: Lane[], number: number) {
  return all.flatMap((l) => l.cards).find((c) => c.issueNumber === number);
}

function withPhase(phase: ActivityPhase, over: Partial<Session> = {}): Session {
  return { ...sessions[0]!, activity: { phase, since: 1, event: 'Stop' }, ...over };
}

function lane(all: Lane[], id: LaneId): Lane {
  return all.find((l) => l.id === id)!;
}

function issueIn(all: Lane[], number: number): LaneId | undefined {
  return all.flatMap((l) => l.cards).find((c) => c.issueNumber === number)?.lane;
}

/** The recording carries four statuses, so any other is derived here, never saved back. `base` lets two derivations compose. */
function restatus(number: number, status: string | null, base: IssueCard[] = issues): IssueCard[] {
  return base.map((issue) => (issue.number === number ? { ...issue, status } : issue));
}

/** A whole pull request, because the recording predates its author, draft and review fields and a lane now turns on all three. */
const PULL_REQUEST: CardPullRequest = {
  number: 1,
  url: 'https://github.com/example-org/example-repo/pull/1',
  state: 'OPEN',
  author: 'dev-1',
  isDraft: false,
  reviewDecision: null,
};

function withPr(number: number, pr: Partial<CardPullRequest> | null, base: IssueCard[] = issues): IssueCard[] {
  return base.map((issue) =>
    issue.number === number ? { ...issue, pullRequest: pr === null ? null : { ...PULL_REQUEST, ...pr } } : issue,
  );
}

const board = lanes(issues, sessions);

describe('the recording these tests rest on', () => {
  it('carries statuses on both sides of the board membership rule', () => {
    const statuses = new Set(issues.map((issue) => issue.status));

    expect(statuses).toContain('🎁 Assigned');
    expect(statuses).toContain('⚒️ Dev');
    expect(statuses).toContain('🆕 New');
    expect(statuses).toContain('🔍 Dev Review');
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

  it('starts an issue card the developer has not moved in Unstarted when nothing about it says otherwise', () => {
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

  // Review is not in that list: the recording carries a 🔍 Dev Review card, and that status arrives there on its own.
  it('puts nothing in a lane no card arrives in and the developer has not moved one into', () => {
    const untouched = board.filter((l) => !['unstarted', 'build', 'review', 'archived'].includes(l.id));

    expect(untouched.flatMap((l) => l.cards)).toEqual([]);
    expect(lane(board, 'review').cards.length).toBeGreaterThan(0);
    expect(lane(board, 'review').cards.every((c) => c.issue?.status === '🔍 Dev Review')).toBe(true);
  });

  it('keeps the card where the developer put it, whatever its status says', () => {
    const memory = remember({ 'issue:19072': 'review' });

    expect(issueIn(lanes(issues, sessions, memory), 19072)).toBe('review');
    expect(issueIn(lanes(restatus(19072, '⚒️ Dev'), sessions, memory), 19072)).toBe('review');
  });

  it('ignores a stored lane the developer cannot choose', () => {
    const memory = remember({ 'issue:19072': 'archived' });

    expect(issueIn(lanes(issues, sessions, memory), 19072)).toBe('unstarted');
  });

  it('archives a status the board does not keep — R9', () => {
    const off = [
      '🆕 New',
      '🔖 Planned',
      '👀 Tasking Review',
      '🧊 On Ice',
      '🎨 Design Assigned',
      '🏃 Testing',
      '🚀 Releasable',
    ];

    for (const status of off) {
      expect(issueIn(lanes(restatus(19072, status), []), 19072)).toBe('archived');
    }
  });

  it('archives a card even where the developer had placed it, because the work is not theirs', () => {
    const memory = remember({ 'issue:19072': 'build' });

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
    const memory = remember({ 'issue:18954': 'review' });
    const session = withPhase(phase, { issueNumber: 18954 });
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
    const moved = lanes([], [adHoc], remember({ [key]: 'unstarted' }));

    expect(lane(moved, 'unstarted').cards.map((c) => c.key)).toEqual([key]);
    expect(lane(moved, 'build').cards).toEqual([]);
  });

  it('leaves a placed card alone when a session starts or stops — R8 says only the developer moves a card', () => {
    const memory = remember({ 'issue:18954': 'plan' });
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
  const memory = remember({}, ['issue:18954']);

  it('marks a card that is back on the board after having left it', () => {
    const back = lanes(issues, sessions, memory)
      .flatMap((l) => l.cards)
      .find((c) => c.issueNumber === 18954);

    expect(back?.returned).toBe(true);
  });

  it('marks a returned card the developer had parked, wherever they parked it', () => {
    const parked = remember({ 'issue:18954': 'icebox' }, ['issue:18954']);
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
    const marked = lanes([], [adHoc], remember({}, [key]));

    expect(marked.flatMap((l) => l.cards).find((c) => c.key === key)?.returned).toBe(false);
  });

  it('sorts returned cards to the top of their lane', () => {
    const unstarted = lane(lanes(issues, [], remember({}, ['issue:18655'])), 'unstarted');

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
    const memory = remember({ 'issue:2': 'plan' }, ['issue:3']);
    const moved = withPlacement(memory, 'issue:1', 'done');

    expect(moved.placements).toEqual({ 'issue:2': 'plan', 'issue:1': 'done' });
    expect(moved.seenPastMyHands).toEqual(['issue:3']);
  });

  it('clears the returned mark on the card it moves — moving it is the developer seeing it', () => {
    const memory = remember({}, ['issue:1', 'issue:2']);

    expect(withPlacement(memory, 'issue:1', 'build').seenPastMyHands).toEqual(['issue:2']);
  });
});

describe('readMemory', () => {
  const read = (stored: unknown) => readMemory(stored, DEFAULT_BOARD_STATUSES);

  it('reads a memory it wrote', () => {
    const memory = remember({ 'issue:1': 'build' }, ['issue:2']);

    expect(read(memory)).toEqual(memory);
  });

  it('refuses a shape an older build stored, rather than throwing on every render afterwards', () => {
    expect(read({ iced: ['issue:1'], seenPastMyHands: [] })).toEqual(remember());
  });

  it('refuses a hand-edited value of the wrong type', () => {
    for (const bad of [undefined, null, 'build', [], { placements: [], seenPastMyHands: [] }]) {
      expect(read(bad)).toEqual(remember());
    }
  });

  it('refuses a placement naming a lane that does not exist', () => {
    expect(read({ placements: { 'issue:1': 'blocked' }, seenPastMyHands: [] })).toEqual(remember());
  });

  /**
   * A changed membership set carries cards across the archive line for reasons no card caused: every one it newly keeps
   * would read as returned, and the lane each held belongs to a pass the old set had already ended.
   */
  it('drops the seen marks and their placements when the membership set changes', () => {
    const stored = { placements: { 'issue:1': 'done', 'issue:2': 'plan' }, seenPastMyHands: ['issue:1'], statuses: ['⚒️ Dev'] };
    const memory = read(stored);

    expect(memory.seenPastMyHands).toEqual([]);
    expect(memory.placements).toEqual({ 'issue:2': 'plan' });
    expect(memory.statuses).toEqual([...DEFAULT_BOARD_STATUSES]);
  });

  it('keeps them when the same set comes back reordered — membership is a set', () => {
    const stored = {
      placements: { 'issue:1': 'done' },
      seenPastMyHands: ['issue:1'],
      statuses: [...DEFAULT_BOARD_STATUSES].reverse(),
    };

    expect(read(stored).seenPastMyHands).toEqual(['issue:1']);
    expect(read(stored).placements).toEqual({ 'issue:1': 'done' });
  });

  it('takes a memory written before the set was recorded as a change — it cannot know it was the same', () => {
    expect(read({ placements: { 'issue:1': 'done' }, seenPastMyHands: ['issue:1'] })).toEqual(remember());
  });

  it('never hands back the shared empty memory, which a caller may keep', () => {
    expect(read(undefined)).not.toBe(EMPTY_MEMORY);
  });

  /** A render that dropped the set would have the next read take it as a change, wiping every mark on every refresh forever. */
  it('reads a memory a render stored without taking it as a set change', () => {
    const memory = remember({ 'issue:18954': 'plan' }, ['issue:18655']);
    const stored = nextMemory(lanes(issues, sessions, memory), memory, true);

    expect(read(stored)).toEqual(stored);
    expect(read(stored).seenPastMyHands).toContain('issue:18655');
  });

  it('reads a memory a move stored the same way', () => {
    const moved = withPlacement(remember({}, ['issue:2']), 'issue:1', 'build');

    expect(read(moved)).toEqual(moved);
  });
});

describe('statusLanes', () => {
  it('takes the developer own map when they set one', () => {
    expect(statusLanes({ '⚒️ Dev': 'build' })).toEqual({ '⚒️ Dev': 'build' });
  });

  it('takes an empty map as the real choice it is — arrive on pull requests alone', () => {
    expect(statusLanes({})).toEqual({});
  });

  it('falls back to the shipped default for a value that is not a map of statuses', () => {
    for (const bad of [undefined, null, 'review', ['review'], 7]) {
      expect(statusLanes(bad)).toEqual({ ...DEFAULT_STATUS_LANES });
    }
  });

  it('drops an entry naming a lane the developer cannot choose, and keeps the rest', () => {
    expect(statusLanes({ '⚒️ Dev': 'archived', '🔍 Dev Review': 'review', '🏃 Testing': 'nowhere' })).toEqual({
      '🔍 Dev Review': 'review',
    });
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
    const memory = remember({}, ['issue:18954']);

    expect(nextMemory(lanes(onBoard, sessions, memory), memory, true).seenPastMyHands).toEqual(['issue:18954']);
  });

  it('does not remember a session-only card', () => {
    const adHoc = sessions.filter((session) => session.issueNumber === null);

    expect(nextMemory(lanes([], adHoc), EMPTY_MEMORY, true).seenPastMyHands).toEqual([]);
  });

  it('keeps an issue placement whether or not that issue is on the board', () => {
    const memory = remember({ 'issue:18954': 'build', 'issue:404': 'plan' });

    expect(nextMemory(lanes(issues, sessions, memory), memory, true).placements).toEqual(memory.placements);
  });

  it('drops a placement for a session that is gone — its key can never match again', () => {
    const gone = 'session:claude:vanished';
    const memory = remember({ [gone]: 'build' });

    expect(nextMemory(lanes(issues, sessions, memory), memory, true).placements).toEqual({});
  });

  it('keeps a placement for a directory that still has a session running', () => {
    const adHoc = sessions.find((s) => s.issueNumber === null)!;
    const key = `session:${cwdKey(adHoc.cwd)}`;
    const memory = remember({ [key]: 'build' });

    expect(nextMemory(lanes(issues, sessions, memory), memory, true).placements).toEqual({ [key]: 'build' });
  });

  it('keeps every placement when the session read failed — a failed read reports no sessions, not none running', () => {
    const key = 'session:claude:vanished';
    const memory = remember({ 'issue:18954': 'build', [key]: 'plan' });

    expect(nextMemory(lanes(issues, [], memory), memory, false).placements).toEqual(memory.placements);
  });

  it("drops the placement of a card that went past the developer's hands", () => {
    const memory = remember({ 'issue:19072': 'done' });
    const away = lanes(restatus(19072, '🏃 Testing'), [], memory);

    expect(lane(away, 'archived').cards.map((c) => c.key)).toContain('issue:19072');
    expect(nextMemory(away, memory, true).placements).toEqual({});
  });

  it('drops it even when the session read failed — archiving took a status read of its own', () => {
    const memory = remember({ 'issue:19072': 'done' });
    const away = lanes(restatus(19072, '🏃 Testing'), [], memory);

    expect(nextMemory(away, memory, false).placements).toEqual({});
  });

  it('keeps the placement while an agent holds the card on the board — it has not gone past anything yet', () => {
    const live: Session = { ...sessions[0]!, issueNumber: 19072, state: 'working' };
    const memory = remember({ 'issue:19072': 'done' });
    const held = lanes(restatus(19072, '🏃 Testing'), [live], memory);

    expect(issueIn(held, 19072)).toBe('done');
    expect(nextMemory(held, memory, true).placements).toEqual({ 'issue:19072': 'done' });
  });

  it('brings a returned card back on its own signals rather than the lane it left in', () => {
    const memory = remember({ 'issue:19072': 'done' });
    const away = lanes(restatus(19072, '🏃 Testing'), [], memory);
    const back = lanes(restatus(19072, '🔍 Dev Review'), [], nextMemory(away, memory, true));

    expect(issueIn(back, 19072)).toBe('review');
    expect(cardFor(back, 19072)?.returned).toBe(true);
  });
});

describe('inferredLane', () => {
  it('arrives a 🔍 Dev Review card in Review — the status carries a lane, and the board keeps it', () => {
    expect(DEFAULT_BOARD_STATUSES).toContain('🔍 Dev Review');
    expect(issueIn(lanes(restatus(19072, '🔍 Dev Review'), []), 19072)).toBe('review');
  });

  it('leaves a status that carries no lane in Unstarted — ⚒️ Dev spans planning, building and checking alike', () => {
    for (const status of ['🎁 Assigned', '⚒️ Dev']) {
      expect(DEFAULT_STATUS_LANES[status]).toBeUndefined();
      expect(issueIn(lanes(restatus(19072, status), []), 19072)).toBe('unstarted');
    }
  });

  it("arrives the developer's own open pull request in Review", () => {
    expect(issueIn(lanes(withPr(19072, {}), [], remember(), { logins: ['dev-1'] }), 19072)).toBe('review');
  });

  it('matches a login however it is cased', () => {
    const board = lanes(withPr(19072, { author: 'Dev-1' }), [], remember(), { logins: ['dev-1'] });

    expect(issueIn(board, 19072)).toBe('review');
  });

  it("reads nothing from a colleague's pull request — the lane is about what the developer has to do", () => {
    const board = lanes(withPr(19072, { author: 'dev-9' }), [], remember(), { logins: ['dev-1'] });

    expect(issueIn(board, 19072)).toBe('unstarted');
  });

  it('reads no pull request at all when the board does not know whose it would be', () => {
    expect(issueIn(lanes(withPr(19072, {}), [], remember(), { logins: [] }), 19072)).toBe('unstarted');
  });

  it('reads nothing from a pull request with no author — a deleted account is nobody', () => {
    const board = lanes(withPr(19072, { author: null }), [], remember(), { logins: ['dev-1'] });

    expect(issueIn(board, 19072)).toBe('unstarted');
  });

  it('arrives a pull request asking for changes in Build — there is code to change, R7', () => {
    const board = lanes(withPr(19072, { reviewDecision: 'CHANGES_REQUESTED' }), [], remember(), { logins: ['dev-1'] });

    expect(issueIn(board, 19072)).toBe('build');
  });

  it('arrives a draft in Build — it is being written, not read', () => {
    const board = lanes(withPr(19072, { isDraft: true }), [], remember(), { logins: ['dev-1'] });

    expect(issueIn(board, 19072)).toBe('build');
  });

  it('arrives an approved pull request in Review — landing it is the developer own move', () => {
    const board = lanes(withPr(19072, { reviewDecision: 'APPROVED' }), [], remember(), { logins: ['dev-1'] });

    expect(issueIn(board, 19072)).toBe('review');
  });

  it('outranks the status with the pull request — changes requested is Build whatever the tracker says', () => {
    const cards = withPr(19072, { reviewDecision: 'CHANGES_REQUESTED' }, restatus(19072, '🔍 Dev Review'));

    expect(issueIn(lanes(cards, [], remember(), { logins: ['dev-1'] }), 19072)).toBe('build');
  });

  /** A lane no lane list holds would drop the card out of every lane at once, which is a worse R8 break than a wrong lane. */
  it('lands a status named after something on Object prototype in a real lane', () => {
    const cards = restatus(19072, 'toString');
    const board = lanes(cards, [], remember(), { boardStatuses: ['toString'] });

    expect(issueIn(board, 19072)).toBe('unstarted');
    expect(board.flatMap((l) => l.cards)).toHaveLength(cards.length);
  });

  it('reads nothing from a pull request that has landed — the status is the authority then', () => {
    for (const state of ['MERGED', 'CLOSED']) {
      const board = lanes(withPr(19072, { state }), [], remember(), { logins: ['dev-1'] });

      expect(issueIn(board, 19072)).toBe('unstarted');
    }
  });

  it('re-reads the world on every render, so a card nobody has moved follows its pull request', () => {
    const memory = remember();
    const mine = { logins: ['dev-1'] };

    expect(issueIn(lanes(withPr(19072, { isDraft: true }), [], memory, mine), 19072)).toBe('build');
    expect(issueIn(lanes(withPr(19072, { isDraft: false }), [], memory, mine), 19072)).toBe('review');
  });

  it('never moves a card the developer has placed, however the world changes — R8', () => {
    const memory = remember({ 'issue:19072': 'plan' });
    const cards = withPr(19072, { reviewDecision: 'CHANGES_REQUESTED' }, restatus(19072, '🔍 Dev Review'));

    expect(issueIn(lanes(cards, [], memory, { logins: ['dev-1'] }), 19072)).toBe('plan');
  });
});

describe('attentionOf', () => {
  it('asks for the developer when an agent cannot go on without them', () => {
    expect(attentionOf([withPhase('waiting')], 'build')).toBe('blocked');
  });

  it('asks for the developer when an agent ended its turn — finished is not done, R23', () => {
    expect(attentionOf([withPhase('idle')], 'build')).toBe('your-turn');
  });

  it('asks nothing of a working agent', () => {
    expect(attentionOf([withPhase('running')], 'build')).toBeNull();
  });

  it('asks nothing when nothing was reported at all — R24 forbids guessing a phase', () => {
    expect(attentionOf([{ ...sessions[0]!, activity: null }], 'build')).toBeNull();
    expect(attentionOf([], 'build')).toBeNull();
  });

  it('asks nothing for a finished agent whose last event was a prompt — it is not blocked on anybody', () => {
    expect(attentionOf([withPhase('waiting', { state: 'stopped' })], 'build')).toBeNull();
    expect(attentionOf([withPhase('waiting', { state: 'done' })], 'build')).toBeNull();
  });

  it('reads blocked over a finished turn when one card carries both', () => {
    expect(attentionOf([withPhase('idle'), withPhase('waiting')], 'build')).toBe('blocked');
  });

  it.each(['unstarted', 'plan', 'build', 'review'] as const)('asks for the developer in %s', (id) => {
    expect(attentionOf([withPhase('idle')], id)).toBe('your-turn');
  });

  it.each(['done', 'icebox', 'archived'] as const)('asks nothing of a finished turn in %s', (id) => {
    expect(attentionOf([withPhase('idle')], id)).toBeNull();
  });

  it.each(['done', 'icebox', 'archived'] as const)('still asks for the developer in %s when an agent is blocked', (id) => {
    expect(attentionOf([withPhase('waiting')], id)).toBe('blocked');
  });
});

describe('the attention on a card', () => {
  it('carries the mark assignLanes derived', () => {
    const board = lanes(issues, [withPhase('idle', { issueNumber: 18954 })]);

    expect(cardFor(board, 18954)?.attention).toBe('your-turn');
  });

  it('asks nothing on a card the developer parked in Done', () => {
    const live = withPhase('idle', { issueNumber: 18954 });
    const board = lanes(issues, [live], remember({ 'issue:18954': 'done' }));

    expect(cardFor(board, 18954)?.lane).toBe('done');
    expect(cardFor(board, 18954)?.attention).toBeNull();
  });

  it('asks nothing on an archived card whose agent finished', () => {
    const finished = withPhase('idle', { issueNumber: 19072, state: 'done' });
    const board = lanes(restatus(19072, '🏃 Testing'), [finished]);

    expect(cardFor(board, 19072)?.lane).toBe('archived');
    expect(cardFor(board, 19072)?.attention).toBeNull();
  });

  it('still asks for the developer on a card an archiving status only held by a blocked agent', () => {
    const blocked = withPhase('waiting', { issueNumber: 19072, state: 'working' });
    const board = lanes(restatus(19072, '🏃 Testing'), [blocked]);

    expect(cardFor(board, 19072)?.lane).toBe('unstarted');
    expect(cardFor(board, 19072)?.attention).toBe('blocked');
  });

  it('asks nothing across a whole board whose sessions reported no phase', () => {
    expect(sessions.every((s) => s.activity === null)).toBe(true);
    expect(board.flatMap((l) => l.cards).every((c) => c.attention === null)).toBe(true);
  });
});
