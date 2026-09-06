import type { ActionPlan } from './plan.js';

/**
 * What a dispatched session is told, and where it may report back. Only these names are substituted: a developer's
 * own prompt may contain braces of its own, and rewriting those would corrupt the thing they configured.
 */
export interface PromptValues {
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

/** Every placeholder the board fills, so a settings description and the substitution can never drift apart. */
export const PROMPT_PLACEHOLDERS: readonly (keyof PromptValues)[] = [
  'issue',
  'repo',
  'pr',
  'branch',
  'base',
  'checkout',
  'resultPath',
];

/**
 * The template with the board's own facts in it. A placeholder the board does not fill is left exactly as typed
 * rather than emptied: a prompt that came out half-substituted would run, and a run is not a thing to guess at.
 */
export function fillPrompt(template: string, values: PromptValues): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) =>
    PROMPT_PLACEHOLDERS.includes(name as keyof PromptValues) ? values[name as keyof PromptValues] : whole,
  );
}

/**
 * What the session is called, which is how the developer tells a run the board started from one they started
 * themselves. The issue number is in it because a board of ten cards is ten names in the same list.
 */
export function dispatchName(plan: ActionPlan): string {
  return `ground-control · ${plan.action} · #${plan.issueNumber}`;
}
