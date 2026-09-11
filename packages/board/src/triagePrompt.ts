import type { TriageAction, TriageComment, TriageContext } from '@ground-control/core';
import { TRIAGE_LABELS } from './triage.js';
import { collapseStateChanges, foldInstruction, liveComments } from './stateChanges.js';
import type { TriageInstruction, TriageStateChange } from './stateChanges.js';

/**
 * Replace the CLI system prompt to reduce classification cost (mechanics M31). Both schemas share this prompt; the
 * schema determines whether an action is requested.
 */
export const TRIAGE_SYSTEM_PROMPT = `Classify the developer's next action from the issue, recent activity, and linked pull request.
Address the developer as "you". Write one sentence under 160 characters, plus an action when requested.

Describe the status and who needs to act. Use the supplied names and identify the pull request.
Do not summarise the change, review comments, or causes, or name files, classes, or commits.
For example: "Sent back to you for re-review".

Do not give counts in digits or words: comments and threads are partial. Write "Mayur has some questions",
never "Mayur asked five questions".

Activity is listed oldest first. Lines marked ► are status or assignment changes. Treat the latest change as
the current instruction, even without a comment: status determines the work; assignment determines who acts.
Earlier comments are background, even if their threads have no reply. Only comments since that change remain open.

When asked for an action, take the first that applies:
1. merge-upstream: somebody has asked you to merge or rebase the base branch into yours
2. fix-checks: a build, a test run or a check on your pull request is failing
3. qa-failure: a tester has reported it does not work
4. qa-question: a tester has asked something about how it is meant to behave
5. dev-question: somebody has asked you a question that blocks further work
6. address-review: your own pull request has review comments to answer
7. review-others: somebody else's pull request needs your review
8. develop: development work is next, whether started or unstarted
9. other: none of the preceding actions applies

Review status means a review is pending. Use "Opened by" to identify whose review it is.
Review somebody else's pull request even when it cannot merge yet. For your own PR awaiting a reviewer or a
dependency, answer other and explain what it awaits.

UAT or QA status means a tester is involved; classify both teams as qa. Use author associations to distinguish outside
testers reporting behavior from colleagues asking development questions.
Your comments are marked "you". When someone answers your question, you need to act on the answer.
Merge requests and failing checks are reported evidence. Prefer the latest report; do not classify a problem
as pending after someone reports it fixed. A branch that will not merge is not yours to fix.

An assigned issue with no discussion or pull request is develop, not other. Use other only if no listed action fits.
Do not speculate about unsupported causes.`;

/** Explicit placeholder for missing text. */
const NO_TEXT = '(none)';

/** Profile-name word separator. */
const SPACES = /\s+/;

/** Match developer logins case-insensitively. */
function isDeveloperLogin(login: string | null, logins: readonly string[]): boolean {
  return login !== null && logins.some((developerLogin) => developerLogin.toLowerCase() === login.toLowerCase());
}

/** Use the first word of the profile name, or the login. */
export function nameOf(login: string | null, profile: string | null): string {
  const displayName = (profile ?? login ?? '').trim();

  return displayName === '' ? 'someone' : displayName.split(SPACES)[0]!;
}

function commentAuthor(comment: TriageComment, logins: readonly string[]): string {
  // Explain GitHub NONE association so the classifier can distinguish outside testers from colleagues.
  const association =
    comment.authorAssociation === null || comment.authorAssociation === 'NONE'
      ? ', not a member of the repository'
      : `, ${comment.authorAssociation.toLowerCase()}`;

  // Identify developer comments as "you" to distinguish asked from received questions.
  const author = isDeveloperLogin(comment.author, logins) ? 'you' : nameOf(comment.author, comment.authorName);

  return `${author}${association}`;
}

function comments(list: readonly TriageComment[], logins: readonly string[]): string {
  return list.length === 0
    ? NO_TEXT
    : list.map((comment) => `- ${commentAuthor(comment, logins)} on ${comment.createdAt}:\n  ${comment.body}`).join('\n');
}

/** Format the state-change actor, using "you" for the developer. */
function actorOf(change: { actor: string | null; actorName: string | null }, logins: readonly string[]): string {
  return isDeveloperLogin(change.actor, logins) ? 'you' : nameOf(change.actor, change.actorName);
}

