import { DEFAULT_CUSTODY } from '@ground-control/core';
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

/**
 * When someone other than the developer or a machine account last commented on the issue, by GitHub's clock in epoch
 * milliseconds, or null where the comments read hold none. A QA run that stopped short may run again after it (R39).
 * The context holds only the newest comments, so a tester comment the developer's replies push out reads as none.
 */
export function testerCommentAt(context: TriageContext): number | null {
  const excluded = new Set([...context.logins, ...DEFAULT_CUSTODY.bots].map((login) => login.toLowerCase()));
  const times = context.comments
    .filter((comment) => comment.author !== null && !comment.author.toLowerCase().endsWith('[bot]') && !excluded.has(comment.author.toLowerCase()))
    .map((comment) => Date.parse(comment.createdAt))
    .filter((time) => !Number.isNaN(time));

  return times.length === 0 ? null : Math.max(...times);
}
