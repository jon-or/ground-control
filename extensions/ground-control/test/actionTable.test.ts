import { describe, expect, it } from 'vitest';
import { legacyMergeRow, tableToSave } from '../src/actionTable.js';

describe('the earlier merge settings', () => {
  it('become a Merge · upstream row with the prompt and the automatic choice they had', () => {
    expect(legacyMergeRow(true, ' /or-merge {base} ')).toEqual({ action: 'merge', qualifier: 'upstream', prompt: '/or-merge {base}', automatic: true });
    expect(legacyMergeRow(undefined, '/or-merge')).toEqual({ action: 'merge', qualifier: 'upstream', prompt: '/or-merge', automatic: false });
  });

  it('become nothing where no prompt was set', () => {
    expect(legacyMergeRow(true, '  ')).toBeNull();
    expect(legacyMergeRow(true, undefined)).toBeNull();
  });
});

describe('what the table panel may save', () => {
  const review = { action: 'review-others', qualifier: 'initial', prompt: '/review-pr {pr}', automatic: true };

  it('saves the rows in their order, with the pattern trimmed', () => {
    const merge = { action: 'merge', qualifier: null, prompt: '', automatic: false };

    expect(tableToSave([merge, review], ' ^Test- ')).toEqual({ rows: [merge, review], pattern: '^Test-' });
  });

  it('refuses a second row for one reading, and a qualifier the action does not take', () => {
    const refusal = { failure: 'Each action and qualifier can have one row, and each qualifier must suit its action.' };

    expect(tableToSave([review, { ...review, prompt: '/other' }], '^Test-')).toEqual(refusal);
    expect(tableToSave([{ ...review, qualifier: 'test' }], '^Test-')).toEqual(refusal);
    expect(tableToSave([{ action: 'fix-checks', prompt: '/x' }], '^Test-')).toEqual(refusal);
  });

  it('refuses an empty or invalid pattern, and a table that is not a list', () => {
    expect(tableToSave([], ' ')).toEqual({ failure: 'Set a test branch pattern.' });
    expect(tableToSave([], '(')).toEqual({ failure: 'The test branch pattern is not a valid regular expression: (' });
    expect(tableToSave('rows', '^Test-')).toEqual({ failure: 'The table could not be read.' });
  });
});
