import type { ActionPlan } from './plan.js';

/** What a dispatched session is told, and where it may report back. Its keys are the whole roster `fillTemplate` fills. */
export type PromptValues = {
  issue: string;
  repo: string;
  pr: string;
  branch: string;
  base: string;
  checkout: string;
  resultPath: string;
}

export function promptValues(plan: ActionPlan, resultPath: string): PromptValues {
  return {
    issue: String(plan.issueNumber),
    repo: plan.repository,
    pr: String(plan.pullRequest),
    branch: plan.branch,
    base: plan.base,
    checkout: plan.checkout,
    resultPath,
  };
}

/**
 * What the session is called, which is how the developer tells a run the board started from one they started
 * themselves. The issue number is in it because a board of ten cards is ten names in the same list.
 */
export function dispatchName(plan: ActionPlan): string {
  return `ground-control · ${plan.action} · #${plan.issueNumber}`;
}
