import { describe, expect, it } from 'vitest';
import { DEFAULT_CUSTODY } from '@ground-control/core';
import type { CustodyEvent, CustodyHistory, CustodySettings } from '@ground-control/core';
import { buildCustody, duration, isBot, legsOf, statusLabel } from '../src/custody.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const T0 = Date.parse('2026-08-12T12:35:00Z');

function at(ms: number): string {
  return new Date(T0 + ms).toISOString();
}

function move(ms: number, actor: string | null, to: string | null, from: string | null = null, automated = false): CustodyEvent {
  return { at: at(ms), actor, automated, status: { from, to }, assigned: null, unassigned: null };
}

function assign(ms: number, actor: string | null, login: string): CustodyEvent {
  return { at: at(ms), actor, automated: false, status: null, assigned: login, unassigned: null };
}

function unassign(ms: number, actor: string | null, login: string): CustodyEvent {
  return { at: at(ms), actor, automated: false, status: null, assigned: null, unassigned: login };
}

function history(events: CustodyEvent[], over: Partial<CustodyHistory> = {}): CustodyHistory {
  return {
    number: 18845,
    title: 'Owner statements omit the cleaning fee',
    url: 'https://github.com/example-org/example-repo/issues/18845',
    state: 'OPEN',
    createdAt: at(0),
    closedAt: null,
    closedBy: null,
    events,
    truncated: false,
    ...over,
  };
}

/**
 * The #18845 worked example: eight legs from a New → Assigned → Dev → Ready → Dev (bot bounce) → Ready → Testing →
 * Testing hand-off chain. The bot bounce lasts seven minutes and folds away.
 */
const WORKED: CustodyEvent[] = [
  move(0, 'github-project-automation[bot]', '🆕 New', null, true),
  move(8.2 * DAY, 'lead', '🎁 Assigned', '🆕 New'),
  assign(8.2 * DAY + 1000, 'lead', 'dev-1'),
  move(14.6 * DAY, 'dev-1', '⚒️ Dev', '🎁 Assigned'),
  move(14.6 * DAY + 1.6 * HOUR, 'dev-1', '👟 Ready For Testing', '⚒️ Dev'),
  unassign(14.6 * DAY + 1.6 * HOUR + 1000, 'dev-1', 'dev-1'),
  move(14.6 * DAY + 1.7 * HOUR, 'ownerrez-gh-actions', '⚒️ Dev', '👟 Ready For Testing', true),
  assign(14.6 * DAY + 1.7 * HOUR + 1000, 'ownerrez-gh-actions', 'dev-1'),
  move(14.6 * DAY + 1.8 * HOUR, 'dev-1', '👟 Ready For Testing', '⚒️ Dev'),
  unassign(14.6 * DAY + 1.8 * HOUR + 1000, 'dev-1', 'dev-1'),
  move(22.4 * DAY, 'qa-lead', '🏃 Testing', '👟 Ready For Testing'),
  assign(22.4 * DAY + 1000, 'qa-lead', 'qa-1'),
  assign(26.1 * DAY, 'qa-1', 'qa-2'),
  unassign(26.1 * DAY + 1000, 'qa-1', 'qa-1'),
];

const NOW = T0 + 30 * DAY;

