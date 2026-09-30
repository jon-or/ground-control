import { describe, expect, it } from 'vitest';
import { readStageRequest } from '../src/index.js';

describe('a stage report from outside the hub (R49)', () => {
  it('takes an issue, a stage, and an optional note', () => {
    expect(readStageRequest({ issue: 15619, stage: 'build', note: 'commit 2/4' })).toEqual({ issue: 15619, stage: 'build', note: 'commit 2/4' });
    expect(readStageRequest({ issue: 15619, stage: 'done' })).toEqual({ issue: 15619, stage: 'done', note: '' });
    expect(readStageRequest({ issue: 1, stage: 'plan', note: 'x', step: { n: 2, of: 3 } })).toEqual({ issue: 1, stage: 'plan', note: 'x', step: { n: 2, of: 3 } });
  });

  it('refuses anything else', () => {
    for (const body of [null, 'build', { issue: '15619', stage: 'build' }, { issue: 0, stage: 'plan' }, { issue: 1.5, stage: 'plan' },
      { issue: 1, stage: 'ship' }, { issue: 1, stage: 'plan', note: 3 }, { issue: 1, stage: 'plan', step: { n: 4, of: 3 } },
      { issue: 1, stage: 'plan', step: { n: 0, of: 3 } }, { issue: 1, stage: 'plan', step: { n: 1, of: 51 } }]) {
      expect(readStageRequest(body)).toBeNull();
    }
  });
});
