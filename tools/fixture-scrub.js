// Shared synthetic checkout names and path checks keep fixture anonymization consistent across packages.
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

/** Common branch names that do not identify a repository or user. */
const UNIVERSAL = new Set(['main', 'master', 'trunk', 'develop']);

const norm = (p) => p.split('\\').join('/');

/** Choose deterministically so repeated recordings produce stable diffs. */
function pick(list, seed, salt) {
  let hash = salt;

  for (const character of String(seed)) {
    hash = (hash * 31 + character.charCodeAt(0)) % 100_003;
  }

  return list[hash % list.length];
}

function branchFor(number) {
  const words = `${pick(SUBJECTS, number, 7)} ${pick(PROBLEMS, number, 13)}`;

  return `${number}-${words.replace(/[^a-z0-9]+/g, '-')}`;
}

/**
 * Map real checkouts to synthetic paths, branches, and worktree flags. Preserve issue-linked worktrees, named
 * worktrees, and clones; string .git reads identify worktree pointers.
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

    // A clone has a .git directory, so a text read returns null.
    reads[`${cwd}/.git`] = null;
    reads[`${cwd}/.git/HEAD`] = `ref: refs/heads/${branch}\n`;
  }

  return reads;
}

/** Collect checkout paths and branch names that anonymization must replace. */
function identifyingReads(reads) {
  const branches = Object.values(reads).flatMap((value) => {
    if (typeof value !== 'string') {
      return [];
    }

    return [/^gitdir:\s*(.+?)\s*$/m.exec(value)?.[1], /^ref: refs\/heads\/(.+)$/m.exec(value.trim())?.[1]];
  });

  return [...Object.keys(reads), ...branches].filter(
    (value) => typeof value === 'string' && value.length > 3 && !UNIVERSAL.has(value),
  );
}

/**
 * Reject absolute paths outside synthetic prefixes after normalizing escaped separators. Exclude letters
 * preceded by letters so file:// is not mistaken for a drive path.
 */
function assertNoAbsolutePaths(text, prefixes) {
  let rest = text.split('\\').join('/').replace(/\/+/g, '/').toLowerCase();

  for (const prefix of prefixes) {
    rest = rest.split(prefix.toLowerCase()).join('');
  }

  const stray = /(?<![a-z])[a-z]:\/|\/(users|home)\//.exec(rest);

  if (stray) {
    throw new Error(`anonymise left a real path: ${rest.slice(Math.max(0, stray.index - 30), stray.index + 70)}`);
  }
}

module.exports = {
  HOME,
  PROBLEMS,
  REPO,
  SUBJECTS,
  UNIVERSAL,
  WORKTREES,
  assertNoAbsolutePaths,
  branchFor,
  checkoutMap,
  gitReadsFor,
  identifyingReads,
  pick,
};
