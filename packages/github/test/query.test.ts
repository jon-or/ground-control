import { describe, expect, it } from 'vitest';
import { buildSearchQuery } from '../src/index.js';
import { config } from './helpers.js';

describe('buildSearchQuery', () => {
  it('adds one assignee qualifier per login', () => {
    expect(buildSearchQuery(config({ logins: ['jon-or', 'jon-or-ai'] }), false)).toBe(
      'repo:ownerrez/orez is:issue is:open assignee:jon-or assignee:jon-or-ai',
    );
  });

  it('adds the project qualifier only when asked', () => {
    expect(buildSearchQuery(config(), true)).toContain('project:ownerrez/3');
    expect(buildSearchQuery(config(), false)).not.toContain('project:');
  });

  it('takes the project owner from the repo, not a separate setting', () => {
    expect(buildSearchQuery(config({ repo: 'someone/else', projectNumber: 9 }), true)).toContain('project:someone/9');
  });
});
