import { describe, expect, it } from 'vitest';
import { parseAuthStatusLogins } from '../src/index.js';

/** Recorded from `gh auth status` on 2026-09-01, gh 2.x. */
const oneAccount = `github.com
  ✓ Logged in to github.com account dev-1-bot (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'project', 'read:org', 'repo', 'workflow'
`;

const twoAccounts = `github.com
  ✓ Logged in to github.com account dev-1-bot (keyring)
  - Active account: true
  ✓ Logged in to github.com account dev-1 (keyring)
  - Active account: false
`;

describe('parseAuthStatusLogins', () => {
  it('reads the single logged-in account', () => {
    expect(parseAuthStatusLogins(oneAccount)).toEqual(['dev-1-bot']);
  });

  it('reads every account, not just the active one', () => {
    expect(parseAuthStatusLogins(twoAccounts)).toEqual(['dev-1-bot', 'dev-1']);
  });

  it('returns nothing when gh is logged out', () => {
    expect(parseAuthStatusLogins('You are not logged into any GitHub hosts.')).toEqual([]);
  });

  it('does not repeat an account listed twice', () => {
    expect(parseAuthStatusLogins(`${oneAccount}${oneAccount}`)).toEqual(['dev-1-bot']);
  });
});