describe('legsOf', () => {
  it('folds status and assignment by one actor within a minute into one hand-off', () => {
    const legs = legsOf(history(WORKED), DEFAULT_CUSTODY, NOW);

    expect(legs.map((leg) => [leg.status, leg.assignees])).toEqual([
      ['🆕 New', []],
      ['🎁 Assigned', ['dev-1']],
      ['⚒️ Dev', ['dev-1']],
      ['👟 Ready For Testing', []],
      ['🏃 Testing', ['qa-1']],
      ['🏃 Testing', ['qa-2']],
    ]);
  });

  it('drops the six-minute send and the automated bounce into the Dev leg before them, so Ready starts at the second send', () => {
    const legs = legsOf(history(WORKED), DEFAULT_CUSTODY, NOW);
    const dev = legs[2];
    const ready = legs[3];

    expect(dev && dev.end - dev.start).toBeCloseTo(1.8 * HOUR, -3);
    expect(ready?.status).toBe('👟 Ready For Testing');
    expect(ready && ready.end - ready.start).toBeCloseTo(22.4 * DAY - (14.6 * DAY + 1.8 * HOUR), -3);
    // Only the New leg, written by project automation at creation, is automated once the bounce is gone.
    expect(legs.filter((leg) => leg.automated).map((leg) => leg.status)).toEqual(['🆕 New']);
  });

  it('does not fold two actors within a minute: a bot status write and a person assigning are two hand-offs', () => {
    const legs = legsOf(
      history([move(DAY, 'github-actions', '🎁 Assigned', '🆕 New', true), assign(DAY + 30_000, 'lead', 'dev-1'), move(3 * DAY, 'dev-1', '⚒️ Dev', '🎁 Assigned')]),
      DEFAULT_CUSTODY,
      NOW,
    );

    // The 30-second unassigned Assigned leg folds into the leg before it.
    expect(legs.map((leg) => [leg.status, leg.assignees, leg.automated])).toEqual([
      [null, [], false],
      ['🎁 Assigned', ['dev-1'], false],
      ['⚒️ Dev', ['dev-1'], false],
    ]);
  });

  it('moves the start of the next leg back when the first leg is the short one', () => {
    const legs = legsOf(history([assign(5_000, 'reporter', 'dev-1'), move(2 * DAY, 'dev-1', '⚒️ Dev', null)]), DEFAULT_CUSTODY, NOW);

    expect(legs[0]).toMatchObject({ status: null, assignees: ['dev-1'], start: T0 });
    expect(legs).toHaveLength(2);
  });

  it('keeps a short current leg', () => {
    const legs = legsOf(history([move(DAY, 'lead', '⚒️ Dev', '🆕 New')]), DEFAULT_CUSTODY, T0 + DAY + 2 * MINUTE);

    expect(legs.map((leg) => leg.status)).toEqual([null, '⚒️ Dev']);
  });

  it('closes the last leg at the close time of a closed issue and at now otherwise', () => {
    const closed = legsOf(history([], { state: 'CLOSED', closedAt: at(3 * DAY) }), DEFAULT_CUSTODY, NOW);
    const open = legsOf(history([]), DEFAULT_CUSTODY, NOW);

    expect(closed[0]?.end).toBe(T0 + 3 * DAY);
    expect(open[0]?.end).toBe(NOW);
  });

  it('ignores a status moved after the close: a closed issue has no life left to spend', () => {
    const events = [move(DAY, 'lead', '🚀 Releasable', '🆕 New'), move(5 * DAY, 'lead', '⚒️ Dev', '🚀 Releasable'), assign(5 * DAY + 100, 'lead', 'dev-1')];
    const legs = legsOf(history(events, { state: 'CLOSED', closedAt: at(2 * DAY) }), DEFAULT_CUSTODY, NOW);

    expect(legs.map((leg) => [leg.status, leg.end])).toEqual([
      [null, T0 + DAY],
      ['🚀 Releasable', T0 + 2 * DAY],
    ]);
  });

  it('cascades two leading short legs into the first kept one and merges a leg that returns to the same state', () => {
    const events = [
      assign(30_000, 'reporter', 'dev-1'),
      move(5 * MINUTE, 'reporter', '🆕 New', null),
      move(DAY, 'ownerrez-gh-actions', '⚒️ Dev', '🆕 New', true),
      move(DAY + 5 * MINUTE, 'lead', '🆕 New', '⚒️ Dev'),
    ];
    const legs = legsOf(history(events), DEFAULT_CUSTODY, T0 + 2 * DAY);

    expect(legs.map((leg) => [leg.status, leg.assignees, leg.start, leg.end])).toEqual([['🆕 New', ['dev-1'], T0, T0 + 2 * DAY]]);
  });

  it('ignores undated events and orders the rest by time', () => {
    const legs = legsOf(
      history([move(2 * DAY, 'lead', '⚒️ Dev', '🎁 Assigned'), { ...move(DAY, 'lead', '🎁 Assigned', '🆕 New'), at: 'never' }, move(DAY, 'lead', '🎁 Assigned', '🆕 New')]),
      DEFAULT_CUSTODY,
      NOW,
    );

    expect(legs.map((leg) => leg.status)).toEqual([null, '🎁 Assigned', '⚒️ Dev']);
  });
});

