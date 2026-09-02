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
 * Session ids, timings and links are kept — they carry no names and the tests turn on them. Everything that spells
 * out real work is rebuilt: a branch, the checkout path it sits in, and the display name derived from both.
 */
function anonymiseSessions(sessions) {
  const roots = new Map();

  return sessions.map((session) => {
    if (session.issueNumber !== null) {
      const name = slug(session.issueNumber);

      return {
        ...session,
        name: session.name === null ? null : `${name}-${session.sessionId.slice(0, 2)}`,
        cwd: `d:/checkouts/${name}`,
        branch: session.branch === null ? null : name,
      };
    }

    // An unlinked session still runs somewhere real. One synthetic checkout per distinct one keeps them distinct.
    const root = roots.get(session.cwd) ?? `d:/checkouts/project-${roots.size + 1}`;
    roots.set(session.cwd, root);

    return {
      ...session,
      name: session.name === null ? null : `${root.split('/').pop()}-${session.sessionId.slice(0, 2)}`,
      cwd: root,
      branch: session.branch === null ? null : 'main',
    };
  });
}

/** Issue numbers are kept: the tests turn on which sessions link to which issue, and an integer names nobody. */
function anonymiseIssues(cards) {
  const seen = new Map();

  return cards.map((card) => ({
    ...card,
    title: title(card.number),
    url: `https://github.com/${REPO}/issues/${card.number}`,
    assignees: logins(card.assignees, seen),
  }));
}

/**
 * Fails the recording rather than writing a fixture that still names something real. The tests cannot catch this —
 * they only ever see anonymised output, so an anonymiser that stopped scrubbing would leave them green.
 */
function assertScrubbed(recorded, written) {
  const json = JSON.stringify(written);

  const real = [
    ...recorded.issues.flatMap((i) => [i.title, i.url, ...i.assignees]),
    ...recorded.sessions.flatMap((s) => [s.cwd, s.name, s.branch]),
  ].filter((value) => typeof value === 'string' && value.length > 4 && value !== 'main');

  const leaked = [...new Set(real)].filter((value) => json.includes(value));

  if (leaked.length > 0) {
    throw new Error(`anonymise left ${leaked.length} identifying value(s) in the fixtures: ${leaked.slice(0, 5).join(', ')}`);
  }
}

module.exports = { REPO, anonymiseIssues, anonymiseSessions, assertScrubbed };
