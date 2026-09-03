// This repo is going public, so recorded fixtures carry no real issue text, repository, or account names. Applied
// by `record.js` on every recording: a hand-scrub would be undone by the next one.
const { title } = require('../../../../tools/fixture-words.js');

const REPO = 'example-org/example-repo';

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

/**
 * The `details` keys an agent may report whose value names no work of the developer's: a vocabulary word the CLI
 * chose, not a sentence about what is being built. Anything else is rebuilt below or fails the assertion, so the
 * next field an adapter adds to the bag cannot leak by being unknown to this file.
 */
const NEUTRAL_DETAIL_KEYS = new Set(['kind', 'status', 'state']);

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

/**
 * Session ids, timings, links and reported activity are kept — they carry no names and the tests turn on them.
 * Everything that spells out real work is rebuilt: a branch, the checkout path it sits in, the display name derived
 * from both, and the session's own title, which is a sentence about the work and so the most identifying of all.
 */
function anonymiseSessions(sessions) {
  const roots = new Map();

  return sessions.map((session, index) => {
    if (session.issueNumber !== null) {
      const name = slug(session.issueNumber);

      return {
        ...session,
        title: session.title === null ? null : title(session.issueNumber),
        cwd: `d:/checkouts/${name}`,
        branch: session.branch === null ? null : name,
        details: detailsFor(session.details, name, session.sessionId),
      };
    }

    // An unlinked session still runs somewhere real. One synthetic checkout per distinct one keeps them distinct.
    const root = roots.get(session.cwd) ?? `d:/checkouts/project-${roots.size + 1}`;
    roots.set(session.cwd, root);

    return {
      ...session,
      title: session.title === null ? null : title(index),
      cwd: root,
      branch: session.branch === null ? null : 'main',
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

/**
 * Fails the recording rather than writing a fixture that still names something real. The tests cannot catch this —
 * they only ever see anonymised output, so an anonymiser that stopped scrubbing would leave them green.
 */
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
    // Only the detail values that name real work. A neutral key's value is the CLI's own vocabulary word and is
    // kept deliberately, so asserting it is gone would fail every recording.
    ...recorded.sessions.flatMap((s) => [
      s.cwd,
      s.branch,
      s.title,
      ...Object.entries(s.details).flatMap(([key, value]) => (NEUTRAL_DETAIL_KEYS.has(key) ? [] : [value])),
    ]),
  ].filter((value) => typeof value === 'string' && value.length > 4 && value !== 'main');

  const leaked = [...new Set(real)].filter((value) => json.includes(value));

  if (leaked.length > 0) {
    throw new Error(`anonymise left ${leaked.length} identifying value(s) in the fixtures: ${leaked.slice(0, 5).join(', ')}`);
  }

  // The bag is open, so a key this file has never seen is one nothing above rebuilt. Failing the recording is the
  // only thing that catches the next agent-reported field: the tests only ever see scrubbed output.
  const unknown = [
    ...new Set(written.sessions.flatMap((s) => Object.keys(s.details))),
  ].filter((key) => key !== 'name' && key !== 'shortId' && !NEUTRAL_DETAIL_KEYS.has(key));

  if (unknown.length > 0) {
    throw new Error(`anonymise does not know how to scrub these session details: ${unknown.join(', ')}`);
  }
}

module.exports = { REPO, anonymiseIssues, anonymiseSessions, assertScrubbed };
