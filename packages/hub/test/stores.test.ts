import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { groundControlDirOf } from '@ground-control/core';
import { EMPTY_MEMORY } from '@ground-control/board';
import { makeLaneStore } from '../src/lanes.js';
import { afterInstall, announce, makeMarkStore } from '../src/marks.js';
import { lanesPathOf, marksPathOf } from '../src/paths.js';
import { tempHome } from './helpers.js';

let home: string;
let dispose: () => void;

beforeEach(() => {
  ({ home, dispose } = tempHome());
});

afterEach(() => dispose());

const STATUSES = ['🎁 Assigned', '⚒️ Dev'];

describe('the lane store', () => {
  it('reads an empty memory on a machine that has never had a board open', () => {
    expect(makeLaneStore(home).read(STATUSES)).toEqual({ ...EMPTY_MEMORY, statuses: STATUSES });
  });

  it('round trips what the developer placed', () => {
    const store = makeLaneStore(home);
    const memory = { placements: { 'issue:4521': 'review' as const }, seenPastMyHands: ['issue:99'], statuses: [...STATUSES] };

    store.write(memory);

    expect(store.read(STATUSES)).toEqual(memory);
  });

  /** One record per machine (R8), so a second store on the same home reads what the first wrote. */
  it('is one record every board reads, not one per board', () => {
    makeLaneStore(home).write({ placements: { 'issue:1': 'done' }, seenPastMyHands: [], statuses: [...STATUSES] });

    expect(makeLaneStore(home).read(STATUSES).placements).toEqual({ 'issue:1': 'done' });
  });

  it('reads an empty memory from a file the developer has broken, rather than throwing on every render', () => {
    mkdirSync(groundControlDirOf(home), { recursive: true });
    writeFileSync(lanesPathOf(home), '{ not json');

    expect(makeLaneStore(home).read(STATUSES)).toEqual({ ...EMPTY_MEMORY, statuses: STATUSES });
  });

  it('drops a stored lane that is not one the developer could have chosen', () => {
    mkdirSync(groundControlDirOf(home), { recursive: true });
    writeFileSync(
      lanesPathOf(home),
      JSON.stringify({ placements: { 'issue:1': 'nowhere', 'issue:2': 'plan' }, seenPastMyHands: [], statuses: STATUSES }),
    );

    expect(makeLaneStore(home).read(STATUSES).placements).toEqual({ 'issue:2': 'plan' });
  });

  /** A changed membership set carries cards across the archive line for reasons no card caused (R9). */
  it('clears the returned marks when the membership set it was written against has changed', () => {
    makeLaneStore(home).write({ placements: { 'issue:1': 'done' }, seenPastMyHands: ['issue:1'], statuses: ['⚒️ Dev'] });

    expect(makeLaneStore(home).read(STATUSES)).toEqual({ placements: {}, seenPastMyHands: [], statuses: STATUSES });
  });
});

describe('the marks', () => {
  it('reads nothing on a machine where the activity signal has never been installed', () => {
    expect(makeMarkStore(home).read()).toEqual({ installedAt: null, announcedAt: {} });
  });

  it('round trips', () => {
    const store = makeMarkStore(home);
    store.write({ installedAt: 42, announcedAt: { 'board-1': 42 } });

    expect(store.read()).toEqual({ installedAt: 42, announcedAt: { 'board-1': 42 } });
  });

  it('reads nothing from a file it cannot parse', () => {
    mkdirSync(groundControlDirOf(home), { recursive: true });
    writeFileSync(marksPathOf(home), 'not json');

    expect(makeMarkStore(home).read()).toEqual({ installedAt: null, announcedAt: {} });
  });

  it('reads nothing from a file whose shape it does not recognise', () => {
    mkdirSync(groundControlDirOf(home), { recursive: true });
    writeFileSync(marksPathOf(home), '{"installedAt":"yesterday"}');

    expect(makeMarkStore(home).read()).toEqual({ installedAt: null, announcedAt: {} });
  });
});

describe('afterInstall', () => {
  const held = { installedAt: null, announcedAt: {} };

  it('starts the clock on a run that actually added entries', () => {
    expect(afterInstall(held, 'install', 3, 1000)).toEqual({ installedAt: 1000, announcedAt: {} });
  });

  /**
   * Stamping a run that added nothing would have the board claim every session listed before this moment cannot
   * report, of sessions that report on their next event.
   */
  it('starts nothing on a run that added none', () => {
    expect(afterInstall(held, 'install', 0, 1000)).toEqual(held);
  });

  it('leaves an install already stamped where it was', () => {
    const stamped = { installedAt: 500, announcedAt: { 'board-1': 500 } };

    expect(afterInstall(stamped, 'install', 3, 1000)).toEqual(stamped);
  });

  /** So putting the hooks back says so again, rather than being old news from the install before it. */
  it('clears the stamp and every announcement on a removal', () => {
    expect(afterInstall({ installedAt: 500, announcedAt: { 'board-1': 500 } }, 'remove', 0, 1000)).toEqual({
      installedAt: null,
      announcedAt: {},
    });
  });
});

describe('announce', () => {
  const installed = { installedAt: 500, announcedAt: {} };

  it('says it once to a client that has not heard it', () => {
    const first = announce(installed, 'board-1');

    expect(first.say).toBe(true);
    expect(announce(first.next, 'board-1').say).toBe(false);
  });

  /** A developer opening a second board has not read the first board's notice (R25). */
  it('says it to a second client too', () => {
    const first = announce(installed, 'board-1');

    expect(announce(first.next, 'board-2').say).toBe(true);
  });

  it('says nothing where nothing has been installed', () => {
    expect(announce({ installedAt: null, announcedAt: {} }, 'board-1').say).toBe(false);
  });

  it('says it again after the hooks are removed and put back', () => {
    const told = announce(installed, 'board-1').next;
    const again = afterInstall(afterInstall(told, 'remove', 0, 900), 'install', 3, 1000);

    expect(announce(again, 'board-1').say).toBe(true);
  });
});