describe('buildCustody health', () => {
  it('names a stall by status and duration when a leg passes its stage floor, and never names a person', () => {
    const custody = buildCustody(history(WORKED), DEFAULT_CUSTODY, NOW);

    expect(custody.health).toMatchObject({ headline: 'Stalled 8.2d in New', bad: true });
    expect(custody.health.subline).toBe('It spent 8.2d in New with nobody assigned, 27% of its life.');
    expect(custody.health.subline).not.toContain('dev-1');
  });

  it('uses the stage floor, not a share of life: a short healthy issue is moving normally', () => {
    const custody = buildCustody(history([move(DAY, 'lead', '⚒️ Dev', '🆕 New'), assign(DAY + 500, 'lead', 'dev-1')]), DEFAULT_CUSTODY, T0 + 3 * DAY);

    expect(custody.health.headline).toBe('Moving normally');
    expect(custody.health.subline).toBe('Longest hold was 2.0d in Dev, 67% of its life.');
  });

  it('forces moving normally under an hour old, unless the issue is already closed', () => {
    const settings: CustodySettings = { ...DEFAULT_CUSTODY, stages: [{ status: '🆕 New', function: 'intake', stallDays: 0 }] };
    const custody = buildCustody(history([]), settings, T0 + 30 * MINUTE);
    const closed = buildCustody(history([], { state: 'CLOSED', closedAt: at(20 * MINUTE) }), settings, T0 + 30 * MINUTE);

    expect(custody.health.headline).toBe('Moving normally');
    expect(custody.age).toBe('30m');
    expect(closed.health.headline).toBe('Closed after 20m');
  });

  it('counts human send-backs toward the headline and shows automated ones beside the figure', () => {
    const events = [
      move(DAY, 'dev-1', '⚒️ Dev', '🆕 New'),
      move(2 * DAY, 'dev-1', '🔍 Dev Review', '⚒️ Dev'),
      move(3 * DAY, 'reviewer', '⚒️ Dev', '🔍 Dev Review'),
      move(4 * DAY, 'dev-1', '🔍 Dev Review', '⚒️ Dev'),
      move(5 * DAY, 'orez-codebot', '⚒️ Dev', '🔍 Dev Review'),
      move(6 * DAY, 'dev-1', '🔍 Dev Review', '⚒️ Dev'),
      move(7 * DAY, 'reviewer', '⚒️ Dev', '🔍 Dev Review'),
    ];
    const custody = buildCustody(history(events), DEFAULT_CUSTODY, T0 + 8 * DAY);

    expect(custody.health.headline).toBe('Sent back 2 times');
    expect(custody.health.figures.find((figure) => figure.label === 'Sent back')).toEqual({ label: 'Sent back', value: '2 +1 auto', bad: true });
  });

  it('reads a closed issue as closed unless it stalled', () => {
    const closed = { state: 'CLOSED', closedAt: at(1.5 * DAY), closedBy: 'lead' };
    const quick = buildCustody(history([move(DAY, 'lead', '🚀 Releasable', '🆕 New')], closed), DEFAULT_CUSTODY, NOW);
    const stalled = buildCustody(history([move(DAY, 'lead', '🚀 Releasable', '🆕 New')], { ...closed, closedAt: at(4 * DAY) }), DEFAULT_CUSTODY, NOW);

    expect(quick.health).toMatchObject({ headline: 'Closed after 1.5d', bad: false });
    expect(quick.endLabel).toBe('closed');
    expect(stalled.health.headline).toBe('Stalled 3.0d in Releasable');
  });

  it('reads an unassigned current leg past three days as unowned', () => {
    const custody = buildCustody(
      history([move(DAY, 'lead', '🎁 Assigned', '🆕 New'), assign(DAY + 500, 'lead', 'dev-1'), unassign(2 * DAY, 'dev-1', 'dev-1')]),
      { ...DEFAULT_CUSTODY, stages: DEFAULT_CUSTODY.stages.map((stage) => ({ ...stage, stallDays: 30 })) },
      T0 + 6 * DAY,
    );

    expect(custody.health).toMatchObject({ headline: 'Unowned for 4.0d', bad: true });
    expect(custody.health.now).toEqual({ label: 'Assigned', function: 'dev', holder: 'unassigned', held: false, since: '4.0d' });
    expect(custody.health.figures.find((figure) => figure.label === 'Unassigned')).toEqual({ label: 'Unassigned', value: '83%', bad: true });
  });

  it('counts hand-offs, people, and the now strip with two assignees', () => {
    const custody = buildCustody(history(WORKED), DEFAULT_CUSTODY, NOW);

    expect(custody.health.figures.map((figure) => [figure.label, figure.value, figure.bad])).toEqual([
      ['Hand-offs', '5', false],
      ['People', '3', false],
      ['Sent back', '0', false],
      ['Unassigned', '53%', true],
    ]);
    expect(custody.health.now).toMatchObject({ label: 'Testing', holder: 'qa-2', held: true });

    const pair = buildCustody(history([assign(DAY, 'lead', 'dev-1'), assign(DAY + 100, 'lead', 'dev-2')]), DEFAULT_CUSTODY, NOW);

    expect(pair.health.now.holder).toBe('dev-1 + dev-2');
    expect(pair.health.figures[1]?.value).toBe('2');
  });

  it('labels the bar ends with the creation date, adding the year when the life spans two', () => {
    expect(buildCustody(history([]), DEFAULT_CUSTODY, NOW).createdLabel).toBe('Aug 12');
    expect(buildCustody(history([]), DEFAULT_CUSTODY, T0 + 150 * DAY).createdLabel).toBe('Aug 12 2026');
    expect(buildCustody(history([], { state: 'CLOSED', closedAt: at(DAY) }), DEFAULT_CUSTODY, T0 + 150 * DAY).endLabel).toBe('closed');
  });

  it('renders an issue off the board as one no-status leg', () => {
    const custody = buildCustody(history([]), DEFAULT_CUSTODY, T0 + 2 * DAY);

    expect(custody.bar).toEqual([{ label: 'no status', function: null, held: false, share: 1, title: 'no status · unassigned · 2.0d' }]);
    expect(custody.health.now.label).toBe('no status');
    expect(custody.route).toEqual([{ labels: ['no status'], functions: [null], rounds: 0, holders: 'unassigned', duration: '2.0d', current: true, folded: 0 }]);
  });

  it('ranks a renamed status nowhere: it renders and never counts as a send-back', () => {
    const custody = buildCustody(history([move(DAY, 'lead', '🧪 Old QA', '🏃 Testing'), move(2 * DAY, 'lead', '⚒️ Dev', '🧪 Old QA')]), DEFAULT_CUSTODY, NOW);

    expect(custody.bar[1]).toMatchObject({ label: 'Old QA', function: null });
    expect(custody.health.figures[2]?.value).toBe('0');
  });
});

