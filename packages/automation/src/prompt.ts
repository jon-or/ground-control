import { fillTemplate } from '@ground-control/core';
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
  '{"outcome":"pushed","detail":"<what happened>"} only once the merge is pushed, otherwise ' +
  '{"outcome":"halted","detail":"<why it stopped>"}; add "auditPath":"<file>" when the run wrote one.';

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

/** Display name identifying the board-started run and issue. */
export function dispatchName(action: string, issueNumber: number): string {
  return `ground-control · ${action} · #${issueNumber}`;
}
