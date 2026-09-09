// Scrub issue text, repositories, and accounts on every recording for this public repository.
const { title } = require('../../../../tools/fixture-words.js');
const { assertNoAbsolutePaths } = require('../../../../tools/fixture-scrub.js');

const REPO = 'example-org/example-repo';

/** The one synthetic root every scrubbed session sits under, so the path sweep has exactly one prefix to strike out. */
const CHECKOUTS = 'd:/checkouts';

/** One synthetic login per real one, so two cards assigned to the same person still look like it. */
function logins(assignees, seen) {
  return assignees.map((login) => {
    const known = seen.get(login);

    if (known) {
      return known;
    }

    const replacement = `dev-${seen.size + 1}`;
    seen.set(login, replacement);

    return replacement;
  });
}

/** A branch name spells out the work it is for, so it is rebuilt from the synthetic title for the same number. */
function slug(number) {
  return `${number}-${title(number).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}`;
}

/** Allow only known neutral CLI values unchanged. Rebuild work-specific fields and reject unknown keys. */
const NEUTRAL_DETAIL_KEYS = new Set(['kind', 'status', 'state', 'waitingFor']);

/** The two `details` keys that name real work: Claude derives `name` from the directory, and `shortId` is its own id. */
function detailsFor(details, replacement, sessionId) {
  const written = {};

  for (const [key, value] of Object.entries(details)) {
    if (key === 'name') {
      written[key] = `${replacement}-${sessionId.slice(0, 2)}`;
      continue;
    }

    if (key === 'shortId') {
      written[key] = sessionId.slice(0, 6);
      continue;
    }

    written[key] = value;
  }

  return written;
}

/** A canonical remote identity in the shape `repositoryKey` produces, under the same synthetic owner as every issue URL. */
function remote(name) {
  return `github.com/${REPO.split('/')[0]}/${name}`.toLowerCase();
}

/** Preserve IDs, timestamps, relationships, and activity. Scrub branches, paths, names, and titles. */
function anonymiseSessions(sessions) {
  const roots = new Map();

  return sessions.map((session, index) => {
    if (session.issueNumber !== null) {
      const name = slug(session.issueNumber);

      return {
        ...session,
        title: session.title === null ? null : title(session.issueNumber),
        cwd: `${CHECKOUTS}/${name}`,
        checkoutRoot: session.checkoutRoot === null ? null : `${CHECKOUTS}/${name}`,
        branch: session.branch === null ? null : name,
        repository: session.repository === null ? null : `github.com/${REPO}`,
        details: detailsFor(session.details, name, session.sessionId),
      };
    }

    // An unlinked session still runs somewhere real. One synthetic checkout per distinct one keeps them distinct.
    const root = roots.get(session.cwd) ?? `${CHECKOUTS}/project-${roots.size + 1}`;
    roots.set(session.cwd, root);

    return {
      ...session,
      title: session.title === null ? null : title(index),
      cwd: root,
      checkoutRoot: session.checkoutRoot === null ? null : root,
      branch: session.branch === null ? null : 'main',
      repository: session.repository === null ? null : remote(root.split('/').pop()),
      details: detailsFor(session.details, root.split('/').pop(), session.sessionId),
    };
  });
}

/** Issue numbers are kept: the tests turn on which sessions link to which issue, and an integer names nobody. */
function anonymiseIssues(cards) {
  const seen = new Map();

  return cards.map((card) => {
    const assignees = logins(card.assignees, seen);
    const [avatarLogin] = card.avatar ? logins([card.avatar.login], seen) : [];
    const [prLogin] = card.pullRequest?.author ? logins([card.pullRequest.author], seen) : [];

    return {
      ...card,
      title: title(card.number),
      url: `https://github.com/${REPO}/issues/${card.number}`,
      assignees,
      avatar: card.avatar
        ? { ...card.avatar, login: avatarLogin, url: `https://avatars.githubusercontent.com/${avatarLogin}?s=40` }
        : null,
      pullRequest: card.pullRequest
        ? {
            ...card.pullRequest,
            url: `https://github.com/${REPO}/pull/${card.pullRequest.number}`,
            author: card.pullRequest.author ? prLogin : null,
          }
        : null,
    };
  });
}

/** Reject unsanitized recordings before writing; tests only see the saved, scrubbed output. */
function assertScrubbed(recorded, written) {
  const json = JSON.stringify(written);

  const real = [
    ...recorded.issues.flatMap((i) => [
      i.title,
      i.url,
      ...i.assignees,
      i.avatar?.login,
      i.avatar?.url,
      i.pullRequest?.url,
      i.pullRequest?.author,
    ]),
    // Check that work-specific values were removed; retain neutral CLI vocabulary.
    ...recorded.sessions.flatMap((s) => [
      s.cwd,
      s.checkoutRoot,
      s.branch,
      s.repository,
      s.title,
      ...Object.entries(s.details).flatMap(([key, value]) => (NEUTRAL_DETAIL_KEYS.has(key) ? [] : [value])),
    ]),
  ].filter((value) => typeof value === 'string' && value.length > 4 && value !== 'main');

  const leaked = [...new Set(real)].filter((value) => json.includes(value));

  if (leaked.length > 0) {
    throw new Error(`anonymise left ${leaked.length} identifying value(s) in the fixtures: ${leaked.slice(0, 5).join(', ')}`);
  }

  // Reject unknown details keys so new adapter fields cannot bypass scrubbing.
  const unknown = [
    ...new Set(written.sessions.flatMap((s) => Object.keys(s.details))),
  ].filter((key) => key !== 'name' && key !== 'shortId' && !NEUTRAL_DETAIL_KEYS.has(key));

  if (unknown.length > 0) {
    throw new Error(`anonymise does not know how to scrub these session details: ${unknown.join(', ')}`);
  }

  // Also detect unenumerated absolute paths and alternate drive-letter casing.
  assertNoAbsolutePaths(json, [CHECKOUTS]);
}

module.exports = { CHECKOUTS, REPO, anonymiseIssues, anonymiseSessions, assertScrubbed };
