import type { TriageAction, TriageComment, TriageContext } from '@ground-control/core';
import { TRIAGE_LABELS } from './triage.js';
import { collapseStateChanges, foldInstruction, liveComments } from './stateChanges.js';
import type { TriageInstruction, TriageStateChange } from './stateChanges.js';

/** Who a login really is, where GitHub's own answer is not the person. Keyed by login, matched however it is cased. */
export type NameOverrides = Readonly<Record<string, string>>;

/**
 * What the classifier is told it is doing. Short on purpose: the whole system prompt and every tool definition cost
 * 55× the evidence itself (`docs/mechanics.md` §31), so this replaces the CLI's own rather than appending to it.
 *
 * It covers both asks, because a card whose action the evidence already settled is sent to the same session with the
 * same system prompt and asked only for the sentence — one prompt, and the schema is what enforces which.
 */
export const TRIAGE_SYSTEM_PROMPT = `Classify what one software work item is waiting on, and write one sentence about it for the developer whose board
it is. Everything here is addressed to that developer as "you" — the evidence below, and the sentence alike.

The evidence is an issue, its recent activity, and the pull request that would close it, if there is one.
Answer with one sentence, under 160 characters, and with an action where you are asked for one.

The sentence is logistics, not engineering: where the card stands and whose move it is. Call people by the name
the evidence gives them, and name the pull request. Do not summarise the change, the review comments or the cause,
and do not name a file, a class or a commit. Write "Sent back to you for re-review", not "Chris fixed x and y and
declined z because …".

Count nothing, in digits or in words. Only the most recent few comments and threads are shown, so every total is a
guess. Write "Mayur has some questions", never "Mayur asked five questions".

The activity is one list, oldest last. A line marked ► is a state change: somebody moved the card's status, or
handed it to somebody. The status says what the card needs; whoever it is assigned to says who does it. So a state
change is an instruction even where nobody wrote a word beside it, and the last one is the current word on the card.
Everything said before it has been answered by it — a question closed by a rewritten issue body and a move to the
next status leaves no reply on the thread. Read those comments for context and never for what to do next. Only what
was said after the last state change is still open.

Where you are asked for an action, choose it for what you must do NEXT.
Where more than one fits, take the first that applies:
1. resolve-conflicts: your branch will not merge — an auto-merge failed, or somebody reported a conflict
2. merge-upstream: your branch is behind and somebody has asked you to merge or rebase the base branch in
3. fix-checks: a build, a test run or a check on your pull request is failing
4. uat-failure: a tester has reported it does not work
5. uat-question: a tester has asked something about how it is meant to behave
6. answer-design-question: somebody has asked you a question the work cannot go on without
7. address-review: your own pull request has review comments to answer
8. review-others: a pull request that is not yours is waiting on your review
9. begin-work: the work itself is next, whether or not a pull request is open
10. other: the evidence points somewhere none of these names

A status naming review means a review is pending; "Opened by" says whose job that is. A pull request somebody else
opened is yours to review even when it cannot merge yet. Your own pull request, waiting on a reviewer or blocked
until something else lands, is somebody else's queue: answer other and say in the sentence what the card waits for.

Reading the evidence:
- Only the most recent few comments and review threads are shown, never all of them.
- A status naming UAT means a tester is involved. Each comment says how its author relates to the repository:
  somebody outside the team reporting how it behaves is UAT; a colleague asking how it should work is a design
  question.
- Your own words are marked "you". A question you asked that somebody has since answered is now yours to act on.
- The first three are reported, not observed. Take the most recent word: a conflict or a failing build somebody
  has since said is fixed is not what the card is waiting on.

An issue assigned to you with no discussion and no pull request is begin-work, not other. Pick other only when
none of the nine above fits.

Do not speculate about causes you have no evidence for.`;

/** How a body reads in the prompt when there is none. Blank would read as a comment somebody left empty. */
const NOTHING = '(none)';

