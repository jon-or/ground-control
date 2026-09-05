// Scrubs a recorded triage context. Unlike the search fixtures, this shape is almost entirely free text written by
// named colleagues on a private repository, so every body is overwritten wholesale rather than matched — no list of
// logins or paths will ever catch what somebody wrote about their own work (`docs/testing.md`).
//
// What survives is the structure the tests turn on: issue and pull request numbers, who wrote what and in what order,
// author associations, review states, thread resolution, timestamps, and every merge and check field.
const { remark, title } = require('../../../../tools/fixture-words.js');
const { loginMap } = require('./anonymise.js');

/** Long enough to cross the reader's own body limit, so one fixture proves clipping happens. */
const LONG_BODY_CHARS = 2_600;

function scrubComments(nodes, number, logins, offset = 0) {
  (nodes ?? []).forEach((node, i) => {
    node.body = remark(number, offset + i);

    if (node.author) {
      node.author.login = logins.of(node.author.login);
    }
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
  }

  const pr = repository?.pullRequest;

  if (pr) {
    pr.title = title(pr.number);
    pr.body = remark(pr.number, 0);

    if (pr.author) {
      pr.author.login = logins.of(pr.author.login);
    }

    scrubComments(pr.comments?.nodes, pr.number, logins, 1);

    for (const review of pr.reviews?.nodes ?? []) {
      if (review.author) {
        review.author.login = logins.of(review.author.login);
      }
    }

    for (const request of pr.reviewRequests?.nodes ?? []) {
      const reviewer = request.requestedReviewer;

      if (reviewer?.login) {
        reviewer.login = logins.of(reviewer.login);
      }

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
  const fromComments = (nodes) =>
    (nodes ?? []).flatMap((node) => [node.body, synthetic(node.author?.login) ? null : node.author?.login]);

  return [
    issue?.title,
    issue?.body,
    ...fromComments(issue?.comments?.nodes),
    pr?.title,
    pr?.body,
    synthetic(pr?.author?.login) ? null : pr?.author?.login,
    ...fromComments(pr?.comments?.nodes),
    ...(pr?.reviews?.nodes ?? []).map((r) => (synthetic(r.author?.login) ? null : r.author?.login)),
    ...(pr?.reviewRequests?.nodes ?? []).flatMap((r) => [
      synthetic(r.requestedReviewer?.login) ? null : r.requestedReviewer?.login,
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
}

module.exports = { anonymiseContext, assertContextScrubbed, loginMap };
