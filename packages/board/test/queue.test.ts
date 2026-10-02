import { describe, expect, it } from 'vitest';
import { LANE_ORDER, LANE_TITLES } from '@ground-control/core';
import type { ActionHistoryEntry, CardAction, Lane, LaneId, LanedCard, Session } from '@ground-control/core';
import { EMPTY_VISITS, ENDED_VISIT_LIMIT, nextVisits, queueSectionOf, queueView, readVisits, withAcknowledged, withoutPlacement, EMPTY_MEMORY } from '../src/index.js';
import type { EndedVisit, VisitMemory } from '../src/index.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

function issueCard(number: number, over: Partial<LanedCard> = {}): LanedCard {
  return {
    key: `issue:${number}`,
    issueNumber: number,
    issue: {
      number,
      title: `Issue ${number}`,
      repository: 'example-org/example-repo',
      type: null,
      typeColor: null,
      url: `https://github.com/example-org/example-repo/issues/${number}`,
      status: '⚒️ Dev',
      statusColor: null,
      statusChangedAt: null,
      queuedAt: null,
      assignees: ['dev-1'],
      avatar: null,
      pullRequest: null,
      updatedAt: '2026-09-01T00:00:00Z',
    },
    sessions: [],
    lane: 'build',
    returned: false,
    attention: null,
    reason: '⚒️ Dev',
    ...over,
  };
}

function live(phase: 'running' | 'waiting' | 'idle' | 'failed'): Session {
  return {
    agent: 'claude', sessionId: `s-${phase}`, pid: 1, title: null, cwd: 'c:/w', checkoutRoot: 'c:/w', startedAt: 1, branch: null,
    repository: null, issueNumber: null, transcriptWrittenAt: null, finished: false, attachId: null, details: {},
    activity: { phase, since: 1, at: 1 } as Session['activity'],
  };
}

function lanesOf(...cards: LanedCard[]): Lane[] {
  return LANE_ORDER.map((id: LaneId) => ({ id, title: LANE_TITLES[id], cards: cards.filter((card) => card.lane === id) }));
}

const done = (outcome: 'completed' | 'awaiting-approval' | 'blocked' | 'failed' | 'stopped', at = NOW - 1000): CardAction =>
  ({ state: 'done', action: 'develop', qualifier: null, outcome, detail: '', at });

describe('queueSectionOf', () => {
  it.each([
    ['a failed session', { attention: 'failed' as const }],
    ['a session that needs the developer', { attention: 'blocked' as const }],
    ['a turn that ended with its session open', { attention: 'your-turn' as const }],
    ['a completed run', { action: done('completed') }],
    ['a run awaiting approval', { action: done('awaiting-approval') }],
    ['a blocked run', { action: done('blocked') }],
    ['a run that did not run', { action: done('failed') }],
    ['a stopped run', { action: done('stopped') }],
    ['a run whose session asked a question', { action: { state: 'running', action: 'develop', qualifier: null, since: 1, stage: 'waiting' } as CardAction }],
  ])('puts %s in Waiting for you', (_name, over) => {
    expect(queueSectionOf(issueCard(1, over))).toBe('waiting');
  });

  it('puts a card at the review stage in Waiting for you', () => {
    const stage = { stage: 'review' as const, note: '', at: 1, changedAt: 1, since: 1, history: [] };

    expect(queueSectionOf(issueCard(1, { stage }))).toBe('waiting');
    expect(queueSectionOf(issueCard(1, { stage: { ...stage, stage: 'build' } }))).toBe('unstarted');
  });

  it('keeps a waiting card in Waiting for you while another session works on it', () => {
    expect(queueSectionOf(issueCard(1, { attention: 'blocked', sessions: [live('waiting'), live('running')] }))).toBe('waiting');
  });

  it('puts a running action, worktree run, or working session in Working', () => {
    expect(queueSectionOf(issueCard(1, { action: { state: 'running', action: 'develop', qualifier: null, since: 1 } }))).toBe('working');
    expect(queueSectionOf(issueCard(1, { creation: { state: 'running', since: 1 } }))).toBe('working');
    expect(queueSectionOf(issueCard(1, { attention: 'running', sessions: [live('running')] }))).toBe('working');
  });

  it('puts a triaged card with no run in Unstarted', () => {
    expect(queueSectionOf(issueCard(1, { action: { state: 'available', action: 'develop', qualifier: null } }))).toBe('unstarted');
    expect(queueSectionOf(issueCard(1))).toBe('unstarted');
  });

  it('lifts an iceboxed card only for Needs you', () => {
    expect(queueSectionOf(issueCard(1, { lane: 'icebox', attention: 'blocked' }))).toBe('waiting');
    expect(queueSectionOf(issueCard(1, { lane: 'icebox', action: done('completed') }))).toBe('icebox');
    expect(queueSectionOf(issueCard(1, { lane: 'icebox' }))).toBe('icebox');
  });

  it('lists neither ad-hoc nor archived cards', () => {
    expect(queueSectionOf(issueCard(1, { lane: 'archived', attention: 'blocked' }))).toBeNull();
    expect(queueSectionOf({ ...issueCard(1), key: 'session:x', issue: null, issueNumber: null })).toBeNull();
  });
});