/** Marked state-change summary for distinguishing instructions from comments. */
function stateLine(change: TriageStateChange, logins: readonly string[]): string {
  const parts: string[] = [];

  if (change.to !== null) {
    parts.push(change.from === null || change.from === '' ? `set the status to ${change.to}` : `moved the status ${change.from} → ${change.to}`);
  }

  const assignees = change.assigned.map((login) => (isDeveloperLogin(login, logins) ? 'you' : nameOf(login, null)));

  if (assignees.length > 0) {
    parts.push(`assigned to ${assignees.join(' and ')}`);
  }

  const unassigned = change.unassigned.filter((login) => !change.assigned.includes(login));

  if (unassigned.length > 0) {
    parts.push(`unassigned ${unassigned.map((login) => (isDeveloperLogin(login, logins) ? 'you' : nameOf(login, null))).join(' and ')}`);
  }

  return `► ${actorOf(change, logins)} on ${change.at}: ${parts.join(', ') || 'changed its state'}`;
}

/** Summarize the latest state instruction and actor. */
function instructionLine(instruction: TriageInstruction, status: string | null, logins: readonly string[]): string {
  const actor = actorOf(instruction, logins);
  const currentStatus = status ?? NO_TEXT;
  const moved = instruction.from === null || instruction.from === '' ? `status ${currentStatus}` : `status ${instruction.from} → ${currentStatus}`;

  return instruction.handedOver
    ? `${actor} assigned this to you on ${instruction.at}, ${moved}.`
    : `${actor} last changed its state on ${instruction.at}, ${moved}.`;
}

/** Build the classifier input from recorded context. A settled action requests only its explanation. */
export function buildTriagePrompt(
  context: TriageContext,
  now: number,
  settled: TriageAction | null = null,
): string {
  const changes = collapseStateChanges(context.stateEvents);
  const instruction = foldInstruction(changes, context.logins);
  const currentComments = liveComments(context.comments, instruction);

  const activity = [
    ...context.comments.map((comment) => ({
      at: comment.createdAt,
      line: `- ${commentAuthor(comment, context.logins)} on ${comment.createdAt}:\n  ${comment.body}`,
    })),
    ...changes.map((change) => ({ at: change.at, line: stateLine(change, context.logins) })),
  ]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((entry) => entry.line);

  const lines = [
    // Include the current date for interpreting timestamped evidence.
    `Today is ${new Date(now).toISOString().slice(0, 10)}.`,
    '',
    `ISSUE #${context.issueNumber}: ${context.title}`,
    `Board status: ${context.status ?? NO_TEXT}`,
  ];

  if (instruction !== null) {
    lines.push(
      instructionLine(instruction, context.status, context.logins),
      currentComments.length === 0
        ? 'No issue comments since this change. Earlier comments are background.'
        : 'Only comments since this change remain open.',
    );
  }

  lines.push(
    '',
    context.body || NO_TEXT,
    '',
    'Recent activity — comments and state changes, oldest first:',
    activity.length === 0 ? NO_TEXT : activity.join('\n'),
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
    `Opened by: ${isDeveloperLogin(pr.author, context.logins) ? 'you' : nameOf(pr.author, pr.authorName)}`,
    `State: ${pr.state}${pr.isDraft ? ' (draft)' : ''}`,
    `Requested reviewers: ${pr.reviewRequests.map((r) => displayName(r.login, r.name, context.logins)).join(', ') || NO_TEXT}`,
    `Reviews submitted: ${pr.reviews.map((r) => `${displayName(r.author, r.authorName, context.logins)} ${r.state}`).join('; ') || NO_TEXT}`,
    '',
    pr.body || NO_TEXT,
    '',
    'Recent pull request comments (the most recent few, oldest first):',
    comments(pr.comments, context.logins),
    '',
    'Unresolved review threads (the most recent few):',
    unresolved.length === 0
      ? NO_TEXT
      : // Numbered because joined flat, three threads read as one thread with three comments: whether a reviewer is
        // still waiting on one thing or on several is what separates a loose end from a round that has to be worked.
        unresolved
          .map((thread, n) => `Thread ${n + 1}:\n${comments(thread.comments, context.logins)}`)
          .join('\n'),
  );

  return finish(lines, settled);
}

/** Place the response instruction after the evidence. */
function finish(lines: string[], settled: TriageAction | null): string {
  lines.push(
    '',
    settled === null
      ? 'Answer with the action and the sentence.'
      : `The action is already decided: ${settled} — ${TRIAGE_LABELS[settled]}. Write one sentence explaining that action.`,
  );

  return lines.join('\n');
}

/** Format PR identities, using "you" for the developer. */
function displayName(login: string | null, profile: string | null, logins: readonly string[]): string {
  return isDeveloperLogin(login, logins) ? 'you' : nameOf(login, profile);
}
