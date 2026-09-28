import { describe, expect, it } from 'vitest';
import { mergeTypeOf } from '../src/merge.js';

const onMaster = { baseRefName: 'master', headRefName: '17198-channel-mapping' };
const stacked = { baseRefName: '17190-channel-base', headRefName: '17198-channel-mapping' };

describe('what kind of merge a request is', () => {
  it('is upstream where the pull request is on the default branch and the request names no test branch', () => {
    expect(mergeTypeOf(onMaster, 'master', null, '^Test-')).toEqual({ ok: true, type: 'upstream', target: null });
    expect(mergeTypeOf(onMaster, 'master', '17198-channel-mapping', '^Test-')).toEqual({ ok: true, type: 'upstream', target: null });
    expect(mergeTypeOf(onMaster, 'master', 'master', '^Test-')).toEqual({ ok: true, type: 'upstream', target: null });
  });

  // The comment may name only the stacked branch; the legs come from the branches, not the words.
  it('is stacked where the pull request is based on another branch, whichever of them the request names', () => {
    expect(mergeTypeOf(stacked, 'master', null, '^Test-')).toEqual({ ok: true, type: 'stacked', target: null });
    expect(mergeTypeOf(stacked, 'master', '17198-channel-mapping', '^Test-')).toEqual({ ok: true, type: 'stacked', target: null });
    expect(mergeTypeOf(stacked, 'master', '17190-channel-base', '^Test-')).toEqual({ ok: true, type: 'stacked', target: null });
  });

  it('is a test merge where the request names a test branch, stacked or not', () => {
    expect(mergeTypeOf(onMaster, 'master', 'Test-Payments', '^Test-')).toEqual({ ok: true, type: 'test', target: 'Test-Payments' });
    expect(mergeTypeOf(stacked, 'master', 'Test-Payments', '^Test-')).toEqual({ ok: true, type: 'test', target: 'Test-Payments' });
    expect(mergeTypeOf(onMaster, 'master', 'QA-2', '^QA-')).toEqual({ ok: true, type: 'test', target: 'QA-2' });
  });

  it('refuses a named branch that is none of the pull request’s and no test branch', () => {
    expect(mergeTypeOf(onMaster, 'master', 'release-9', '^Test-')).toEqual({
      ok: false,
      reason: 'The request names release-9, which is neither this pull request\'s branch, its base, nor a test branch.',
    });
    // The pattern is a regular expression the developer wrote, so its case is theirs to choose.
    expect(mergeTypeOf(onMaster, 'master', 'test-payments', '^Test-')).toMatchObject({ ok: false });
  });

  it('refuses where the default branch is unknown, or the pattern is not a regular expression', () => {
    expect(mergeTypeOf(onMaster, null, null, '^Test-')).toEqual({ ok: false, reason: 'Repository default branch unavailable.' });
    expect(mergeTypeOf(onMaster, 'master', null, '(')).toEqual({
      ok: false,
      reason: 'groundControl.actions.testBranchPattern is not a valid regular expression: (',
    });
  });

  /** Older recordings carry no base; that is not a stack. */
  it('reads an empty base as the default branch', () => {
    expect(mergeTypeOf({ baseRefName: '', headRefName: 'x' }, 'master', null, '^Test-')).toMatchObject({ type: 'upstream' });
  });
});
