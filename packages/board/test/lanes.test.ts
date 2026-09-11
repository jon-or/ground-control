import { describe, expect, it } from 'vitest';
import { assignLanes, mergeBoard, nextMemory, readMemory, withPlacement, EMPTY_MEMORY, LANE_ORDER } from '../src/index.js';
import {
  DEFAULT_BOARD_STATUSES,
  DEFAULT_STATUS_LANES,
  PLACEABLE_LANES,
  attentionOf,
  boardStatuses,
  retainedPhase,
  statusLanes,
} from '../src/lanes.js';
import type { CardPullRequest } from '@ground-control/github';
import type { ActivityPhase } from '@ground-control/core';
import type { BoardCard, BoardRules, CardMemory, Lane, LaneId } from '../src/index.js';
import type { IssueCard, Session } from '../src/types.js';
import { checkoutKeyOf, issues, offBoardIssues, sessions } from './helpers.js';

/**
 * Default rules without developer logins; tests set PR ownership explicitly.
 */
const RULES: BoardRules = { boardStatuses: DEFAULT_BOARD_STATUSES, statusLanes: DEFAULT_STATUS_LANES, logins: [] };

/** Archive timestamp before the retained activity used in these tests. */
const AWAY_AT = 5_000;

/**
 * A memory as the board stores it, against the membership set these tests run with. Keys are dated to `AWAY_AT`
 * and read as still archived.
 */
function remember(placements: Record<string, LaneId> = {}, away: string[] = []): CardMemory {
  return {
    placements,
    pastMyHandsAt: Object.fromEntries(away.map((key) => [key, AWAY_AT])),
    archived: [...away],
    seen: [],
    statuses: [...DEFAULT_BOARD_STATUSES],
  };
}

/**
 * The keys a memory holds a departure date for, which is what the returned mark and a retained reading are both
 * judged on.
 */
function departedKeys(memory: CardMemory): string[] {
  return Object.keys(memory.pastMyHandsAt);
}

function lanes(
  cards: IssueCard[],
  live: Session[],
  memory: CardMemory = remember(),
  rules: Partial<BoardRules> = {},
): Lane[] {
  return assignLanes(mergeBoard(cards, live, [], offBoardIssues), { ...RULES, ...rules }, memory);
}

function cardFor(all: Lane[], number: number) {
  return all.flatMap((l) => l.cards).find((c) => c.issueNumber === number);
}

function withPhase(phase: ActivityPhase, over: Partial<Session> = {}): Session {
  return { ...sessions[0]!, repository: 'github.com/example-org/example-repo', activity: { phase, since: 1, at: 1, event: 'Stop' }, ...over };
}

/** Historical session fixture. Retained activity survives only after the AWAY_AT departure timestamp. */
function held(phase: ActivityPhase, at = AWAY_AT + 1_000, over: Partial<BoardCard> = {}): BoardCard {
  return {
    key: 'issue:18954',
    issue: issues.find((issue) => issue.number === 18954)!,
    issueNumber: 18954,
    sessions: [],
    lastSession: {
      agent: 'claude',
      sessionId: 'a-past-attempt',
      title: 'The attempt before',
      cwd: 'd:/work/18954-a-branch',
      branch: '18954-a-branch',
      issueNumber: 18954,
      repository: 'github.com/example-org/example-repo',
      updatedAt: at,
      retained: { phase, event: 'PreToolUse', at },
    },
    ...over,
  };
}

function lane(all: Lane[], id: LaneId): Lane {
  return all.find((l) => l.id === id)!;
}

function issueIn(all: Lane[], number: number): LaneId | undefined {
  return all.flatMap((l) => l.cards).find((c) => c.issueNumber === number)?.lane;
}

/**
 * The recording carries four statuses, so any other is derived here, never saved back. `base` lets two derivations
 * compose.
 */
function restatus(number: number, status: string | null, base: IssueCard[] = issues): IssueCard[] {
  return base.map((issue) => (issue.number === number ? { ...issue, status } : issue));
}

/**
 * A whole pull request, because the recording predates its author, draft and review fields and a lane now turns on
 * all three.
 */
const PULL_REQUEST: CardPullRequest = {
  number: 1,
  url: 'https://github.com/example-org/example-repo/pull/1',
  state: 'OPEN',
  author: 'dev-1',
  isDraft: false,
  reviewDecision: null,
  updatedAt: null,
  headOid: null,
  checksRed: null,
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
    expect(sessions.every((session) => !session.finished)).toBe(true);
  });
});

