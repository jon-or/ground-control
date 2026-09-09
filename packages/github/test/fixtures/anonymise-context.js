// Replace all free-text bodies, names, and nonstandard branches in recorded triage context.
// Preserve issue/PR numbers, authorship relationships, order, associations, review states,
// thread resolution, timestamps, and merge/check fields (docs/testing.md).
const { remark, title } = require('../../../../tools/fixture-words.js');
const { UNIVERSAL, branchFor } = require('../../../../tools/fixture-scrub.js');
const { loginMap, ownerMap, recordedOwner } = require('./anonymise.js');

/** Exceed the body limit to verify middle clipping. */
const LONG_BODY_CHARS = 7_500;

/**
 * Scrub branch text while preserving issue numbers and shared fixture naming. Keep universal branches such as
 * master unchanged so base/default-branch comparisons remain representative (R39).
 */
function scrubBranch(ref) {
  if (typeof ref !== 'string' || ref === '' || UNIVERSAL.has(ref)) {
    return ref;
  }

  const number = /^(\d+)-/.exec(ref)?.[1];

  // Derive a synthetic seed from nonnumeric branch names to preserve distinctions.
  return branchFor(Number(number ?? [...ref].reduce((sum, c) => sum + c.charCodeAt(0), 0)));
}

/** Replace both login and profile name wherever present. */
function scrubActor(actor, logins) {
  if (!actor) {
    return;
  }

  if (actor.login) {
    actor.login = logins.of(actor.login);
  }

  // Use two words to verify first-name display.
  if (typeof actor.name === 'string') {
    actor.name = `${logins.of(actor.login ?? actor.name)} Surname`;
  }
}

function scrubComments(nodes, number, logins, offset = 0) {
  (nodes ?? []).forEach((node, i) => {
    node.body = remark(number, offset + i);
    scrubActor(node.author, logins);
  });
}

/** Replace identifying text while preserving test-relevant structure. */
function anonymiseContext(response, logins, { longBody = false, owners = ownerMap() } = {}) {
  const repository = response?.data?.repository;
  const issue = repository?.issue;

  if (issue) {
    issue.title = title(issue.number);
    issue.body = longBody ? remark(issue.number, 0, LONG_BODY_CHARS) : remark(issue.number, 0);
    scrubComments(issue.comments?.nodes, issue.number, logins, 1);

    // Scrub timeline actors. Retain project status names used by tests and shipped defaults.
    for (const node of issue.timelineItems?.nodes ?? []) {
      scrubActor(node.actor, logins);

      if (node.assignee?.login) {
        node.assignee.login = logins.of(node.assignee.login);
      }

      if (node.project?.owner?.login) {
        node.project.owner.login = owners.of(node.project.owner.login);
      }
    }
  }

  const pr = repository?.pullRequest;

  if (pr) {
    pr.title = title(pr.number);
    pr.body = remark(pr.number, 0);
    pr.baseRefName = scrubBranch(pr.baseRefName);
    pr.headRefName = scrubBranch(pr.headRefName);
    scrubActor(pr.author, logins);
    scrubComments(pr.comments?.nodes, pr.number, logins, 1);

    for (const review of pr.reviews?.nodes ?? []) {
      scrubActor(review.author, logins);
    }

    for (const request of pr.reviewRequests?.nodes ?? []) {
      const reviewer = request.requestedReviewer;
      scrubActor(reviewer, logins);

      // Replace identifying team slugs with synthetic names.
      if (reviewer?.slug) {
        reviewer.slug = `team-${logins.of(reviewer.slug).replace(/^dev-/, '')}`;
      }
    }

    (pr.reviewThreads?.nodes ?? []).forEach((thread, i) => {
      scrubComments(thread.comments?.nodes, pr.number, logins, 20 + i * 5);
    });
  }

  return response;
}

/** Collect original identifying values for leak checks. */
function identifyingValues(response) {
  const repository = response?.data?.repository;
  const issue = repository?.issue;
  const pr = repository?.pullRequest;
  const synthetic = (login) => /^dev-\d+(-[a-z0-9-]+)?$/.test(login ?? '');
  /** Check both login and profile name. */
  const named = (actor) => [synthetic(actor?.login) ? null : actor?.login, actor?.name];
  const fromComments = (nodes) => (nodes ?? []).flatMap((node) => [node.body, ...named(node.author)]);

  return [
    issue?.title,
    issue?.body,
    ...fromComments(issue?.comments?.nodes),
    ...(issue?.timelineItems?.nodes ?? []).flatMap((node) => [
      ...named(node.actor),
      synthetic(node.assignee?.login) ? null : node.assignee?.login,
      recordedOwner(node.project),
    ]),
    pr?.title,
    pr?.body,
    // Exclude standard branches; base/default equality must remain testable.
    UNIVERSAL.has(pr?.baseRefName) ? null : pr?.baseRefName,
    UNIVERSAL.has(pr?.headRefName) ? null : pr?.headRefName,
    ...named(pr?.author),
    ...fromComments(pr?.comments?.nodes),
    ...(pr?.reviews?.nodes ?? []).flatMap((r) => named(r.author)),
    ...(pr?.reviewRequests?.nodes ?? []).flatMap((r) => [
      ...named(r.requestedReviewer),
      r.requestedReviewer?.slug?.startsWith('team-') ? null : r.requestedReviewer?.slug,
    ]),
    ...(pr?.reviewThreads?.nodes ?? []).flatMap((t) => fromComments(t.comments?.nodes)),
  ];
}

/** Reject original values and unrecognized links, email addresses, mentions, or branch names before writing. */
function assertContextScrubbed(recorded, written, logins) {
  const json = JSON.stringify(written);

  const real = [
    ...recorded.flatMap(identifyingValues),
    ...logins.pairs().filter(([from, to]) => from !== to).map(([from]) => from),
  ].filter((value) => typeof value === 'string' && value.length > 3);

  const leaked = [...new Set(real)].filter((value) => json.includes(value));

  if (leaked.length > 0) {
    throw new Error(`anonymise-context left ${leaked.length} recorded value(s): ${leaked.slice(0, 3).map((v) => v.slice(0, 60)).join(' | ')}`);
  }

  // Check links, email addresses, and mentions in all fields.
  const shapes = [/https?:\/\/\S+/g, /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, /(^|\s)@[\w-]{2,}/g];
  const survivors = shapes.flatMap((shape) => json.match(shape) ?? []);

  if (survivors.length > 0) {
    throw new Error(`anonymise-context left ${survivors.length} link/address/mention(s): ${survivors.slice(0, 3).join(' | ')}`);
  }

  // Check all branch-shaped values against branchFor, including fields added to future queries.
  const refs = [...new Set(json.match(/"\d+-[a-z][a-z0-9-]{3,}"/g) ?? [])].map((ref) => ref.slice(1, -1));
  const invented = refs.filter((ref) => ref !== branchFor(Number(/^(\d+)-/.exec(ref)[1])));

  if (invented.length > 0) {
    throw new Error(`anonymise-context left ${invented.length} recorded branch name(s): ${invented.slice(0, 3).join(' | ')}`);
  }
}

module.exports = { anonymiseContext, assertContextScrubbed, loginMap };