describe('buildCustody time', () => {
  it('ranks the four longest legs against the top one and totals per status against life', () => {
    const custody = buildCustody(history(WORKED), DEFAULT_CUSTODY, NOW);

    expect(custody.time.longest.map((row) => [row.label, row.holder, row.duration, row.bad])).toEqual([
      ['New', null, '8.2d', true],
      ['Ready For Testing', null, '7.7d', true],
      ['Assigned', 'dev-1', '6.4d', false],
      ['Testing', 'qa-2', '3.9d', false],
    ]);
    expect(custody.time.longest[0]?.share).toBe(1);
    expect(custody.time.longest[2]?.share).toBeCloseTo(6.4 / 8.2, 2);
    expect(custody.time.totals.map((row) => [row.label, row.duration])).toEqual([
      ['New', '8.2d'],
      ['Ready For Testing', '7.7d'],
      ['Testing', '7.6d'],
      ['Assigned', '6.4d'],
      ['Dev', '1.8h'],
    ]);
    expect(custody.time.totals[0]?.share).toBeCloseTo(8.2 / 30, 2);
  });

  it('shows what exists when fewer than four legs exist', () => {
    const custody = buildCustody(history([]), DEFAULT_CUSTODY, T0 + HOUR);

    expect(custody.time.longest).toHaveLength(1);
    expect(custody.time.totals).toEqual([{ label: 'no status', function: null, duration: '1.0h', share: 1 }]);
  });
});

