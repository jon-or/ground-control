import { describe, expect, it } from 'vitest';
import { checkEvidence } from '../src/index.js';

describe('the evidence ledger a card needs to enter Review (R23, R49)', () => {
  it('accepts a table whose every row names its evidence', () => {
    const ledger = [
      '# Evidence',
      '',
      '| Criterion | Evidence |',
      '|---|---|',
      '| Guest total rounds to cents | `QuoteTotals_TwoNights_RoundsToCents` |',
      '| Page shows the fee | UAT https://app.i1.example.com/quote as owner |',
    ].join('\r\n');

    expect(checkEvidence(ledger)).toEqual({ ok: true, rows: 2 });
  });

  it('names each row whose evidence is empty or a placeholder', () => {
    const ledger = [
      '| Criterion | Evidence | Notes |',
      '| :-- | :-: | --- |',
      '| Rounds to cents | | |',
      '| Shows the fee | TODO | later |',
      '| Logs the call | `CallLog_Written` | |',
      '| | — | |',
    ].join('\n');

    expect(checkEvidence(ledger)).toEqual({
      ok: false,
      reason: '3 of 4 rows have no evidence: Rounds to cents; Shows the fee; (unnamed row).',
    });
  });

  it('finds the Evidence column in any position and any case, skipping tables without one', () => {
    const ledger = ['| a | b |', '|---|---|', '| 1 | 2 |', '', '| EVIDENCE | Criterion |', '|---|---|', '| `A_B_C` | c |'].join('\n');

    expect(checkEvidence(ledger)).toEqual({ ok: true, rows: 1 });
  });

  it('checks every evidence table, takes a header that starts with Evidence, and skips fenced examples', () => {
    const ledger = [
      '| Criterion | Evidence (test, UAT, or query) |',
      '|---|---|',
      '| Rounds to cents | `QuoteTotals_TwoNights_RoundsToCents` |',
      '',
      '```markdown',
      '| Criterion | Evidence |',
      '|---|---|',
      '| Example | |',
      '```',
      '',
      '| Task | Evidence |',
      '|---|---|',
      '| Migration runs | |',
    ].join('\n');

    expect(checkEvidence(ledger)).toEqual({ ok: false, reason: '1 of 2 rows have no evidence: Migration runs.' });
  });

  it('keeps an escaped pipe inside its cell', () => {
    expect(checkEvidence('| Criterion | Evidence |\n|---|---|\n| a \| b | query: 3 rows |')).toEqual({ ok: true, rows: 1 });
  });

  it('refuses a ledger with no rows or no evidence table', () => {
    expect(checkEvidence('| Criterion | Evidence |\n|---|---|\n')).toEqual({ ok: false, reason: 'The evidence table has no rows.' });
    expect(checkEvidence('All tests pass.')).toEqual({ ok: false, reason: 'No Markdown table with an Evidence column.' });
  });
});
