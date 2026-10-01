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
 * A path quoted so Bash and PowerShell both pass it unchanged. Single quotes stop `$` expansion, but neither shell
 * escapes an apostrophe in them the same way, so a path with one takes double quotes unless it also has `$`, `` ` ``, or `"`.
 */
function quotedPath(path: string): string {
  const forward = path.replaceAll('\\', '/');

  return forward.includes("'") && !/[$`"]/.test(forward) ? `"${forward}"` : `'${forward}'`;
}

/** How a run reaches the hub bundle's `result` command: `node 'C:/Users/dev/.claude/ground-control/hub.js' result`. */
export function resultCommand(bundlePath: string): string {
  return `node ${quotedPath(bundlePath)} result`;
}

/**
 * Result contract appended to a prompt that does not name `{resultPath}` itself. An unattended run reports no other
 * way, so the board states the contract instead of requiring it in every developer prompt.
 */
function reportContract(command: string, resultPath: string, shape: string): string {
  return (
    '\n\nThis run is unattended. Before you finish, however the run ends, record its result by running ' +
    `${command} <outcome> --to ${quotedPath(resultPath)} --detail '<text>', quoting each value so your shell passes it ` +
    `unchanged, and ask no questions. ${shape}`
  );
}

const ACTION_SHAPE =
  'The outcome is completed once the work is complete; awaiting-approval when the work is complete except for a step ' +
  'the developer must approve, such as posting or publishing, with a detail saying what is ready and what approving ' +
  "does; otherwise blocked, with a detail naming the question or problem that stopped it. Add --audit '<absolute path>' " +
  "when the run wrote a Markdown report, and, to awaiting-approval, --approve '<the prompt that performs the step>' " +
  'when a prompt can perform it.';

const WORKTREE_SHAPE =
  "The outcome is completed, with --worktree '<absolute path of the worktree>', once the worktree exists; otherwise " +
  'blocked, with a detail saying why there is no worktree.';

/** Fill an action prompt, appending the result contract unless the prompt places `{resultPath}` itself. */
export function actionPrompt(template: string, values: PromptValues, command: string): string {
  const filled = fillTemplate(template, values);

  return template.includes('{resultPath}') ? filled : filled + reportContract(command, values.resultPath, ACTION_SHAPE);
}

/**
 * The prompt a run awaiting approval named, which approving runs (R39). It is the session's own text, so only
 * `{resultPath}` is filled; without it, the result contract is appended.
 */
export function approvalPrompt(prompt: string, resultPath: string, command: string): string {
  return prompt.includes('{resultPath}')
    ? prompt.replaceAll('{resultPath}', resultPath)
    : prompt + reportContract(command, resultPath, ACTION_SHAPE);
}

/** Fill a worktree prompt, appending the result contract unless the prompt places `{resultPath}` itself. */
export function worktreePrompt(template: string, values: WorktreePromptValues, command: string): string {
  const filled = fillTemplate(template, values);

  return template.includes('{resultPath}') ? filled : filled + reportContract(command, values.resultPath, WORKTREE_SHAPE);
}

/** Display name identifying the board-started run, its row, and the issue. */
export function dispatchName(action: string, issueNumber: number, qualifier: string | null = null): string {
  return `ground-control · ${qualifier === null ? action : `${action} ${qualifier}`} · #${issueNumber}`;
}
