import type { TriageComment, TriageContext } from '@ground-control/core';

/**
 * What the classifier is told it is doing. Short on purpose: the whole system prompt and every tool definition cost
 * 55× the evidence itself (`docs/mechanics.md` §31), so this replaces the CLI's own rather than appending to it.
 *
 * It names only the eight actions the model decides. The four the hub reads off the pull request are left out of
 * both this and the schema, so a model cannot answer `land` about mergeability nobody has computed.
 */
export const TRIAGE_SYSTEM_PROMPT = [
  'You classify what one software work item is waiting on, for a developer looking at their own board.',
  'You are given an issue, its recent comments, and the pull request that would close it, if there is one.',
  'Answer with exactly one action and one sentence saying what the work is, in under 160 characters.',
  '',
  'Choose the action for what the developer must do NEXT. Where more than one fits, take the first that applies:',
  '1. uat-failure: a tester has reported it does not work',
  '2. uat-question: a tester has asked something about how it is meant to behave',
  '3. answer-design-question: somebody has asked them a question the work cannot go on without',
  '4. address-review: their own pull request has review comments to answer',
  '5. review-others: a pull request that is not theirs is waiting on their review',
  '6. awaiting-others: they are waiting on somebody else and it has not arrived; nothing for them to do now',
  '7. begin-work: assigned to them, nothing under way yet, the issue is the specification',
  '8. other: the evidence points somewhere none of these names',
  '',
  'Reading the evidence:',
  '- "Board status" names the stage the team has this at, and a status naming UAT means a tester is involved.',
  '- Each comment says how its author relates to the repository. Somebody outside the team reporting how it',
  '  behaves is UAT; a colleague asking how it should work is a design question.',
  "- The developer's own comments are marked. Read what came after them: a question they asked that somebody has",
  '  since answered is not awaiting-others, because the answer is now theirs to act on.',
  '',
  'An issue assigned to them with no discussion and no pull request is begin-work, not other. Pick other only when',
  'none of the seven above describes what is actually pending.',
  '',
  'The sentence describes the work, not your reasoning. Write it for somebody who already knows the project.',
  'Do not speculate about causes you have no evidence for.',
].join('\n');

/** How a body reads in the prompt when there is none. Blank would read as a comment somebody left empty. */
const NOTHING = '(none)';

function who(comment: TriageComment, logins: readonly string[]): string {
  const author = comment.author ?? 'someone';
  const own = logins.some((login) => login.toLowerCase() === author.toLowerCase());
  // `NONE` is GitHub's word for somebody with no relationship to the repository, and rendered raw it reads as an
  // error rather than as the fact it is — which is the fact that most often separates a tester from a colleague.
  const association =
    comment.authorAssociation === null || comment.authorAssociation === 'NONE'
      ? ', not a member of the repository'
      : `, ${comment.authorAssociation.toLowerCase()}`;

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
export function buildTriagePrompt(context: TriageContext, now: number): string {
  const lines = [
    // Every comment carries an ISO timestamp and three of the actions turn on recency, which a model has no clock for.
    `Today is ${new Date(now).toISOString().slice(0, 10)}.`,
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
      : // Numbered, because joined flat, three threads read as one thread with three comments — and how many
        // separate things a reviewer is still waiting on is most of what tells a first round from a last loose end.
        unresolved
          .map((thread, n) => `Thread ${n + 1}:\n${comments(thread.comments, context.logins)}`)
          .join('\n'),
  );

  return lines.join('\n');
}

function mineOf(login: string | null, logins: readonly string[]): string {
  return login !== null && logins.some((own) => own.toLowerCase() === login.toLowerCase()) ? ' (the developer)' : '';
}
