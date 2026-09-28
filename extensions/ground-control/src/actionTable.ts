import { readActionTable } from '@ground-control/core';
import type { ActionRow } from '@ground-control/core';

/**
 * The Merge · upstream row the earlier `actions.merge-upstream` settings amount to, or null where their prompt is
 * empty. Those settings ran only for a PR based on the default branch, which is an upstream merge (R39).
 */
export function legacyMergeRow(enabled: unknown, prompt: unknown): ActionRow | null {
  return typeof prompt === 'string' && prompt.trim() !== ''
    ? { action: 'merge', qualifier: 'upstream', prompt: prompt.trim(), automatic: enabled === true }
    : null;
}

/** What the panel asks to save, checked as the hub will read it. A failure names the first problem. */
export function tableToSave(rows: unknown, pattern: unknown): { rows: ActionRow[]; pattern: string } | { failure: string } {
  if (!Array.isArray(rows)) {
    return { failure: 'The table could not be read.' };
  }

  const read = readActionTable(rows);

  if (read.length !== rows.length) {
    return { failure: 'Each action and qualifier can have one row, and each qualifier must suit its action.' };
  }

  if (typeof pattern !== 'string' || pattern.trim() === '') {
    return { failure: 'Set a test branch pattern.' };
  }

  try {
    new RegExp(pattern.trim());
  } catch {
    return { failure: `The test branch pattern is not a valid regular expression: ${pattern.trim()}` };
  }

  return { rows: read, pattern: pattern.trim() };
}
