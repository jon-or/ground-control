// This repo is going public, so recorded fixtures name no real checkout, branch, account or home directory. Applied
// by `record.js` on every recording: a hand-scrub would be undone by the next one.
//
// Every structural property the tests turn on is preserved: which sessions share a checkout, which branches carry an
// issue number, which are worktrees rather than clones, which project directories differ from their slug only by
// case, and which sessions have no transcript. Only the names change. A synthetic path also cannot exist on the
// machine running the tests, which is what proves the readers use the ones they are handed.
const {
  HOME,
  PROBLEMS,
  REPO,
  SUBJECTS,
  UNIVERSAL,
  WORKTREES,
  assertNoAbsolutePaths,
  checkoutMap,
  gitReadsFor,
  identifyingReads,
  pick,
} = require('../../../../tools/fixture-scrub.js');

const slugOf = (p) => p.split('\\').join('/').replace(/[^A-Za-z0-9]/g, '-');

/**
 * A session title says outright what the work is, so a recording's titles are replaced wholesale. The two kinds stay
 * distinguishable — a manual title reads as one — because the precedence between them is what the tests turn on.
 */
function titlesFor(records, sessionId) {
  return records.map((record) =>
    record.type === 'custom-title'
      ? { type: 'custom-title', customTitle: `my ${pick(SUBJECTS, sessionId, 3)}`, sessionId }
      : {
          type: 'ai-title',
          aiTitle: `${pick(SUBJECTS, sessionId, 17)} ${pick(PROBLEMS, sessionId, 23)}`,
          sessionId,
        },
  );
}

const nameFor = (session, replacement) =>
  session.name === null || session.name === undefined
    ? session.name
    : `${replacement.branch.split('/').pop()}-${session.sessionId.slice(0, 2)}`;

function anonymiseAgents(sessions, map) {
  return sessions.map((session) => {
    const replacement = map.get(session.cwd);
    const anonymised = { ...session, cwd: replacement.cwd };

    if (session.name !== undefined) {
      anonymised.name = nameFor(session, replacement);
    }

    return anonymised;
  });
}

/**
 * `dir` keeps its relationship to the cwd's slug: where the real recording found a transcript in a directory whose
 * case differed, the synthetic one differs too, because that is the case-resolution rule's only witness.
 */
function anonymiseTranscripts(recorded, map) {
  const entries = recorded.entries.map((entry) => {
    const replacement = map.get(entry.cwd);
    const slug = slugOf(replacement.cwd);
    const wasCaseOnly = entry.dir !== null && entry.dir !== slugOf(entry.cwd);

    return {
      name: nameFor(entry, replacement),
      cwd: replacement.cwd,
      sessionId: entry.sessionId,
      dir: entry.dir === null ? null : wasCaseOnly ? slug.charAt(0).toUpperCase() + slug.slice(1) : slug,
      writtenAt: entry.writtenAt,
      titles: titlesFor(entry.titles, entry.sessionId),
      titleBytesFromEnd: entry.titleBytesFromEnd,
    };
  });

  const dirs = [...new Set(entries.filter((e) => e.dir !== null).map((e) => e.dir))].sort();

  return { home: HOME, projectDirs: dirs, entries };
}

/** The paths and names a recording carries that could identify real work. */
function identifying({ active, all, reads, transcripts }) {
  return [
    ...identifyingReads(reads),
    transcripts.home,
    ...[...active, ...all].flatMap((s) => [s.cwd, s.name]),
    ...transcripts.projectDirs,
    ...transcripts.entries.flatMap((e) => [
      e.cwd,
      e.name,
      e.dir,
      ...e.titles.map((t) => t.aiTitle ?? t.customTitle),
    ]),
  ].filter((value) => typeof value === 'string' && value.length > 3 && !UNIVERSAL.has(value));
}

/**
 * Fails the recording rather than writing a fixture that still names something real. The tests cannot catch this —
 * they only ever see anonymised output, so an anonymiser that stopped scrubbing would leave them green.
 */
function assertScrubbed(recording, written) {
  const json = JSON.stringify(written);
  const leaked = [...new Set(identifying(recording))].filter((value) => json.includes(value));

  if (leaked.length > 0) {
    throw new Error(`anonymise left ${leaked.length} identifying value(s) in the fixtures: ${leaked.slice(0, 5).join(', ')}`);
  }

  assertNoAbsolutePaths(json, [HOME, REPO, 'd:/work', 'c:/users/dev']);
}

/** Every fixture rewritten together, so the four stay consistent with one another. */
function anonymise({ active, all, reads, transcripts }) {
  const cwds = [...new Set([...active, ...all].map((s) => s.cwd))];
  const map = checkoutMap(cwds, reads);

  const written = {
    active: anonymiseAgents(active, map),
    all: anonymiseAgents(all, map),
    reads: gitReadsFor(map),
    transcripts: anonymiseTranscripts(transcripts, map),
  };

  assertScrubbed({ active, all, reads, transcripts }, written);

  return written;
}

module.exports = { HOME, REPO, WORKTREES, anonymise };
