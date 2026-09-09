import type { ActionPlan } from './plan.js';

/** Supported action prompt placeholders, including the result-file path. */
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

/** Display name identifying the board-started action and issue. */
export function dispatchName(plan: ActionPlan): string {
  return `ground-control · ${plan.action} · #${plan.issueNumber}`;
}