describe('nextVisits', () => {
  it('starts a visit on arrival and records whether it waited', () => {
    const first = nextVisits(lanesOf(issueCard(1)), EMPTY_VISITS, true, NOW, 7, []);

    expect(first.open['issue:1']).toMatchObject({ startedAt: NOW, section: 'unstarted', since: NOW, waited: false });

    const later = nextVisits(lanesOf(issueCard(1, { attention: 'blocked' })), first, true, NOW + 5000, 7, []);

    expect(later.open['issue:1']).toMatchObject({ startedAt: NOW, section: 'waiting', since: NOW + 5000, waited: true });

    const after = nextVisits(lanesOf(issueCard(1)), later, true, NOW + 9000, 7, []);

    expect(after.open['issue:1']).toMatchObject({ section: 'unstarted', since: NOW + 9000, waited: true });
  });

  it('keeps the time a card entered its section while it stays there', () => {
    const first = nextVisits(lanesOf(issueCard(1, { attention: 'blocked' })), EMPTY_VISITS, true, NOW, 7, []);
    const again = nextVisits(lanesOf(issueCard(1, { attention: 'failed' })), first, true, NOW + 60_000, 7, []);

    expect(again.open['issue:1']?.since).toBe(NOW);
  });

  it('dates a section from the run that put the card there', () => {
    const running = nextVisits(lanesOf(issueCard(1, { action: { state: 'running', action: 'develop', qualifier: null, since: NOW - 300 } })), EMPTY_VISITS, true, NOW, 7, []);
    const finished = nextVisits(lanesOf(issueCard(1, { action: done('completed', NOW - 200) })), EMPTY_VISITS, true, NOW, 7, []);
    const future = nextVisits(lanesOf(issueCard(1, { action: done('completed', NOW + 9000) })), EMPTY_VISITS, true, NOW, 7, []);

    expect(running.open['issue:1']?.since).toBe(NOW - 300);
    expect(finished.open['issue:1']?.since).toBe(NOW - 200);
    expect(future.open['issue:1']?.since).toBe(NOW);
  });

  it('ends a visit whose card was archived, saying how it left', () => {
    const open = nextVisits(lanesOf(issueCard(1), issueCard(2), issueCard(3)), EMPTY_VISITS, true, NOW, 7, []);
    const closed = issueCard(1, { lane: 'archived', issue: { ...issueCard(1).issue!, state: 'CLOSED' } });
    const unassigned = issueCard(2, { lane: 'archived', unassigned: true, issue: { ...issueCard(2).issue!, status: '🔍 Dev Review' } });
    const outside = issueCard(3, { lane: 'archived', issue: { ...issueCard(3).issue!, status: '🧪 Testing' } });
    const next = nextVisits(lanesOf(closed, unassigned, outside), open, true, NOW + 1000, 7, []);

    expect(next.open).toEqual({});
    expect(next.ended.map((visit) => [visit.id, visit.left, visit.endedAt])).toEqual([
      ['issue:1@' + NOW, 'Closed', NOW + 1000],
      ['issue:2@' + NOW, '🔍 Dev Review · unassigned', NOW + 1000],
      ['issue:3@' + NOW, '🧪 Testing', NOW + 1000],
    ]);
  });

  it('ends a visit whose card is archived as unassigned only after a complete read', () => {
    const open = nextVisits(lanesOf(issueCard(1)), EMPTY_VISITS, true, NOW, 7, []);
    const named = issueCard(1, { lane: 'archived', unassigned: true });

    expect(nextVisits(lanesOf(named), open, false, NOW + 1000, 7, [])).toEqual(open);
    expect(nextVisits(lanesOf(named), open, true, NOW + 1000, 7, []).ended.map((visit) => visit.left)).toEqual(['⚒️ Dev · unassigned']);
  });

  it('ends a visit whose card is gone only after a complete read', () => {
    const open = nextVisits(lanesOf(issueCard(1)), EMPTY_VISITS, true, NOW, 7, []);

    expect(nextVisits(lanesOf(), open, false, NOW + 1000, 7, [])).toEqual(open);

    const gone = nextVisits(lanesOf(), open, true, NOW + 1000, 7, []);

    expect(gone.open).toEqual({});
    expect(gone.ended).toEqual([expect.objectContaining({ key: 'issue:1', left: '⚒️ Dev · left your board', waited: false })]);
  });

  it('starts a new visit when a departed card returns', () => {
    const open = nextVisits(lanesOf(issueCard(1)), EMPTY_VISITS, true, NOW, 7, []);
    const gone = nextVisits(lanesOf(), open, true, NOW + 1000, 7, []);
    const back = nextVisits(lanesOf(issueCard(1)), gone, true, NOW + 2000, 7, []);

    expect(back.open['issue:1']?.startedAt).toBe(NOW + 2000);
    expect(back.ended).toHaveLength(1);
  });

  it('keeps an unattended visit until acknowledged and an attended one for doneDays', () => {
    const memory: VisitMemory = {
      open: {},
      ended: [
        { id: 'a', key: 'issue:1', issueNumber: 1, title: '', url: '', repository: null, startedAt: 0, endedAt: NOW - 30 * DAY, waited: false, left: '', runs: [] },
        { id: 'b', key: 'issue:2', issueNumber: 2, title: '', url: '', repository: null, startedAt: 0, endedAt: NOW - 6 * DAY, waited: true, left: '', runs: [] },
        { id: 'c', key: 'issue:3', issueNumber: 3, title: '', url: '', repository: null, startedAt: 0, endedAt: NOW - 7 * DAY, waited: true, left: '', runs: [] },
      ],
    };

    expect(nextVisits(lanesOf(), memory, true, NOW, 7, []).ended.map((visit) => visit.id)).toEqual(['a', 'b']);
    expect(withAcknowledged(memory, 'a').ended.map((visit) => visit.id)).toEqual(['b', 'c']);
    expect(withAcknowledged(memory, 'missing')).toBe(memory);
  });

  it('keeps every unattended visit, and at most ENDED_VISIT_LIMIT attended ones, newest first', () => {
    const many = (waited: boolean, prefix: string): EndedVisit[] => Array.from({ length: ENDED_VISIT_LIMIT }, (_, n) => ({
      id: `${prefix}-${n}`, key: `issue:${n}`, issueNumber: n, title: '', url: '', repository: null, startedAt: 0, endedAt: NOW - 1, waited, left: '', runs: [],
    }));
    const open = nextVisits(lanesOf(issueCard(9999, { attention: 'blocked' }), issueCard(9998)), { open: {}, ended: [...many(true, 'seen'), ...many(false, 'alone')] }, true, NOW, 7, []);
    const next = nextVisits(lanesOf(), open, true, NOW + 1, 7, []);
    const ids = next.ended.map((visit) => visit.id);

    expect(ids.filter((id) => id.startsWith('alone-'))).toHaveLength(ENDED_VISIT_LIMIT);
    expect(ids.filter((id) => id.startsWith('seen-') || id.startsWith('issue:9999'))).toHaveLength(ENDED_VISIT_LIMIT);
    expect(ids.slice(0, 2)).toEqual([`issue:9999@${NOW}`, `issue:9998@${NOW}`]);
    expect(ids).not.toContain(`seen-${ENDED_VISIT_LIMIT - 1}`);
  });

  it('dates a section the hub saw the card enter from that read, not from the run', () => {
    const run = { state: 'running', action: 'develop', qualifier: null, since: NOW - 300 } as const;
    const first = nextVisits(lanesOf(issueCard(1, { action: run })), EMPTY_VISITS, true, NOW, 7, []);
    const waited = nextVisits(lanesOf(issueCard(1, { action: run, attention: 'blocked' })), first, true, NOW + 100, 7, []);
    const back = nextVisits(lanesOf(issueCard(1, { action: run })), waited, true, NOW + 300, 7, []);

    expect(first.open['issue:1']?.since).toBe(NOW - 300);
    expect(back.open['issue:1']).toMatchObject({ section: 'working', since: NOW + 300 });
  });

  it('dates a new visit with a worktree run from that run', () => {
    const next = nextVisits(lanesOf(issueCard(1, { creation: { state: 'running', since: NOW - 700 } })), EMPTY_VISITS, true, NOW, 7, []);

    expect(next.open['issue:1']).toMatchObject({ section: 'working', since: NOW - 700 });
  });

  it('keeps the runs a visit started after the action history drops them', () => {
    const run = (key: string, action: ActionHistoryEntry['action'], startedAt: number): ActionHistoryEntry => ({
      id: `${key}@${startedAt}`, key, issueNumber: 1, action, qualifier: null, agent: 'claude', startedAt, endedAt: null, outcome: 'completed', detail: '',
    });
    const open = nextVisits(lanesOf(issueCard(1)), EMPTY_VISITS, true, NOW, 7, [run('issue:1', 'develop', NOW - 5)]);
    const ran = nextVisits(lanesOf(issueCard(1)), open, true, NOW + 10, 7, [run('issue:1', 'develop', NOW + 5), run('issue:2', 'merge', NOW + 6)]);
    const gone = nextVisits(lanesOf(), ran, true, NOW + 20, 7, [run('issue:1', 'ship', NOW + 15)]);

    expect(gone.ended[0]?.runs).toEqual([{ id: `issue:1@${NOW + 5}`, action: 'develop' }, { id: `issue:1@${NOW + 15}`, action: 'ship' }]);
    expect(queueView(lanesOf(), gone, NOW + 30).done[0]?.actions).toEqual(['develop', 'ship']);
  });
});

