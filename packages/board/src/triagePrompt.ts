import type { TriageComment, TriageContext } from '@ground-control/core';

/**
 * What the classifier is told it is doing. Short on purpose: the whole system prompt and every tool definition cost
 * 55× the evidence itself (`docs/mechanics.md` §31), so this replaces the CLI's own rather than appending to it.
 *
 * `land` is the one action left out of both this and the schema: the model may report a problem somebody named, and
 * only the hub may say everything is fine. Where GitHub has computed a fact, `derivedAction` overrules whatever is
 * chosen here — but it is `UNKNOWN` in the window a card arrives, which is why the three problems are named below.
 */
export const TRIAGE_SYSTEM_PROMPT = `You classify what one software work item is waiting on, for a developer looking at their own board.
You are given an issue, its recent comments, and the pull request that would close it, if there is one.
Answer with one action and one sentence, under 160 characters.

The sentence is logistics, not engineering: where the card stands and whose move it is. Name the people and the
pull request. Do not summarise the change, the review comments or the cause, and do not name a file, a class or a
commit. Write "Sent back to Jon for re-review", not "Chris fixed x and y and declined z because …".

Count nothing, in digits or in words. You see only the most recent few comments and threads, so every total is a
guess. Write "Mayur has some questions", never "Mayur asked five questions". Write "buildfriday addressed the
findings", never "buildfriday addressed all nine findings".

Choose the action for what the developer must do NEXT. Where more than one fits, take the first that applies:
1. resolve-conflicts: their branch will not merge — an auto-merge failed, or somebody reported a conflict
2. merge-upstream: their branch is behind and somebody has asked them to merge or rebase the base branch in
3. fix-checks: a build, a test run or a check on their pull request is failing
4. uat-failure: a tester has reported it does not work
5. uat-question: a tester has asked something about how it is meant to behave
6. answer-design-question: somebody has asked them a question the work cannot go on without
7. address-review: their own pull request has review comments to answer
8. review-others: a pull request that is not theirs is waiting on their review
9. begin-work: assigned to them and the work itself is next, whether or not a pull request is open
10. other: the evidence points somewhere none of these names

The board status is the team's word on where the card is, and it outranks the conversation. A status naming review
means a review is pending; "Opened by" says whose job that is. A pull request somebody else opened is theirs to
review even when it cannot merge yet.

Read the last thing said on the issue. Work handed back to the developer — their question answered, requirements
finalised, tasking updated — is begin-work.

Their own pull request, waiting on a reviewer or blocked until something else lands, is somebody else's queue.
Where nothing is theirs to do, answer other and say in the sentence what the card waits for.

Reading the evidence:
- You are shown only the most recent few comments and review threads, never all of them.
- A status naming UAT means a tester is involved. Each comment says how its author relates to the repository:
  somebody outside the team reporting how it behaves is UAT; a colleague asking how it should work is a design
  question.
- The developer's own comments are marked. A question they asked that somebody has since answered is now theirs
  to act on.
- The first three are reported, not observed. Take the most recent word: a conflict or a failing build somebody
  has since said is fixed is not what the card is waiting on.

An issue assigned to them with no discussion and no pull request is begin-work, not other. Pick other only when
none of the nine above fits.

Do not speculate about causes you have no evidence for.`;

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
    'Recent issue comments (the most recent few, oldest first):',
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
    'Recent pull request comments (the most recent few, oldest first):',
    comments(pr.comments, context.logins),
    '',
    'Unresolved review threads (the most recent few):',
    unresolved.length === 0
      ? NOTHING
      : // Numbered because joined flat, three threads read as one thread with three comments: whether a reviewer is
        // still waiting on one thing or on several is what separates a loose end from a round that has to be worked.
        unresolved
          .map((thread, n) => `Thread ${n + 1}:\n${comments(thread.comments, context.logins)}`)
          .join('\n'),
  );

  return lines.join('\n');
}

function mineOf(login: string | null, logins: readonly string[]): string {
  return login !== null && logins.some((own) => own.toLowerCase() === login.toLowerCase()) ? ' (the developer)' : '';
}
