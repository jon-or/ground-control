import type { TriageContext } from '@ground-control/core';

/**
 * Identify automatic dispatch evidence by the fresh PR head commit. The board snapshot may be stale.
 * Base-branch changes alone must not authorize another merge; alreadyRun applies revision, outcome,
 * and manual-retry exceptions.
 */
export function actionEvidence(context: TriageContext): string {
  const pr = context.pullRequest;

  return [context.issueNumber, pr?.number ?? '', pr?.headOid ?? ''].join('|');
}