describe('assignLanes', () => {
  it('offers one Review lane, and Archived is not one a card can be moved to', () => {
    expect(LANE_ORDER).toEqual(['unstarted', 'plan', 'build', 'review', 'icebox', 'archived']);
    expect(PLACEABLE_LANES).toEqual(LANE_ORDER.slice(0, -1));
    expect(lanes([], []).map((l) => l.id)).toEqual([...LANE_ORDER]);
  });

  it('puts every card in exactly one lane — R8', () => {
    const cards = mergeBoard(issues, sessions, [], offBoardIssues);
    const placed = board.flatMap((l) => l.cards.map((c) => c.key));

    expect(placed).toHaveLength(cards.length);
    expect(new Set(placed)).toEqual(new Set(cards.map((c) => c.key)));
  });

  it('defaults unplaced issue cards to Unstarted', () => {
    const unmoved = lane(board, 'unstarted').cards;

    expect(unmoved.length).toBeGreaterThan(0);
    expect(unmoved.every((c) => c.issue !== null)).toBe(true);

    // Require the active-session suffix only for statuses that would otherwise archive the card.
    for (const card of unmoved) {
      const status = card.issue?.status;

      expect(card.reason).toBe(
        status === null || DEFAULT_BOARD_STATUSES.includes(status!)
          ? status
          : `${status} — session still active.`,
      );
    }
  });

  it('starts a card with no issue in Build — its agent is running, so it is not unstarted', () => {
    const adHoc = lane(board, 'build').cards.filter((c) => c.issue === null);

    expect(adHoc.length).toBeGreaterThan(0);
    expect(new Set(adHoc.map((c) => c.reason))).toEqual(new Set(['Ad-hoc work with no issue.']));
  });

  it('starts every ⚒️ Dev card the developer has not moved in Build alongside them', () => {
    const dev = issues.filter((issue) => issue.status === '⚒️ Dev').map((issue) => issue.number);
    const started = lane(board, 'build').cards.filter((c) => c.issue !== null);

    expect(dev.length).toBeGreaterThan(0);
    expect(new Set(started.map((c) => c.issueNumber))).toEqual(new Set(dev));
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
    const live: Session = { ...sessions[0]!, issueNumber: 19072, repository: 'github.com/example-org/example-repo', finished: false };
    const held = lanes(restatus(19072, '🏃 Testing'), [live]);

    expect(issueIn(held, 19072)).toBe('unstarted');
    expect(lane(held, 'unstarted').cards.find((c) => c.issueNumber === 19072)?.reason).toContain('session still active');
  });

  it('archives that same card once its agents have finished', () => {
    const finished: Session = { ...sessions[0]!, issueNumber: 19072, repository: 'github.com/example-org/example-repo', finished: true };

    expect(issueIn(lanes(restatus(19072, '🏃 Testing'), [finished]), 19072)).toBe('archived');
  });

  /** Derive the phase required by this test. Idle interactive sessions remain live, so R2 still overrides R9. */
  it.each(['running', 'waiting', 'idle'] as const)('holds an archiving card for a %s session too', (phase) => {
    const live: Session = {
      ...sessions[0]!,
      issueNumber: 19072,
      repository: 'github.com/example-org/example-repo',
      finished: false,
      attachId: null,
      activity: { phase, since: 1, at: 1, event: 'Stop' },
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

  it('gives ad-hoc work a card per checkout rather than hiding it — R4', () => {
    const adHoc = sessions.filter((session) => session.issueNumber === null);
    const checkouts = new Set(adHoc.map(checkoutKeyOf));
    const only = lanes([], adHoc);

    expect(adHoc.length).toBeGreaterThan(checkouts.size);
    expect(lane(only, 'build').cards).toHaveLength(checkouts.size);
    expect(lane(only, 'build').cards.every((c) => c.reason === 'Ad-hoc work with no issue.')).toBe(true);
  });

  it('keeps a card with no issue where the developer dragged it, entry lane notwithstanding', () => {
    const adHoc = sessions.find((session) => session.issueNumber === null)!;
    const key = `session:${checkoutKeyOf(adHoc)}`;
    const moved = lanes([], [adHoc], remember({ [key]: 'unstarted' }));

    expect(lane(moved, 'unstarted').cards.map((c) => c.key)).toEqual([key]);
    expect(lane(moved, 'build').cards).toEqual([]);
  });

  it('preserves manual placement when sessions start or stop', () => {
    const memory = remember({ 'issue:18954': 'plan' });
    const running: Session = { ...sessions[0]!, issueNumber: 18954, finished: false };
    const finished: Session = { ...running, finished: true };

    expect(issueIn(lanes(issues, [], memory), 18954)).toBe('plan');
    expect(issueIn(lanes(issues, [running], memory), 18954)).toBe('plan');
    expect(issueIn(lanes(issues, [finished], memory), 18954)).toBe('plan');
  });

  /** Unassignment archives cards even with active sessions (R9). */
  it('names the issue and archives the card even while an agent is still running on it', () => {
    const off = sessions.find(
      (s) => s.issueNumber !== null && !s.finished && !issues.some((i) => i.number === s.issueNumber),
    )!;
    const card = lanes(issues, [off])
      .flatMap((l) => l.cards)
      .find((c) => c.issueNumber === off.issueNumber);

    expect(card?.issue?.title).toBe(offBoardIssues.get(off.issueNumber!)?.title);
    expect(card?.sessions.map((s) => s.sessionId)).toEqual([off.sessionId]);
    expect(card?.lane).toBe('archived');
    expect(card?.reason).toBe('🚦 QA — not assigned to you.');
  });

  it('archives unassigned issues without active sessions', () => {
    const off = sessions.find((s) => s.issueNumber !== null && !issues.some((i) => i.number === s.issueNumber))!;
    const card = lanes(issues, [{ ...off, finished: true }])
      .flatMap((l) => l.cards)
      .find((c) => c.issueNumber === off.issueNumber);

    expect(card?.lane).toBe('archived');
    expect(card?.reason).toBe('🚦 QA — not assigned to you.');
  });

  it('says a closed issue is closed rather than naming a status it no longer carries', () => {
    const off = sessions.find((s) => s.issueNumber !== null && !issues.some((i) => i.number === s.issueNumber))!;
    const closed = new Map(offBoardIssues);
    closed.set(off.issueNumber!, { ...offBoardIssues.get(off.issueNumber!)!, state: 'CLOSED', status: null });
    const card = assignLanes(mergeBoard(issues, [{ ...off, finished: true }], [], closed), RULES, remember())
      .flatMap((l) => l.cards)
      .find((c) => c.issueNumber === off.issueNumber);

    expect(card?.lane).toBe('archived');
    expect(card?.reason).toBe('Closed.');
  });

  /** Closing an issue takes it out of the assigned search too, and saying it is somebody else's would be false. */
  it('does not call an issue still in the developer own name somebody else', () => {
    const off = sessions.find((s) => s.issueNumber !== null && !issues.some((i) => i.number === s.issueNumber))!;
    const mine = new Map(offBoardIssues);
    mine.set(off.issueNumber!, { ...offBoardIssues.get(off.issueNumber!)!, assignees: ['dev-1'] });
    const rules = { ...RULES, logins: ['dev-1'] };
    const card = assignLanes(mergeBoard(issues, [{ ...off, finished: true }], [], mine), rules, remember())
      .flatMap((l) => l.cards)
      .find((c) => c.issueNumber === off.issueNumber);

    expect(card?.lane).toBe('archived');
    expect(card?.reason).toBe('🚦 QA — no longer among the issues your board reads.');
  });

  it('says only that it is not yours where the issue carries no status at all', () => {
    const off = sessions.find((s) => s.issueNumber !== null && !issues.some((i) => i.number === s.issueNumber))!;
    const bare = new Map(offBoardIssues);
    bare.set(off.issueNumber!, { ...offBoardIssues.get(off.issueNumber!)!, status: null });
    const card = assignLanes(mergeBoard(issues, [{ ...off, finished: true }], [], bare), RULES, remember())
      .flatMap((l) => l.cards)
      .find((c) => c.issueNumber === off.issueNumber);

    expect(card?.reason).toBe('Not assigned to you.');
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
    const key = `session:${checkoutKeyOf(adHoc)}`;
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
    const moved = withPlacement(memory, 'issue:1', 'icebox');

    expect(moved.placements).toEqual({ 'issue:2': 'plan', 'issue:1': 'icebox' });
    expect(departedKeys(moved)).toEqual(['issue:3']);
  });

  /**
   * The date stays: it is what a retained reading is judged against, and looking at a card is not the card leaving
   * again.
   */
  it('clears the returned mark on the card it moves, and keeps the date it went away', () => {
    const memory = remember({}, ['issue:18954']);
    const moved = withPlacement(memory, 'issue:18954', 'build');

    expect(cardFor(lanes(issues, [], memory), 18954)?.returned).toBe(true);
    expect(cardFor(lanes(issues, [], moved), 18954)?.returned).toBe(false);
    expect(moved.pastMyHandsAt['issue:18954']).toBe(AWAY_AT);
  });
});

describe('readMemory', () => {
  const read = (stored: unknown) => readMemory(stored, DEFAULT_BOARD_STATUSES);

  it('reads a memory it wrote', () => {
    const memory = remember({ 'issue:1': 'build' }, ['issue:2']);

    expect(read(memory)).toEqual(memory);
  });

  it('refuses a shape an older build stored, rather than throwing on every render afterwards', () => {
    expect(read({ iced: ['issue:1'] })).toEqual(remember());
  });

  it('refuses a hand-edited value of the wrong type', () => {
    for (const bad of [undefined, null, 'build', [], { placements: [] }]) {
      expect(read(bad)).toEqual(remember());
    }
  });

  it('drops a placement naming a lane that does not exist, including one a prior version stored, and keeps the rest', () => {
    const stale = read({ placements: { 'issue:1': 'blocked', 'issue:18954': 'done', 'issue:2': 'plan' } });
    const inferred = cardFor(lanes(issues, []), 18954)?.lane;

    expect(stale.placements).toEqual({ 'issue:2': 'plan' });
    expect(inferred).toBeDefined();
    expect(cardFor(lanes(issues, [], stale), 18954)?.lane).toBe(inferred);
  });

  /** Membership edits must not create returned attention or retain placements from archived work. */
  it('drops the seen marks and their placements when the membership set changes', () => {
    const stored = { ...remember({ 'issue:1': 'icebox', 'issue:2': 'plan' }, ['issue:1']), statuses: ['⚒️ Dev'] };
    const memory = read(stored);

    expect(memory.seen).toEqual(['issue:1']);
    expect(memory.placements).toEqual({ 'issue:2': 'plan' });
    expect(memory.statuses).toEqual([...DEFAULT_BOARD_STATUSES]);
  });

  /**
   * Preserve departure dates while clearing returned attention; settings edits cannot restore invalidated activity
   * (R6).
   */
  it('keeps the departure dates when the membership set changes, with every one of them seen', () => {
    const memory = read({ ...remember({}, ['issue:18954']), statuses: ['⚒️ Dev'] });

    expect(memory.pastMyHandsAt).toEqual({ 'issue:18954': AWAY_AT });
    expect(memory.seen).toEqual(['issue:18954']);
    expect(cardFor(lanes(issues, [], memory), 18954)?.returned).toBe(false);
    expect(assignLanes([held('waiting', AWAY_AT - 1)], RULES, memory).flatMap((l) => l.cards)[0]?.attention).toBeNull();
  });

  /** Preserve placements made after a card returns (R8). */
  it('keeps the placement of a card that had come back before the membership set changed', () => {
    const back = { ...remember({ 'issue:1': 'review' }, ['issue:1']), archived: [], seen: ['issue:1'], statuses: ['⚒️ Dev'] };

    expect(read(back).placements).toEqual({ 'issue:1': 'review' });
  });

  it('keeps them when the same set comes back reordered — membership is a set', () => {
    const stored = { ...remember({ 'issue:1': 'icebox' }, ['issue:1']), statuses: [...DEFAULT_BOARD_STATUSES].reverse() };

    expect(departedKeys(read(stored))).toEqual(['issue:1']);
    expect(read(stored).placements).toEqual({ 'issue:1': 'icebox' });
  });

  it('treats missing legacy membership settings as changed', () => {
    const { statuses: _absent, ...older } = remember({ 'issue:1': 'icebox' }, ['issue:1']);
    const memory = read(older);

    expect(memory.placements).toEqual({});
    expect(memory.seen).toEqual(['issue:1']);
  });

  /** Date legacy archive entries to the read so pre-departure activity remains invalid. */
  it('dates a bare key list an older build wrote to the moment it reads it', () => {
    const memory = readMemory(
      { placements: {}, seenPastMyHands: ['issue:1'], statuses: [...DEFAULT_BOARD_STATUSES] },
      DEFAULT_BOARD_STATUSES,
      4_000,
    );

    expect(memory.pastMyHandsAt).toEqual({ 'issue:1': 4_000 });
  });

  it('returns independent empty memory', () => {
    expect(read(undefined)).not.toBe(EMPTY_MEMORY);
  });

  /**
   * A render that dropped the set would have the next read take it as a change, wiping every mark on every refresh
   * forever.
   */
  it('reads a memory a render stored without taking it as a set change', () => {
    const memory = remember({ 'issue:18954': 'plan' }, ['issue:18655']);
    const stored = nextMemory(lanes(issues, sessions, memory), memory, true);

    expect(read(stored)).toEqual(stored);
    expect(departedKeys(read(stored))).toContain('issue:18655');
  });

  it('reads a memory a move stored the same way', () => {
    const moved = withPlacement(remember({}, ['issue:2']), 'issue:1', 'build');

    expect(read(moved)).toEqual(moved);
  });
});

/** Retain unresolved attention after process exit and keep card and session phase indicators consistent (R6). */
describe('a reading kept past its own process', () => {
  const cardOf = (card: BoardCard, memory: CardMemory = remember()) => assignLanes([card], RULES, memory).flatMap((l) => l.cards)[0]!;

  it('asks for the developer on a session that was waiting when its process ended', () => {
    expect(cardOf(held('waiting')).attention).toBe('blocked');
  });

  it('asks for the developer on one that had finished its turn', () => {
    expect(cardOf(held('idle')).attention).toBe('your-turn');
  });

  it('keeps a failure a session ended on, because the error still needs a decision', () => {
    expect(cardOf(held('failed')).attention).toBe('failed');
    expect(retainedPhase({ phase: 'failed', event: 'StopFailure', at: 1, error: { kind: 'rate_limit', message: null } })).toBe('failed');
  });

  /**
   * The process is gone, so the work stopped mid-turn — which is the developer's move, and `idle`'s answer rather
   * than a fourth state.
   */
  it('reads a session that was working when its process ended as the developer own turn', () => {
    expect(cardOf(held('running')).attention).toBe('your-turn');
    expect(retainedPhase({ phase: 'running', event: 'PostToolBatch', at: 1 })).toBe('idle');
    expect(retainedPhase({ phase: 'waiting', event: 'PreToolUse', at: 1 })).toBe('waiting');
    expect(retainedPhase({ phase: 'idle', event: 'Stop', at: 1 })).toBe('idle');
  });

  /** Discard activity from before the latest departure when a card returns (R9). */
  it.each(['waiting', 'idle', 'running', 'failed'] as const)('drops a %s reading the card has since outlived', (phase) => {
    const card = cardOf(held(phase, AWAY_AT - 1_000), remember({}, ['issue:18954']));

    expect(card.attention).toBeNull();
    expect(card.lastSession).not.toHaveProperty('retained');
  });

  it('keeps a reading taken after the card came back', () => {
    expect(cardOf(held('waiting', AWAY_AT + 1), remember({}, ['issue:18954'])).attention).toBe('blocked');
  });

  /**
   * A card the developer has parked in Icebox is one they have said is not theirs to push on, and a your-turn there
   * asks nothing of them.
   */
  it('asks nothing on a card parked in a settled lane, and still says needs you there', () => {
    const parked = remember({ 'issue:18954': 'icebox' });

    expect(cardOf(held('idle'), parked).attention).toBeNull();
    expect(cardOf(held('failed'), parked).attention).toBeNull();
    expect(cardOf(held('waiting'), parked).attention).toBe('blocked');
  });

  it('reads a saved session with no reading as the plain history it is', () => {
    const bare = held('idle');

    delete bare.lastSession!.retained;

    expect(cardOf(bare).attention).toBeNull();
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
    expect(statusLanes({ '⚒️ Dev': 'archived', '🔍 Dev Review': 'review', '🏃 Testing': 'nowhere', '🚀 Releasable': 'done' })).toEqual({
      '🔍 Dev Review': 'review',
    });
  });
});

describe('nextMemory', () => {
  const onBoard = issues.filter((issue) => DEFAULT_BOARD_STATUSES.includes(issue.status ?? ''));

  it('remembers exactly the cards the board took off it', () => {
    const away = lane(board, 'archived').cards.map((card) => card.key);

    expect(away.length).toBeGreaterThan(0);
    expect(departedKeys(nextMemory(board, EMPTY_MEMORY, true))).toEqual(away);
  });

  /** Sessions on an issue nobody assigned the developer are left out: those cards archive, which is the other case. */
  const mine = sessions.filter((session) => session.issueNumber === null || onBoard.some((i) => i.number === session.issueNumber));

  it('remembers nothing about a card still on the board', () => {
    expect(onBoard.length).toBeGreaterThan(0);
    expect(departedKeys(nextMemory(lanes(onBoard, mine), EMPTY_MEMORY, true))).toEqual([]);
  });

  it('records departure of unassigned issues', () => {
    const off = sessions.find((s) => s.issueNumber !== null && !onBoard.some((i) => i.number === s.issueNumber))!;

    expect(departedKeys(nextMemory(lanes(onBoard, [off]), EMPTY_MEMORY, true))).toEqual([`issue:${off.issueNumber}`]);
  });

  it('keeps a key after the card comes back, so a second departure is not a first', () => {
    const memory = remember({}, ['issue:18954']);

    expect(departedKeys(nextMemory(lanes(onBoard, mine, memory), memory, true))).toEqual(['issue:18954']);
  });

  /** Preserve archive history across empty startup renders so later renders do not reset departure dates. */
  it('keeps the archived set through a render that showed no cards at all', () => {
    const away = restatus(18954, '🏃 Testing');
    const first = nextMemory(lanes(away, [], remember()), remember(), true, 5_000);
    const blank = nextMemory([], first, false, 9_000);

    expect(blank.archived).toContain('issue:18954');
    expect(blank.archived).toEqual(first.archived);
    expect(blank.pastMyHandsAt).toEqual(first.pastMyHandsAt);
    expect(nextMemory(lanes(away, [], blank), blank, true, 12_000).pastMyHandsAt['issue:18954']).toBe(5_000);
  });

  /**
   * A lane chosen while the card was off the board belongs to a pass that had already ended, so it is not the
   * developer seeing it come back.
   */
  it('forgets a placement made while the card was archived, so its next return is still marked', () => {
    const away = restatus(18954, '🏃 Testing');
    const gone = nextMemory(lanes(away, [], remember()), remember(), true, 5_000);
    const moved = withPlacement(gone, 'issue:18954', 'build');

    expect(moved.seen).toContain('issue:18954');

    const still = nextMemory(lanes(away, [], moved), moved, true, 6_000);

    expect(still.seen).not.toContain('issue:18954');
    expect(cardFor(lanes(onBoard, mine, still), 18954)?.returned).toBe(true);
  });

  /**
   * Preserve archive timestamps across renders so newer activity stays valid and unchanged state is not rewritten.
   */
  it('dates a card once while it stays archived, and again when it leaves a second time', () => {
    const away = restatus(18954, '🏃 Testing');
    const first = nextMemory(lanes(away, [], remember()), remember(), true, 5_000);

    expect(first.pastMyHandsAt['issue:18954']).toBe(5_000);
    expect(nextMemory(lanes(away, [], first), first, true, 9_000).pastMyHandsAt['issue:18954']).toBe(5_000);

    const back = nextMemory(lanes(onBoard, mine, first), first, true, 9_000);

    expect(back.archived).not.toContain('issue:18954');
    expect(nextMemory(lanes(away, [], back), back, true, 12_000).pastMyHandsAt['issue:18954']).toBe(12_000);
  });

  it('does not remember a session-only card', () => {
    const adHoc = sessions.filter((session) => session.issueNumber === null);

    expect(departedKeys(nextMemory(lanes([], adHoc), EMPTY_MEMORY, true))).toEqual([]);
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

  it('keeps a placement for a checkout that still has a session running', () => {
    const adHoc = sessions.find((s) => s.issueNumber === null)!;
    const key = `session:${checkoutKeyOf(adHoc)}`;
    const memory = remember({ [key]: 'build' });

    expect(nextMemory(lanes(issues, sessions, memory), memory, true).placements).toEqual({ [key]: 'build' });
  });

  it('preserves placements after failed session reads', () => {
    const key = 'session:claude:vanished';
    const memory = remember({ 'issue:18954': 'build', [key]: 'plan' });

    expect(nextMemory(lanes(issues, [], memory), memory, false).placements).toEqual(memory.placements);
  });

  it("drops archived card placements", () => {
    const memory = remember({ 'issue:19072': 'icebox' });
    const away = lanes(restatus(19072, '🏃 Testing'), [], memory);

    expect(lane(away, 'archived').cards.map((c) => c.key)).toContain('issue:19072');
    expect(nextMemory(away, memory, true).placements).toEqual({});
  });

  it('drops it even when the session read failed — archiving took a status read of its own', () => {
    const memory = remember({ 'issue:19072': 'icebox' });
    const away = lanes(restatus(19072, '🏃 Testing'), [], memory);

    expect(nextMemory(away, memory, false).placements).toEqual({});
  });

  it('preserves placement while an active session prevents archiving', () => {
    const live: Session = { ...sessions[0]!, issueNumber: 19072, repository: 'github.com/example-org/example-repo', finished: false };
    const memory = remember({ 'issue:19072': 'icebox' });
    const held = lanes(restatus(19072, '🏃 Testing'), [live], memory);

    expect(issueIn(held, 19072)).toBe('icebox');
    expect(nextMemory(held, memory, true).placements).toEqual({ 'issue:19072': 'icebox' });
  });

  it('brings a returned card back on its own signals rather than the lane it left in', () => {
    const memory = remember({ 'issue:19072': 'icebox' });
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

  it('arrives a ⚒️ Dev card in Build — the tracker says the work is in development', () => {
    expect(DEFAULT_STATUS_LANES['⚒️ Dev']).toBe('build');
    expect(issueIn(lanes(restatus(19072, '⚒️ Dev'), []), 19072)).toBe('build');
  });

  it('leaves a status that carries no lane in Unstarted', () => {
    expect(issueIn(lanes(restatus(19072, '⚒️ Dev'), [], remember(), { statusLanes: {} }), 19072)).toBe('unstarted');
  });

  // A Build status overrides an open PR whose review state may not reflect reassigned work.
  it('keeps a ⚒️ Dev card in Build however its own open pull request was reviewed', () => {
    for (const reviewDecision of [null, 'REVIEW_REQUIRED', 'APPROVED']) {
      const cards = withPr(19072, { reviewDecision }, restatus(19072, '⚒️ Dev'));

      expect(issueIn(lanes(cards, [], remember(), { logins: ['dev-1'] }), 19072)).toBe('build');
    }
  });

  it('places own draft PRs in Build despite Review status', () => {
    const cards = withPr(19072, { isDraft: true }, restatus(19072, '🔍 Dev Review'));

    expect(issueIn(lanes(cards, [], remember(), { logins: ['dev-1'] }), 19072)).toBe('build');
  });

  it('maps Assigned and unmapped statuses to the same arrival lane', () => {
    // The explicit status mapping affects triage without changing arrival lanes (R38).
    expect(DEFAULT_STATUS_LANES['🎁 Assigned']).toBe('unstarted');
    expect(issueIn(lanes(restatus(19072, '🎁 Assigned'), []), 19072)).toBe('unstarted');
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

  it('places own PRs with requested changes in Build', () => {
    const cards = withPr(19072, { reviewDecision: 'CHANGES_REQUESTED' }, restatus(19072, '🔍 Dev Review'));

    expect(issueIn(lanes(cards, [], remember(), { logins: ['dev-1'] }), 19072)).toBe('build');
  });

  /**
   * A lane no lane list holds would drop the card out of every lane at once, which is a worse R8 break than a
   * wrong lane.
   */
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

  it('marks a working agent as running, under both of the marks R6 draws', () => {
    expect(attentionOf([withPhase('running')], 'build')).toBe('running');
    expect(attentionOf([withPhase('running'), withPhase('idle')], 'build')).toBe('your-turn');
    expect(attentionOf([withPhase('running'), withPhase('waiting')], 'build')).toBe('blocked');
  });

  it('reads a finished agent as working no more than it reads one as blocked', () => {
    expect(attentionOf([withPhase('running', { finished: true })], 'build')).toBeNull();
  });

  it.each(['icebox', 'archived'] as const)('marks nothing on a working agent in %s', (id) => {
    expect(attentionOf([withPhase('running')], id)).toBeNull();
  });

  it('asks nothing when nothing was reported at all — R24 forbids guessing a phase', () => {
    expect(attentionOf([{ ...sessions[0]!, activity: null }], 'build')).toBeNull();
    expect(attentionOf([], 'build')).toBeNull();
  });

  it('asks nothing for a finished agent whose last event was a prompt — it is not blocked on anybody', () => {
    expect(attentionOf([withPhase('waiting', { finished: true })], 'build')).toBeNull();
    expect(attentionOf([withPhase('waiting', { finished: false })], 'build')).toBe('blocked');
  });

  it('reads blocked over a finished turn when one card carries both', () => {
    expect(attentionOf([withPhase('idle'), withPhase('waiting')], 'build')).toBe('blocked');
  });

  it('reads a failed turn over every other mark on the card', () => {
    expect(attentionOf([withPhase('failed')], 'build')).toBe('failed');
    expect(attentionOf([withPhase('waiting'), withPhase('failed')], 'build')).toBe('failed');
    expect(attentionOf([withPhase('running'), withPhase('idle'), withPhase('failed')], 'build')).toBe('failed');
    expect(attentionOf([withPhase('waiting')], 'build', { phase: 'failed', event: 'StopFailure', at: 1 })).toBe('failed');
  });

  it('reads a finished agent as failed no more than it reads one as blocked', () => {
    expect(attentionOf([withPhase('failed', { finished: true })], 'build')).toBeNull();
  });

  it.each(['icebox', 'archived'] as const)('asks nothing of a failed turn in %s, and blocked still shows there', (id) => {
    expect(attentionOf([withPhase('failed')], id)).toBeNull();
    expect(attentionOf([withPhase('failed'), withPhase('waiting')], id)).toBe('blocked');
  });

  it.each(['unstarted', 'plan', 'build', 'review'] as const)('asks for the developer in %s', (id) => {
    expect(attentionOf([withPhase('idle')], id)).toBe('your-turn');
  });

  it.each(['icebox', 'archived'] as const)('asks nothing of a finished turn in %s', (id) => {
    expect(attentionOf([withPhase('idle')], id)).toBeNull();
  });

  it.each(['icebox', 'archived'] as const)('still asks for the developer in %s when an agent is blocked', (id) => {
    expect(attentionOf([withPhase('waiting')], id)).toBe('blocked');
  });
});

describe('the attention on a card', () => {
  it('carries the mark assignLanes derived', () => {
    const board = lanes(issues, [withPhase('idle', { issueNumber: 18954 })]);

    expect(cardFor(board, 18954)?.attention).toBe('your-turn');
  });

  it('asks nothing on a card the developer parked in Icebox', () => {
    const live = withPhase('idle', { issueNumber: 18954 });
    const board = lanes(issues, [live], remember({ 'issue:18954': 'icebox' }));

    expect(cardFor(board, 18954)?.lane).toBe('icebox');
    expect(cardFor(board, 18954)?.attention).toBeNull();
  });

  it('asks nothing on an archived card whose agent finished', () => {
    const finished = withPhase('idle', { issueNumber: 19072, finished: true });
    const board = lanes(restatus(19072, '🏃 Testing'), [finished]);

    expect(cardFor(board, 19072)?.lane).toBe('archived');
    expect(cardFor(board, 19072)?.attention).toBeNull();
  });

  it('still asks for the developer on a card an archiving status only held by a blocked agent', () => {
    const blocked = withPhase('waiting', { issueNumber: 19072, finished: false });
    const board = lanes(restatus(19072, '🏃 Testing'), [blocked]);

    expect(cardFor(board, 19072)?.lane).toBe('unstarted');
    expect(cardFor(board, 19072)?.attention).toBe('blocked');
  });

  /** Use literal expectations so the assertion is independent of attentionOf. */
  it('marks the recorded board exactly where a session reported a phase that asks something', () => {
    expect(sessions.some((s) => s.activity === null)).toBe(true);
    expect(sessions.some((s) => s.activity !== null)).toBe(true);

    const marked = board
      .flatMap((l) => l.cards)
      .filter((c) => c.sessions.length > 0)
      .map((c) => [c.key, c.attention]);

    expect(marked).toEqual([
      ['issue:19072', 'your-turn'],
      ['session:github.com/example-org/project-1#main', null],
      ['session:github.com/example-org/project-2#main', 'your-turn'],
      ['session:github.com/example-org/project-3#main', 'your-turn'],
      ['session:github.com/example-org/project-4#main', null],
      // Last because Archived is: 19357 is nobody's assignment, and a finished turn asks nothing there (R6).
      ['issue:19357', null],
    ]);
  });

  it('asks nothing of a card whose sessions all reported no phase', () => {
    const silent = board.flatMap((l) => l.cards).filter((c) => c.sessions.every((s) => s.activity === null));

    expect(silent.length).toBeGreaterThan(0);
    expect(silent.every((c) => c.attention === null)).toBe(true);
  });
});