/** Runs of whitespace, so a profile name is split on whatever separates its parts. */
const SPACES = /\s+/;

/** Whether a login is one of the developer's own. Matched however it is cased, the way the lane rules match. */
function own(login: string | null, logins: readonly string[]): boolean {
  return login !== null && logins.some((mine) => mine.toLowerCase() === login.toLowerCase());
}

/**
 * What somebody is called on a card: their first name, which is how a colleague is referred to in the sentence that
 * comes back. An override outranks the profile name — an agent account's profile names the agent rather than whoever
 * drives it — and the login stands in where there is neither, which is what a bot has.
 */
export function nameOf(login: string | null, profile: string | null, names: NameOverrides): string {
  const override = login === null ? undefined : names[login] ?? names[login.toLowerCase()];
  const shown = (override ?? profile ?? login ?? '').trim();

  return shown === '' ? 'someone' : shown.split(SPACES)[0]!;
}

function who(comment: TriageComment, logins: readonly string[], names: NameOverrides): string {
  // `NONE` is GitHub's word for somebody with no relationship to the repository, and rendered raw it reads as an
  // error rather than as the fact it is — which is the fact that most often separates a tester from a colleague.
  const association =
    comment.authorAssociation === null || comment.authorAssociation === 'NONE'
      ? ', not a member of the repository'
      : `, ${comment.authorAssociation.toLowerCase()}`;

  // The developer is "you", because the sentence is written to them. Which words are their own is also what tells a
  // question they asked from a question they were asked, and decides between two of the actions on its own.
  const author = own(comment.author, logins) ? 'you' : nameOf(comment.author, comment.authorName, names);

  return `${author}${association}`;
}

function comments(list: readonly TriageComment[], logins: readonly string[], names: NameOverrides): string {
  return list.length === 0
    ? NOTHING
    : list.map((comment) => `- ${who(comment, logins, names)} on ${comment.createdAt}:\n  ${comment.body}`).join('\n');
}

/** Somebody who moved a card, as the chronology names them. The developer is "you" here as everywhere else. */
function actorOf(change: { actor: string | null; actorName: string | null }, logins: readonly string[], names: NameOverrides): string {
  return own(change.actor, logins) ? 'you' : nameOf(change.actor, change.actorName, names);
}

/** One act on the card's state, in a line. Marked, so the model can tell an instruction from something somebody said. */
function stateLine(change: TriageStateChange, logins: readonly string[], names: NameOverrides): string {
  const parts: string[] = [];

  if (change.to !== null) {
    parts.push(change.from === null || change.from === '' ? `set the status to ${change.to}` : `moved the status ${change.from} → ${change.to}`);
  }

  const handed = change.assigned.map((login) => (own(login, logins) ? 'you' : nameOf(login, null, names)));

  if (handed.length > 0) {
    parts.push(`handed it to ${handed.join(' and ')}`);
  }

  const off = change.unassigned.filter((login) => !change.assigned.includes(login));

  if (off.length > 0) {
    parts.push(`took ${off.map((login) => (own(login, logins) ? 'you' : nameOf(login, null, names))).join(' and ')} off it`);
  }

  return `► ${actorOf(change, logins, names)} on ${change.at}: ${parts.join(', ') || 'changed its state'}`;
}

/** The header a card leads with: what it was last told to be, and by whom. */
function instructionLine(instruction: TriageInstruction, status: string | null, logins: readonly string[], names: NameOverrides): string {
  const actor = actorOf(instruction, logins, names);
  const now = status ?? NOTHING;
  const moved = instruction.from === null || instruction.from === '' ? `The status is ${now}` : `moving it ${instruction.from} → ${now}`;

  return instruction.handedOver
    ? `${actor} handed this to you on ${instruction.at}, ${moved}.`
    : `${actor} last changed its state on ${instruction.at}, ${moved}.`;
}

