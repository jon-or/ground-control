import { fillTemplate } from '@ground-control/core';
import type { ActionPlan, BasePlan, PullRequestRole } from './plan.js';

/** Supported action prompt placeholders, including the result-file path. `checkout` is the worktree the run works in. */
export type PromptValues = {
  issue: string;
  repo: string;
  pr: string;
  branch: string;
  base: string;
  default: string;
  target: string;
  checkout: string;
  resultPath: string;
}

export function promptValues(plan: ActionPlan, checkout: string, resultPath: string): PromptValues {
  return {
    issue: String(plan.issueNumber),
    repo: plan.repository,
    pr: plan.pullRequest === null ? '' : String(plan.pullRequest),
    branch: plan.branch,
    base: plan.base,
    default: plan.defaultBranch,
    target: plan.target,
    checkout,
    resultPath,
  };
}

/** A base merge's placeholders take the base's pull request: an upstream merge of it, in its worktree (R39). */
export function basePromptValues(base: BasePlan, checkout: string, resultPath: string): PromptValues {
  return {
    issue: String(base.issueNumber),
    repo: base.repository,
    pr: String(base.pullRequest),
    branch: base.branch,
    base: base.defaultBranch,
    default: base.defaultBranch,
    target: '',
    checkout,
    resultPath,
  };
}

/**
 * Worktree prompt placeholders (R46). `clone` is the main working tree the run starts in, `repo` the repository.
 * `pr`, `branch`, and `role` are empty where the card has no pull request.
 */
export type WorktreePromptValues = {
  issue: string;
  repo: string;
  title: string;
  url: string;
  clone: string;
  pr: string;
  branch: string;
  role: string;
  resultPath: string;
}

/** The card's pull request as a worktree run needs it: a reviewer's worktree checks out the head. */
export interface WorktreePullRequest {
  number: number;
  branch: string;
  role: PullRequestRole;
}

export function worktreePromptValues(
  card: { issueNumber: number; issue: { title: string; url: string; repository?: string | undefined } },
  clone: string,
  resultPath: string,
  pullRequest: WorktreePullRequest | null,
): WorktreePromptValues {
  return {
    issue: String(card.issueNumber),
    repo: card.issue.repository ?? '',
    title: card.issue.title,
    url: card.issue.url,
    clone,
    pr: pullRequest === null ? '' : String(pullRequest.number),
    branch: pullRequest?.branch ?? '',
    role: pullRequest?.role ?? '',
    resultPath,
  };
}

/**
 * Result-file contract appended to a prompt that does not name `{resultPath}` itself. An unattended run reports
 * no other way, so the board states the contract instead of requiring it in every developer prompt.
 */
function reportContract(resultPath: string, shape: string): string {
  return (
    `\n\nThis run is unattended. Before you finish, write JSON to ${resultPath}: ${shape} ` +
    'Write every key of whichever object you write, however the run ends, and ask no questions.'
  );
}

const ACTION_SHAPE =
  '{"outcome":"done","detail":"<what happened>"} only once the work is complete, otherwise ' +
  '{"outcome":"halted","detail":"<why it stopped>"}; add "auditPath":"<absolute path>" when the run wrote a Markdown report.';

const WORKTREE_SHAPE =
  '{"outcome":"ready","worktree":"<absolute path of the worktree>","detail":"<what happened>"}, or ' +
  '{"outcome":"halted","detail":"<why no worktree>"}.';

/** Fill an action prompt, appending the result contract unless the prompt places `{resultPath}` itself. */
export function actionPrompt(template: string, values: PromptValues): string {
  const filled = fillTemplate(template, values);

  return template.includes('{resultPath}') ? filled : filled + reportContract(values.resultPath, ACTION_SHAPE);
}

/** Fill a worktree prompt, appending the result contract unless the prompt places `{resultPath}` itself. */
export function worktreePrompt(template: string, values: WorktreePromptValues): string {
  const filled = fillTemplate(template, values);

  return template.includes('{resultPath}') ? filled : filled + reportContract(values.resultPath, WORKTREE_SHAPE);
}

/** Display name identifying the board-started run, its row, and the issue. */
export function dispatchName(action: string, issueNumber: number, qualifier: string | null = null): string {
  return `ground-control · ${qualifier === null ? action : `${action} ${qualifier}`} · #${issueNumber}`;
}