describe('buildCustody route', () => {
  it('folds an alternation of two statuses into one loop stop with holders on the side they held longer', () => {
    const events = [
      move(DAY, 'lead', '👟 Ready For Testing', '🆕 New'),
      assign(DAY + 500, 'lead', 'qa-1'),
      move(2 * DAY, 'qa-1', '🏃 Testing', '👟 Ready For Testing'),
      move(3 * DAY, 'qa-1', '⚒️ Dev', '🏃 Testing'),
      unassign(3 * DAY + 500, 'qa-1', 'qa-1'),
      assign(3 * DAY + 600, 'qa-1', 'dev-1'),
      move(3.5 * DAY, 'dev-1', '🏃 Testing', '⚒️ Dev'),
      unassign(3.5 * DAY + 500, 'dev-1', 'dev-1'),
      assign(3.5 * DAY + 600, 'dev-1', 'qa-1'),
      move(4 * DAY, 'qa-1', '⚒️ Dev', '🏃 Testing'),
      unassign(4 * DAY + 500, 'qa-1', 'qa-1'),
      assign(4 * DAY + 600, 'qa-1', 'dev-1'),
      move(4.2 * DAY, 'dev-1', '🏃 Testing', '⚒️ Dev'),
      unassign(4.2 * DAY + 500, 'dev-1', 'dev-1'),
      assign(4.2 * DAY + 600, 'dev-1', 'qa-1'),
      move(5 * DAY, 'qa-1', '👟 Ready For Testing', '🏃 Testing'),
      move(5.5 * DAY, 'qa-1', '🏃 Testing', '👟 Ready For Testing'),
    ];
    const custody = buildCustody(history(events), DEFAULT_CUSTODY, T0 + 6 * DAY);

    expect(custody.route.map((stop) => [stop.labels, stop.rounds, stop.holders, stop.current])).toEqual([
      [['no status'], 0, 'unassigned', false],
      [['Ready For Testing'], 0, 'qa-1', false],
      [['Testing', 'Dev'], 2, 'qa-1 with dev-1', false],
      [['Ready For Testing'], 0, 'qa-1', false],
      [['Testing'], 0, 'qa-1', true],
    ]);
    expect(custody.route[2]?.functions).toEqual(['qa', 'dev']);
    expect(custody.route[2]?.duration).toBe('3.0d');
  });

  it('words a loop held on one side only as alone', () => {
    const events = [
      move(DAY, 'dev-1', '⚒️ Dev', '🆕 New'),
      assign(DAY + 500, 'dev-1', 'dev-1'),
      move(2 * DAY, 'dev-1', '🔍 Dev Review', '⚒️ Dev'),
      move(3 * DAY, 'reviewer', '⚒️ Dev', '🔍 Dev Review'),
      move(4 * DAY, 'dev-1', '🔍 Dev Review', '⚒️ Dev'),
    ];
    const custody = buildCustody(history(events), DEFAULT_CUSTODY, T0 + 5 * DAY);

    expect(custody.route[1]).toMatchObject({ labels: ['Dev', 'Dev Review'], rounds: 1, holders: 'dev-1 alone', current: true });
  });

  it('extends a stop across an assignment change inside one status and excludes bots from holders and people', () => {
    const events = [move(DAY, 'lead', '⚒️ Dev', '🆕 New'), assign(DAY + 500, 'lead', 'dev-1'), assign(3 * DAY, 'dev-1', 'orez-codebot'), assign(4 * DAY, 'dev-1', 'dev-2')];
    const custody = buildCustody(history(events), DEFAULT_CUSTODY, T0 + 5 * DAY);

    expect(custody.route[1]).toMatchObject({ labels: ['Dev'], holders: 'dev-1, dev-2', duration: '4.0d' });
    expect(custody.health.figures[1]).toEqual({ label: 'People', value: '2', bad: false });
  });

  it('names the closer of a closed issue nobody holds', () => {
    const events = [move(DAY, 'lead', '🚀 Releasable', '🆕 New')];
    const custody = buildCustody(history(events, { state: 'CLOSED', closedAt: at(2 * DAY), closedBy: 'qa-lead' }), DEFAULT_CUSTODY, NOW);

    expect(custody.route[1]).toMatchObject({ labels: ['Releasable'], holders: 'closed by qa-lead', current: true });
  });

  it('keeps the first three and last four stops past eight and folds the middle into one row', () => {
    const statuses = DEFAULT_CUSTODY.stages.map((stage) => stage.status);
    const events: CustodyEvent[] = [];

    // Twelve stops: no status, the nine statuses, then back to Dev and Testing.
    [...statuses, '⚒️ Dev', '🏃 Testing'].forEach((status, index) => {
      events.push(move((index + 1) * DAY, 'lead', status, null));
      events.push(assign((index + 1) * DAY + 500, 'lead', `person-${index}`));

      if (index > 0) {
        events.push(unassign((index + 1) * DAY + 600, 'lead', `person-${index - 1}`));
      }
    });

    const custody = buildCustody(history(events), DEFAULT_CUSTODY, T0 + 13 * DAY);
    const labels = custody.route.map((stop) => stop.labels[0]);

    expect(labels).toEqual(['no status', 'New', 'Planned', '5 more stops', 'Testing', 'Releasable', 'Dev', 'Testing']);
    expect(custody.route[3]).toMatchObject({ folded: 5, duration: '5.0d', holders: 'person-2, person-3, person-4, person-5, person-6' });
    expect(custody.route[7]?.current).toBe(true);
  });
});

describe('helpers', () => {
  it('formats durations by the unit the reader scans for', () => {
    expect(duration(-5)).toBe('0m');
    expect(duration(25 * MINUTE)).toBe('25m');
    expect(duration(1.6 * HOUR)).toBe('1.6h');
    expect(duration(13 * HOUR)).toBe('13h');
    expect(duration(8.24 * DAY)).toBe('8.2d');
    expect(duration(110.9 * DAY)).toBe('110d');
  });

  it('strips the pictogram from a status and names a missing one', () => {
    expect(statusLabel('🎯 Product Review')).toBe('Product Review');
    expect(statusLabel('⚒️ Dev')).toBe('Dev');
    expect(statusLabel(null)).toBe('no status');
  });

  it('treats configured logins and any [bot] suffix as machines, case-insensitively', () => {
    const settings: CustodySettings = { stages: [], bots: ['Orez-CodeBot'] };

    expect(isBot('orez-codebot', settings)).toBe(true);
    expect(isBot('dependabot[bot]', settings)).toBe(true);
    expect(isBot('dev-1', settings)).toBe(false);
    expect(isBot(null, settings)).toBe(false);
  });
});