describe('readVisits', () => {
  it('drops unreadable entries one at a time', () => {
    const good = nextVisits(lanesOf(issueCard(1)), EMPTY_VISITS, true, NOW, 7, []);
    const read = readVisits({ open: { ...good.open, bad: { startedAt: 'x' } }, ended: [{ id: 1 }] });

    expect(read).toEqual({ open: good.open, ended: [] });
    expect(readVisits('nonsense')).toEqual({ open: {}, ended: [] });
  });
});

describe('queueView', () => {
  it('orders waiting and working cards longest first and unstarted ones by queue time', () => {
    const queued = (at: string) => ({ ...issueCard(0).issue!, queuedAt: at });
    const cards = [
      issueCard(1, { attention: 'blocked' }),
      issueCard(2, { action: done('completed', NOW - 50_000) }),
      issueCard(3, { lane: 'unstarted', issue: { ...queued('2026-09-03T00:00:00Z'), number: 3 } }),
      issueCard(4, { lane: 'plan', issue: { ...queued('2026-09-01T00:00:00Z'), number: 4 } }),
      issueCard(5, { action: { state: 'running', action: 'develop', qualifier: null, since: NOW - 10 } }),
      issueCard(6, { attention: 'blocked', sessions: [live('waiting'), live('running')] }),
      issueCard(7, { action: { state: 'running', action: 'develop', qualifier: null, since: NOW - 5000 } }),
      issueCard(8, { lane: 'icebox', issue: { ...queued('2026-09-02T00:00:00Z'), number: 8 } }),
      issueCard(9, { lane: 'icebox' }),
      issueCard(10, { lane: 'icebox', issue: { ...queued('2026-08-02T00:00:00Z'), number: 10 } }),
    ];
    const memory = nextVisits(lanesOf(...cards), EMPTY_VISITS, true, NOW - 1000, 7, []);
    const view = queueView(lanesOf(...cards), memory, NOW);

    expect(view.sections.map((section) => [section.id, section.cards.map((card) => card.key)])).toEqual([
      ['waiting', ['issue:2', 'issue:1', 'issue:6']],
      ['working', ['issue:7', 'issue:5']],
      ['unstarted', ['issue:4', 'issue:3']],
      ['icebox', ['issue:10', 'issue:8', 'issue:9']],
    ]);
    expect(view.sections[0]!.cards.map((card) => card.running)).toEqual([false, false, true]);
  });

  it('lists ended visits with the runs each started, oldest first', () => {
    const memory: VisitMemory = {
      open: {},
      ended: [{ id: 'issue:1@10', key: 'issue:1', issueNumber: 1, title: 'One', url: 'u', repository: 'o/r', startedAt: 10, endedAt: 100, waited: false, left: 'Closed', runs: [{ id: 'a', action: 'develop' }, { id: 'b', action: 'ship' }] }],
    };

    expect(queueView(lanesOf(), memory, NOW).done).toEqual([
      { id: 'issue:1@10', issueNumber: 1, title: 'One', url: 'u', repository: 'o/r', startedAt: 10, endedAt: 100, unattended: true, actions: ['develop', 'ship'], left: 'Closed' },
    ]);
  });
});

describe('withoutPlacement', () => {
  it('clears a manual lane and leaves memory alone where there is none', () => {
    const placed = { ...EMPTY_MEMORY, placements: { 'issue:1': 'icebox' as const } };

    expect(withoutPlacement(placed, 'issue:1').placements).toEqual({});
    expect(withoutPlacement(EMPTY_MEMORY, 'issue:1')).toBe(EMPTY_MEMORY);
  });
});