/**
 * One card's evidence, as the classifier sees it. A pure function of the context so the whole prompt is assertable —
 * what reaches the model is the thing most worth being able to read back when a label comes out wrong. `settled` is
 * the action the evidence already decided, which the model is told rather than asked for.
 */
export function buildTriagePrompt(
  context: TriageContext,
  now: number,
  names: NameOverrides = {},
  settled: TriageAction | null = null,
): string {
  const changes = collapseStateChanges(context.stateEvents);
  const instruction = foldInstruction(changes, context.logins);
  const live = liveComments(context.comments, instruction);

  const activity = [
    ...context.comments.map((comment) => ({
      at: comment.createdAt,
      line: `- ${who(comment, context.logins, names)} on ${comment.createdAt}:\n  ${comment.body}`,
    })),
    ...changes.map((change) => ({ at: change.at, line: stateLine(change, context.logins, names) })),
  ]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((entry) => entry.line);

  const lines = [
    // Every entry carries an ISO timestamp and three of the actions turn on recency, which a model has no clock for.
    `Today is ${new Date(now).toISOString().slice(0, 10)}.`,
    '',
    `ISSUE #${context.issueNumber}: ${context.title}`,
    `Board status: ${context.status ?? NOTHING}`,
  ];

  if (instruction !== null) {
    lines.push(
      instructionLine(instruction, context.status, context.logins, names),
      live.length === 0
        ? 'Nothing has been said on the issue since. Every comment below is background.'
        : 'Only what was said after that is still open.',
    );
  }

  lines.push(
    '',
    context.body || NOTHING,
    '',
    'Recent activity — comments and state changes, oldest first:',
    activity.length === 0 ? NOTHING : activity.join('\n'),
  );

  const pr = context.pullRequest;

  if (pr === null) {
    lines.push('', 'No pull request is linked to this issue.');

    return finish(lines, settled);
  }

  const unresolved = pr.threads.filter((thread) => !thread.isResolved && !thread.isOutdated);

  lines.push(
    '',
    `PULL REQUEST #${pr.number}: ${pr.title}`,
    `Opened by: ${own(pr.author, context.logins) ? 'you' : nameOf(pr.author, pr.authorName, names)}`,
    `State: ${pr.state}${pr.isDraft ? ' (draft)' : ''}`,
    `Review decision: ${pr.reviewDecision ?? NOTHING}`,
    `Reviewers asked for: ${pr.reviewRequests.map((r) => shown(r.login, r.name, context.logins, names)).join(', ') || NOTHING}`,
    `Reviews submitted: ${pr.reviews.map((r) => `${shown(r.author, r.authorName, context.logins, names)} ${r.state}`).join('; ') || NOTHING}`,
    '',
    pr.body || NOTHING,
    '',
    'Recent pull request comments (the most recent few, oldest first):',
    comments(pr.comments, context.logins, names),
    '',
    'Unresolved review threads (the most recent few):',
    unresolved.length === 0
      ? NOTHING
      : // Numbered because joined flat, three threads read as one thread with three comments: whether a reviewer is
        // still waiting on one thing or on several is what separates a loose end from a round that has to be worked.
        unresolved
          .map((thread, n) => `Thread ${n + 1}:\n${comments(thread.comments, context.logins, names)}`)
          .join('\n'),
  );

  return finish(lines, settled);
}

/** The ask, last, so it is the final thing the model reads before it answers. */
function finish(lines: string[], settled: TriageAction | null): string {
  lines.push(
    '',
    settled === null
      ? 'Answer with the action and the sentence.'
      : `The action is already decided: ${settled} — ${TRIAGE_LABELS[settled]}. Write only the sentence, and write it as though that is what the card says.`,
  );

  return lines.join('\n');
}

/** Somebody on a pull request line: the developer as "you", anybody else by name. */
function shown(login: string | null, profile: string | null, logins: readonly string[], names: NameOverrides): string {
  return own(login, logins) ? 'you' : nameOf(login, profile, names);
}
