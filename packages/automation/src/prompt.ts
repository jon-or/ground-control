import type { ActionPlan } from './plan.js';

/** Supported action prompt placeholders, including the result-file path. `checkout` is the worktree the run works in. */
export type PromptValues = {
  issue: string;
  repo: string;
  pr: string;
  branch: string;
  base: string;
  checkout: string;
  resultPath: string;
}

export function promptValues(plan: ActionPlan, checkout: string, resultPath: string): PromptValues {
  return {
    issue: String(plan.issueNumber),
    repo: plan.repository,
    pr: String(plan.pullRequest),
    branch: plan.branch,
    base: plan.base,
    checkout,
    resultPath,
  };
}

/** Worktree prompt placeholders (R46). `clone` is the main working tree the run starts in, `repo` the repository. */
export type WorktreePromptValues = {
  issue: string;
  repo: string;
  title: string;
  url: string;
  clone: string;
  resultPath: string;
}

export function worktreePromptValues(
  card: { issueNumber: number; issue: { title: string; url: string; repository?: string | undefined } },
  clone: string,
  resultPath: string,
): WorktreePromptValues {
  return {
    issue: String(card.issueNumber),
    repo: card.issue.repository ?? '',
    title: card.issue.title,
    url: card.issue.url,
    clone,
    resultPath,
  };
}

/** Display name identifying the board-started run and issue. */
export function dispatchName(action: string, issueNumber: number): string {
  return `ground-control · ${action} · #${issueNumber}`;
}
