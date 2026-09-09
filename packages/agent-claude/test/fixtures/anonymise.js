// Anonymize each recording automatically. Preserve shared checkouts, issue numbers, worktree/clone
// distinctions, slug casing, and missing transcripts. Synthetic paths must not exist on the test machine so
// tests exercise injected readers.
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

/** Replace title text while preserving manual and automatic title types for precedence tests. */
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

/** Preserve case differences between recorded directories and cwd slugs for case-resolution tests. */
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
 * Reject original identifiers before writing. Tests see only scrubbed output and cannot detect an unsanitized
 * recording.
 */
function assertScrubbed(recording, written) {
  const json = JSON.stringify(written);
  const leaked = [...new Set(identifying(recording))].filter((value) => json.includes(value));

  if (leaked.length > 0) {
    throw new Error(`anonymise left ${leaked.length} identifying value(s) in the fixtures: ${leaked.slice(0, 5).join(', ')}`);
  }

  assertNoAbsolutePaths(json, [HOME, REPO, 'd:/work', 'c:/users/dev']);
}

/** Rewrite related fixtures together to preserve consistency. */
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
