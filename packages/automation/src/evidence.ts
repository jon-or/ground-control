import type { TriageContext } from '@ground-control/core';

/**
 * What a card looked like when a run was authorised. A run is never made twice against the same string, so this is
 * the whole of what stops a merge that halted from being dispatched again on every pass: one run per push.
 *
 * It is read from the fresh context rather than from the card, because those are different reads — the card is up
 * to a minute old and carries no head commit at all. `headOid` is the branch's own state and nobody else's, which
 * is what makes it the right thing to authorise against: the base branch moves all day without this card changing.
 */
export function actionEvidence(context: TriageContext): string {
  const pr = context.pullRequest;

  return [context.issueNumber, pr?.number ?? '', pr?.headOid ?? ''].join('|');
}
