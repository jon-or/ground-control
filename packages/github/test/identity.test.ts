import { describe, expect, it } from 'vitest';
import { parseAuthStatusLogins } from '../src/index.js';

/** Recorded from `gh auth status` on 2026-09-01, gh 2.x. */
const oneAccount = `github.com
  ✓ Logged in to github.com account jon-or-ai (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'project', 'read:org', 'repo', 'workflow'
`;

const twoAccounts = `github.com
  ✓ Logged in to github.com account jon-or-ai (keyring)
  - Active account: true
  ✓ Logged in to github.com account jehhynes (keyring)
  - Active account: false
`;

describe('parseAuthStatusLogins', () => {
  it('reads the single logged-in account', () => {
    expect(parseAuthStatusLogins(oneAccount)).toEqual(['jon-or-ai']);
  });

  it('reads every account, not just the active one', () => {
    expect(parseAuthStatusLogins(twoAccounts)).toEqual(['jon-or-ai', 'jehhynes']);
  });

  it('returns nothing when gh is logged out', () => {
    expect(parseAuthStatusLogins('You are not logged into any GitHub hosts.')).toEqual([]);
  });

  it('does not repeat an account listed twice', () => {
    expect(parseAuthStatusLogins(`${oneAccount}${oneAccount}`)).toEqual(['jon-or-ai']);
  });
});
