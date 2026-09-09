// Scrubs a recorded triage context. Unlike the search fixtures, this shape is almost entirely free text written by
// named colleagues on a private repository, so every body is overwritten wholesale rather than matched — no list of
// logins or paths will ever catch what somebody wrote about their own work (`docs/testing.md`).
//
// What survives is the structure the tests turn on: issue and pull request numbers, who wrote what and in what order,
// author associations, review states, thread resolution, timestamps, and every merge and check field.
const { remark, title } = require('../../../../tools/fixture-words.js');
const { UNIVERSAL, branchFor } = require('../../../../tools/fixture-scrub.js');
const { loginMap } = require('./anonymise.js');

/** Long enough to cross the reader's own body limit, so one fixture proves the middle is what comes out. */
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

  // A branch with no issue number in it is still somebody's words. It gets a synthetic name seeded by its own, so
  // two different such branches do not collapse into one.
  return branchFor(Number(number ?? [...ref].reduce((sum, c) => sum + c.charCodeAt(0), 0)));
}

/** A profile name identifies somebody far more surely than a login does, so it is replaced wherever it is carried. */
function scrubActor(actor, logins) {
  if (!actor) {
    return;
  }

  if (actor.login) {
    actor.login = logins.of(actor.login);
  }

  // Two words, because the board shows a first name and one fixture has to prove which word that is.
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

/** Rewrites every field that spells out real work, leaving every field a test reads structure from. */
function anonymiseContext(response, logins, { longBody = false } = {}) {
  const repository = response?.data?.repository;
  const issue = repository?.issue;

  if (issue) {
    issue.title = title(issue.number);
    issue.body = longBody ? remark(issue.number, 0, LONG_BODY_CHARS) : remark(issue.number, 0);
    scrubComments(issue.comments?.nodes, issue.number, logins, 1);

    // Who moved a card names them as surely as a comment author does. The statuses themselves stay: they are the
    // project's own column names, the tests turn on them, and the shipped defaults already carry the same list.
    for (const node of issue.timelineItems?.nodes ?? []) {
      scrubActor(node.actor, logins);

      if (node.assignee?.login) {
        node.assignee.login = logins.of(node.assignee.login);
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

      // A team is named the way a person is, because a team name identifies the employer as surely as a login does.
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

/** Every string the recording carried that a reader could identify somebody or something real by. */
function identifyingValues(response) {
  const repository = response?.data?.repository;
  const issue = repository?.issue;
  const pr = repository?.pullRequest;
  const synthetic = (login) => /^dev-\d+(-[a-z0-9-]+)?$/.test(login ?? '');
  /** Both halves of an author: the login, and the profile name, which no login list would ever have caught. */
  const named = (actor) => [synthetic(actor?.login) ? null : actor?.login, actor?.name];
  const fromComments = (nodes) => (nodes ?? []).flatMap((node) => [node.body, ...named(node.author)]);

  return [
    issue?.title,
    issue?.body,
    ...fromComments(issue?.comments?.nodes),
    ...(issue?.timelineItems?.nodes ?? []).flatMap((node) => [
      ...named(node.actor),
      synthetic(node.assignee?.login) ? null : node.assignee?.login,
    ]),
    pr?.title,
    pr?.body,
    // A recorded branch name that survived would name real work. The branches every repository has are excluded:
    // they name nobody, and the tests turn on a base either matching the default branch or not.
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

/**
 * Fails the run rather than writing a fixture that still names something real, and asserts twice: that every value it
 * set out to replace is gone, and that nothing of the shape it scrubs survives at all. The second is what catches a
 * name the recorder never enumerated — a URL inside a comment, an email in a signature.
 */
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

  // The sweep the first assertion passes over: anything shaped like a link, an address or a mention, wherever it sits.
  const shapes = [/https?:\/\/\S+/g, /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, /(^|\s)@[\w-]{2,}/g];
  const survivors = shapes.flatMap((shape) => json.match(shape) ?? []);

  if (survivors.length > 0) {
    throw new Error(`anonymise-context left ${survivors.length} link/address/mention(s): ${survivors.slice(0, 3).join(' | ')}`);
  }

  // The same sweep for branch names, which is what catches one arriving in a field nobody enumerated — a `headRef`
  // the query grows, a merge-queue entry. Every ref-shaped value must be one `branchFor` would have written.
  const refs = [...new Set(json.match(/"\d+-[a-z][a-z0-9-]{3,}"/g) ?? [])].map((ref) => ref.slice(1, -1));
  const invented = refs.filter((ref) => ref !== branchFor(Number(/^(\d+)-/.exec(ref)[1])));

  if (invented.length > 0) {
    throw new Error(`anonymise-context left ${invented.length} recorded branch name(s): ${invented.slice(0, 3).join(' | ')}`);
  }
}

module.exports = { anonymiseContext, assertContextScrubbed, loginMap };
