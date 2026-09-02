// This repo is going public, so recorded fixtures name no real checkout, branch, account or home directory. Applied
// by `record.js` on every recording: a hand-scrub would be undone by the next one.
//
// Every structural property the tests turn on is preserved: which sessions share a checkout, which branches carry an
// issue number, which are worktrees rather than clones, which project directories differ from their slug only by
// case, and which sessions have no transcript. Only the names change. A synthetic path also cannot exist on the
// machine running the tests, which is what proves the readers use the ones they are handed.
const HOME = '/home/dev';
const REPO = 'd:/work/repo';
const WORKTREES = 'd:/work/repo.worktrees';

const SUBJECTS = [
  'booking export',
  'inbox badge',
  'payment retry',
  'listing sync',
  'guest portal',
  'tax rule',
  'quote email',
  'calendar feed',
  'review import',
  'refund ledger',
];

const PROBLEMS = [
  'drops rows past the first page',
  'counts archived records twice',
  'ignores the account time zone',
  'retries a settled charge',
  'rounds the wrong currency unit',
  'overwrites a manual edit',
  'skips the second occurrence',
  'reads across the tenant boundary',
];

const norm = (p) => p.split('\\').join('/');
const slugOf = (p) => norm(p).replace(/[^A-Za-z0-9]/g, '-');

/** Stable per number, so the same issue yields the same name on every recording and the diff stays readable. */
function pick(list, seed, salt) {
  let hash = salt;

  for (const character of String(seed)) {
    hash = (hash * 31 + character.charCodeAt(0)) % 100_003;
  }

  return list[hash % list.length];
}

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

function branchFor(number) {
  const words = `${pick(SUBJECTS, number, 7)} ${pick(PROBLEMS, number, 13)}`;

  return `${number}-${words.replace(/[^a-z0-9]+/g, '-')}`;
}

/**
 * One synthetic checkout per real one, keeping its shape: a per-issue worktree, a worktree on a named branch with no
 * issue number, or a plain clone. Returns `{ cwd, branch, worktree }`.
 */
function checkoutMap(cwds, reads) {
  const map = new Map();
  let clones = 0;
  let named = 0;

  for (const cwd of cwds) {
    const isWorktree = typeof reads[`${norm(cwd)}/.git`] === 'string';
    const number = /^(\d+)-/.exec(norm(cwd).split('/').pop() ?? '')?.[1];

    if (number) {
      const branch = branchFor(Number(number));
      const taken = [...map.values()].filter((v) => v.branch.startsWith(`${number}-`)).length;
      const unique = taken === 0 ? branch : `${branch}-${taken + 1}`;

      map.set(cwd, {
        cwd: isWorktree ? `${WORKTREES}/${unique}` : `d:/work/${unique}`,
        branch: unique,
        worktree: isWorktree,
      });
      continue;
    }

    if (isWorktree) {
      named++;
      const branch = `team/worker-${named}`;
      map.set(cwd, { cwd: `c:/users/dev/.tools/worktrees/worker-${named}`, branch, worktree: true });
      continue;
    }

    clones++;
    map.set(cwd, { cwd: clones === 1 ? REPO : `d:/work/clone-${clones}`, branch: 'main', worktree: false });
  }

  return map;
}

/** Rebuilds `.git` and `HEAD` for the synthetic checkouts, keeping the file-vs-directory distinction. */
function gitReadsFor(map) {
  const reads = {};

  for (const { cwd, branch, worktree } of map.values()) {
    if (worktree) {
      const leaf = branch.split('/').pop();
      reads[`${cwd}/.git`] = `gitdir: ${REPO.replace('d:', 'D:')}/.git/worktrees/${leaf}\n`;
      reads[`${REPO.replace('d:', 'D:')}/.git/worktrees/${leaf}/HEAD`] = `ref: refs/heads/${branch}\n`;
      continue;
    }

    // A plain clone's `.git` is a directory, so reading it as text fails — that null is how the two are told apart.
    reads[`${cwd}/.git`] = null;
    reads[`${cwd}/.git/HEAD`] = `ref: refs/heads/${branch}\n`;
  }

  return reads;
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

/** Branch names every repository has. They name nobody, and a synthetic clone legitimately reuses one. */
const UNIVERSAL = new Set(['main', 'master', 'trunk', 'develop']);

/** The paths and names a recording carries that could identify real work. */
function identifying({ active, all, reads, transcripts }) {
  const branches = Object.values(reads).flatMap((value) => {
    if (typeof value !== 'string') {
      return [];
    }

    return [/^gitdir:\s*(.+?)\s*$/m.exec(value)?.[1], /^ref: refs\/heads\/(.+)$/m.exec(value.trim())?.[1]];
  });

  return [
    transcripts.home,
    ...[...active, ...all].flatMap((s) => [s.cwd, s.name]),
    ...transcripts.projectDirs,
    ...transcripts.entries.flatMap((e) => [
      e.cwd,
      e.name,
      e.dir,
      ...e.titles.map((t) => t.aiTitle ?? t.customTitle),
    ]),
    ...Object.keys(reads),
    ...branches,
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
