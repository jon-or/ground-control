import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
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
  it('returns empty lane state for a missing file', () => {
    expect(makeLaneStore(home).read(STATUSES)).toEqual({ ...EMPTY_MEMORY, statuses: STATUSES });
  });

  it('round trips what the developer placed', () => {
    const store = makeLaneStore(home);
    const memory = { ...EMPTY_MEMORY, placements: { 'issue:4521': 'review' as const }, pastMyHandsAt: { 'issue:99': 1_000 }, statuses: [...STATUSES] };

    store.write(memory);

    expect(store.read(STATUSES)).toEqual(memory);
  });

  /** One record per machine (R8), so a second store on the same home reads what the first wrote. */
  it('is one record every board reads, not one per board', () => {
    makeLaneStore(home).write({ ...EMPTY_MEMORY, placements: { 'issue:1': 'icebox' }, statuses: [...STATUSES] });

    expect(makeLaneStore(home).read(STATUSES).placements).toEqual({ 'issue:1': 'icebox' });
  });

  it('returns empty lane state for invalid JSON', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(lanesPathOf(home), '{ not json');

    expect(makeLaneStore(home).read(STATUSES)).toEqual({ ...EMPTY_MEMORY, statuses: STATUSES });
  });

  it('drops a stored lane that is not one the developer could have chosen', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      lanesPathOf(home),
      JSON.stringify({ placements: { 'issue:1': 'nowhere', 'issue:2': 'plan' }, statuses: STATUSES }),
    );

    expect(makeLaneStore(home).read(STATUSES).placements).toEqual({ 'issue:2': 'plan' });
  });

  /** A changed membership set carries cards across the archive line for reasons no card caused (R9). */
  it('clears the returned marks when the membership set it was written against has changed', () => {
    makeLaneStore(home).write({
      ...EMPTY_MEMORY,
      placements: { 'issue:1': 'icebox' },
      pastMyHandsAt: { 'issue:1': 1_000 },
      archived: ['issue:1'],
      statuses: ['⚒️ Dev'],
    });

    // Preserve departure timestamps while clearing returned attention; otherwise old activity could become valid again (R6).
    expect(makeLaneStore(home).read(STATUSES)).toEqual({
      ...EMPTY_MEMORY,
      pastMyHandsAt: { 'issue:1': 1_000 },
      seen: ['issue:1'],
      statuses: STATUSES,
    });
  });
});

describe('the marks', () => {
  it('returns empty marks before hook installation', () => {
    expect(makeMarkStore(home).read()).toEqual({ installedAt: null, announcedAt: {}, triageToldAt: null, actionsToldAt: null });
  });

  it('round trips', () => {
    const store = makeMarkStore(home);
    store.write({ installedAt: 42, announcedAt: { 'board-1': 42 }, triageToldAt: 7, actionsToldAt: null });

    expect(store.read()).toEqual({ installedAt: 42, announcedAt: { 'board-1': 42 }, triageToldAt: 7, actionsToldAt: null });
  });

  it('returns empty marks for invalid JSON', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(marksPathOf(home), 'not json');

    expect(makeMarkStore(home).read()).toEqual({ installedAt: null, announcedAt: {}, triageToldAt: null, actionsToldAt: null });
  });

  it('returns empty marks for invalid shapes', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(marksPathOf(home), '{"installedAt":"yesterday"}');

    expect(makeMarkStore(home).read()).toEqual({ installedAt: null, announcedAt: {}, triageToldAt: null, actionsToldAt: null });
  });
});

describe('afterInstall', () => {
  const held = { installedAt: null, announcedAt: {}, triageToldAt: null, actionsToldAt: null };

  it('starts the clock on a run that actually added entries', () => {
    expect(afterInstall(held, 'install', 3, 1000)).toEqual({ installedAt: 1000, announcedAt: {}, triageToldAt: null, actionsToldAt: null });
  });

  /** Do not change install timestamps when no entries were added; existing reporting sessions must not appear pre-install. */
  it('preserves installation time when no entries were added', () => {
    expect(afterInstall(held, 'install', 0, 1000)).toEqual(held);
  });

  it('leaves an install already stamped where it was', () => {
    const stamped = { installedAt: 500, announcedAt: { 'board-1': 500 }, triageToldAt: null, actionsToldAt: null };

    expect(afterInstall(stamped, 'install', 3, 1000)).toEqual(stamped);
  });

  /** Reinstallation must produce a new installation notice. */
  it('clears installation acknowledgments on removal and preserves usage notices', () => {
    // Preserve triage and action notices across hook reinstallation.
    expect(afterInstall({ installedAt: 500, announcedAt: { 'board-1': 500 }, triageToldAt: 7, actionsToldAt: 9 }, 'remove', 0, 1000)).toEqual({
      installedAt: null,
      announcedAt: {},
      triageToldAt: 7,
      actionsToldAt: 9,
    });
  });
});

describe('announce', () => {
  const installed = { installedAt: 500, announcedAt: {}, triageToldAt: null, actionsToldAt: null };

  it('announces installation once per client', () => {
    const first = announce(installed, 'board-1');

    expect(first.say).toBe(true);
    expect(announce(first.next, 'board-1').say).toBe(false);
  });

  /** A developer opening a second board has not read the first board's notice (R25). */
  it('announces installation to a second client', () => {
    const first = announce(installed, 'board-1');

    expect(announce(first.next, 'board-2').say).toBe(true);
  });

  it('does not announce before installation', () => {
    expect(announce({ installedAt: null, announcedAt: {}, triageToldAt: null, actionsToldAt: null }, 'board-1').say).toBe(false);
  });

  it('announces reinstallation', () => {
    const told = announce(installed, 'board-1').next;
    const again = afterInstall(afterInstall(told, 'remove', 0, 900), 'install', 3, 1000);

    expect(announce(again, 'board-1').say).toBe(true);
  });
});
