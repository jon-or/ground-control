import type { TriageComment, TriageContext } from '@ground-control/core';

/**
 * What the classifier is told it is doing. Short on purpose: the whole system prompt and every tool definition cost
 * 55× the evidence itself (`docs/mechanics.md` §31), so this replaces the CLI's own rather than appending to it.
 *
 * It names only the actions the model decides. The six the hub reads off the pull request are left out — offering
 * them would invite a guess at something already known, and a guess that is then overruled is wasted either way.
 */
export const TRIAGE_SYSTEM_PROMPT = [
  'You classify what one software work item is waiting on, for a developer looking at their own board.',
  'You are given an issue, its recent comments, and the pull request that would close it, if there is one.',
  'Answer with exactly one action and one sentence saying what the work is, in under 160 characters.',
  '',
  'Choose the action for what the developer must do NEXT:',
  '- begin-work: assigned to them, nothing under way yet, the issue is the specification',
  '- answer-design-question: somebody has asked them a question they must answer before the work can go on',
  '- uat-question: a tester has asked something about how it is meant to behave',
  '- uat-failure: a tester has reported it does not work',
  '- review-others: a pull request that is not theirs is waiting on their review',
  '- address-review: their own pull request has review comments to answer',
  '- awaiting-others: they have asked something and the answer is somebody else’s; nothing for them to do',
  '- other: none of the above fits',
  '',
  'The sentence describes the work, not your reasoning. Write it for somebody who already knows the project.',
  'Do not speculate about causes you have no evidence for. If the evidence is thin, say so plainly and pick other.',
].join('\n');

/** How a body reads in the prompt when there is none. Blank would read as a comment somebody left empty. */
const NOTHING = '(none)';

function who(comment: TriageComment, logins: readonly string[]): string {
  const author = comment.author ?? 'someone';
  const own = logins.some((login) => login.toLowerCase() === author.toLowerCase());
  const association = comment.authorAssociation ? `, ${comment.authorAssociation.toLowerCase()}` : '';

  // Marked rather than left to be inferred: which words are the developer's own is what tells a question they asked
  // from a question they were asked, and it decides between two of the actions on its own.
  return `${author}${own ? ' (the developer)' : ''}${association}`;
}

function comments(list: readonly TriageComment[], logins: readonly string[]): string {
  return list.length === 0
    ? NOTHING
    : list.map((comment) => `- ${who(comment, logins)} on ${comment.createdAt}:\n  ${comment.body}`).join('\n');
}

/**
 * One card's evidence, as the classifier sees it. A pure function of the context so the whole prompt is assertable —
 * what reaches the model is the thing most worth being able to read back when a label comes out wrong.
 */
export function buildTriagePrompt(context: TriageContext): string {
  const lines = [
    `The developer's own GitHub accounts: ${context.logins.join(', ') || NOTHING}`,
    '',
    `ISSUE #${context.issueNumber}: ${context.title}`,
    `Board status: ${context.status ?? NOTHING}`,
    '',
    context.body || NOTHING,
    '',
    'Recent issue comments (oldest first):',
    comments(context.comments, context.logins),
  ];

  const pr = context.pullRequest;

  if (pr === null) {
    lines.push('', 'No pull request is linked to this issue.');

    return lines.join('\n');
  }

  const unresolved = pr.threads.filter((thread) => !thread.isResolved && !thread.isOutdated);

  lines.push(
    '',
    `PULL REQUEST #${pr.number}: ${pr.title}`,
    `Opened by: ${pr.author ?? 'unknown'}${mineOf(pr.author, context.logins)}`,
    `State: ${pr.state}${pr.isDraft ? ' (draft)' : ''}`,
    `Review decision: ${pr.reviewDecision ?? NOTHING}`,
    `Reviewers asked for: ${pr.reviewRequests.join(', ') || NOTHING}`,
    `Reviews submitted: ${pr.reviews.map((r) => `${r.author ?? 'someone'} ${r.state}`).join('; ') || NOTHING}`,
    '',
    pr.body || NOTHING,
    '',
    'Recent pull request comments (oldest first):',
    comments(pr.comments, context.logins),
    '',
    `Unresolved review threads (${unresolved.length}):`,
    unresolved.length === 0
      ? NOTHING
      : unresolved.map((thread) => comments(thread.comments, context.logins)).join('\n'),
  );

  return lines.join('\n');
}

function mineOf(login: string | null, logins: readonly string[]): string {
  return login !== null && logins.some((own) => own.toLowerCase() === login.toLowerCase()) ? ' (the developer)' : '';
}
