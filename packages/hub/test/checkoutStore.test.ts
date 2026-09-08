import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { makeCheckoutStore } from '../src/checkoutStore.js';
import { checkoutsPathOf } from '../src/paths.js';
import { tempHome } from './helpers.js';

let home: string;
let dispose: () => void;

beforeEach(() => {
  ({ home, dispose } = tempHome());
});

afterEach(() => dispose());

describe('the directory the developer picked for a card', () => {
  it('reads an absent file as no pick anywhere', () => {
    expect(makeCheckoutStore(home).read()).toEqual({});
  });

  it('round-trips a pick', () => {
    const store = makeCheckoutStore(home);

    expect(store.write('issue:19002', 'd:/work/repo.worktrees/19002')).toBe(true);
    expect(store.read()).toEqual({ 'issue:19002': 'd:/work/repo.worktrees/19002' });
  });

  it('keeps the picks already stored, which a whole-file write of one card would drop', () => {
    const store = makeCheckoutStore(home);
    store.write('issue:1', 'd:/one');
    store.write('issue:2', 'd:/two');

    expect(store.read()).toEqual({ 'issue:1': 'd:/one', 'issue:2': 'd:/two' });
  });

  it('replaces the pick for a card the developer picked again', () => {
    const store = makeCheckoutStore(home);
    store.write('issue:1', 'd:/one');
    store.write('issue:1', 'd:/two');

    expect(store.read()).toEqual({ 'issue:1': 'd:/two' });
  });

  it('reads a hand-edited file, since this is a file the developer can open', () => {
    makeCheckoutStore(home).write('issue:1', 'd:/one');
    writeFileSync(checkoutsPathOf(home), JSON.stringify({ 'issue:9': 'd:/nine' }));

    expect(makeCheckoutStore(home).read()).toEqual({ 'issue:9': 'd:/nine' });
  });

  // An unparsed read of a hand-editable file would throw on every render with no way back but deleting it.
  it.each(['{ not json', '["a list"]', '{"issue:1": 42}'])('reads %s as no picks rather than throwing', (text) => {
    makeCheckoutStore(home).write('issue:1', 'd:/one');
    writeFileSync(checkoutsPathOf(home), text);

    expect(makeCheckoutStore(home).read()).toEqual({});
  });

  it('writes JSON a person can read', () => {
    makeCheckoutStore(home).write('issue:1', 'd:/one');

    expect(readFileSync(checkoutsPathOf(home), 'utf8')).toBe('{\n  "issue:1": "d:/one"\n}\n');
  });
});
