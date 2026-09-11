import { describe, expect, it } from 'vitest';
import type { IssueCard } from '../src/cards.js';
import type { CheckoutReaders } from '../src/machine.js';
import { clonesOf, worktreeFor, worktreeIndex, worktreesOf } from '../src/worktrees.js';

const PATTERN = /^(\d+)-/;

const CLONE = 'd:/work/repo';
const GIT = 'd:/work/repo/.git';

/** A clone whose registrations and worktree directories are declared per test. */
interface Disk {
  /** Registration name to the files git writes under `.git/worktrees/<name>`. */
  registered?: Record<string, { gitdir?: string; head?: string }>;
  /** Directories that read back. Registered worktrees whose directory is absent here are gone from disk. */
  present?: string[];
  /** Origin URL in the clone's config, or none for a clone with no remote. */
  origin?: string | null;
}

function readers(disk: Disk): CheckoutReaders {
  const registered = disk.registered ?? {};
  const present = new Set([CLONE, ...(disk.present ?? [])]);
  const origin = disk.origin === undefined ? 'https://github.com/org/repo.git' : disk.origin;

  return {
    listDir: (path) => {
      if (path === `${GIT}/worktrees`) return Object.keys(registered);

      return present.has(path) ? [] : null;
    },
    readText: (path) => {
      // The clone's own HEAD is what identifies it as a checkout rather than an ordinary directory.
      if (path === `${GIT}/HEAD`) return 'ref: refs/heads/master\n';
      if (path === `${GIT}/config`) return origin === null ? '[core]\n' : `[remote "origin"]\n\turl = ${origin}\n`;

      const entry = /^d:\/work\/repo\/\.git\/worktrees\/([^/]+)\/(gitdir|HEAD)$/.exec(path);

      if (entry) {
        const file = registered[entry[1]!];

        return (entry[2] === 'gitdir' ? file?.gitdir : file?.head) ?? null;
      }

      return null;
    },
  };
}

/** A worktree as git registers it: a pointer to its own `.git` file, and a HEAD naming its branch. */
function worktree(root: string, branch: string | null): { gitdir: string; head: string } {
  return { gitdir: `${root}/.git\n`, head: branch === null ? 'd6f8a1c0e2b4\n' : `ref: refs/heads/${branch}\n` };
}

function index(disk: Disk, pattern: RegExp | null = PATTERN) {
  return worktreeIndex([CLONE], readers(disk), pattern);
}

/** The index is keyed by repository and issue, so read it back the way a card does. */
function card(issueNumber: number | null, url = 'https://github.com/org/repo/issues/1'): { issue: IssueCard | null; issueNumber: number | null } {
  return {
    issueNumber,
    issue: {
      number: issueNumber ?? 0,
      title: 'an issue',
      type: null,
      typeColor: null,
      url,
      status: null,
      statusColor: null,
      statusChangedAt: null,
      assignees: [],
      avatar: null,
      pullRequest: null,
      updatedAt: '2026-09-10T00:00:00Z',
    },
  };
}

describe('finding the worktree that belongs to a card', () => {
  it('links a worktree by its branch name', () => {
    const found = worktreeFor(card(18941), index({
      registered: { 'inbox-badge': worktree('d:/work/wt/inbox-badge', '18941-inbox-badge') },
      present: ['d:/work/wt/inbox-badge'],
    }));

    expect(found).toEqual({ root: 'd:/work/wt/inbox-badge', branch: '18941-inbox-badge', only: true });
  });

  it('links by directory name where HEAD is detached and names no branch', () => {
    const found = worktreeFor(card(18941), index({
      registered: { detached: worktree('d:/work/wt/18941-inbox-badge', null) },
      present: ['d:/work/wt/18941-inbox-badge'],
    }));

    expect(found).toEqual({ root: 'd:/work/wt/18941-inbox-badge', branch: null, only: true });
  });

  it('prefers the branch over the directory when the two name different issues', () => {
    const found = worktreeFor(card(18941), index({
      registered: { mixed: worktree('d:/work/wt/18953-lane-divider', '18941-inbox-badge') },
      present: ['d:/work/wt/18953-lane-divider'],
    }));

    expect(found?.root).toBe('d:/work/wt/18953-lane-divider');
    expect(worktreeFor(card(18953), index({
      registered: { mixed: worktree('d:/work/wt/18953-lane-divider', '18941-inbox-badge') },
      present: ['d:/work/wt/18953-lane-divider'],
    }))).toBeNull();
  });

  it('skips a worktree deleted while still registered', () => {
    const found = worktreeFor(card(18941), index({
      registered: { gone: worktree('d:/work/wt/18941-inbox-badge', '18941-inbox-badge') },
      present: [],
    }));

    expect(found).toBeNull();
  });

  it('follows a pointer git wrote relative to the registration', () => {
    const found = worktreeFor(card(18941), index({
      registered: { relative: { gitdir: '../../../../wt/18941-inbox-badge/.git\n', head: 'ref: refs/heads/18941-inbox-badge\n' } },
      present: ['d:/work/wt/18941-inbox-badge'],
    }));

    expect(found?.root).toBe('d:/work/wt/18941-inbox-badge');
  });

  it('links by directory name where the registration has no readable HEAD', () => {
    const found = worktreeFor(card(18941), index({
      registered: { headless: { gitdir: 'd:/work/wt/18941-inbox-badge/.git\n' } },
      present: ['d:/work/wt/18941-inbox-badge'],
    }));

    expect(found).toEqual({ root: 'd:/work/wt/18941-inbox-badge', branch: null, only: true });
  });

  it('reports nothing from a root that is not inside a checkout at all', () => {
    expect(worktreeIndex(['d:/scratch'], readers({}), PATTERN).byRoot.size).toBe(0);
  });

  it('skips a registration whose pointer does not name a .git file', () => {
    const found = worktreeFor(card(18941), index({
      registered: { broken: { gitdir: 'd:/work/wt/18941-inbox-badge\n', head: 'ref: refs/heads/18941-inbox-badge\n' } },
      present: ['d:/work/wt/18941-inbox-badge'],
    }));

    expect(found).toBeNull();
  });

  it('reports every worktree of one issue as not the only one', () => {
    const found = index({
      registered: {
        second: worktree('d:/work/wt/b-18941-retry', '18941-retry'),
        first: worktree('d:/work/wt/a-18941-inbox-badge', '18941-inbox-badge'),
      },
      present: ['d:/work/wt/b-18941-retry', 'd:/work/wt/a-18941-inbox-badge'],
    });

    // Sorted by path so the same worktree is offered on every refresh.
    expect(worktreeFor(card(18941), found)).toEqual({ root: 'd:/work/wt/a-18941-inbox-badge', branch: '18941-inbox-badge', only: false });
  });

  it('does not match a card of another repository with the same issue number', () => {
    const found = index({
      registered: { badge: worktree('d:/work/wt/18941-inbox-badge', '18941-inbox-badge') },
      present: ['d:/work/wt/18941-inbox-badge'],
    });

    expect(worktreeFor(card(18941, 'https://github.com/org/other/issues/18941'), found)).toBeNull();
  });

  it('reports nothing from a clone with no origin, which cannot be matched to an issue', () => {
    const found = index({
      registered: { badge: worktree('d:/work/wt/18941-inbox-badge', '18941-inbox-badge') },
      present: ['d:/work/wt/18941-inbox-badge'],
      origin: null,
    });

    expect(found.byRoot.size).toBe(0);
  });

  it('reports nothing when the issue pattern is unusable', () => {
    const found = index({
      registered: { badge: worktree('d:/work/wt/18941-inbox-badge', '18941-inbox-badge') },
      present: ['d:/work/wt/18941-inbox-badge'],
    }, null);

    expect(found.byIssue.size).toBe(0);
    // A recorded link needs no pattern, so the directories are still indexed.
    expect([...found.byRoot.keys()]).toEqual(['d:/work/repo', 'd:/work/wt/18941-inbox-badge']);
  });

  it('reports nothing for a branch the pattern does not match', () => {
    const found = index({
      registered: { spike: worktree('d:/work/wt/spike', 'spike-no-issue') },
      present: ['d:/work/wt/spike'],
    });

    expect(found.byIssue.size).toBe(0);
  });

  it('reports the clone a directory belongs to, with the working tree a new worktree hangs from', () => {
    expect(clonesOf([CLONE], readers({}))).toEqual([{ root: CLONE, commonDir: GIT, repository: 'github.com/org/repo' }]);
  });

  // A session in a linked worktree is the usual way the hub learns of a clone at all.
  it('reports the clone and its working tree from a directory inside one of its worktrees', () => {
    const disk = readers({ registered: { badge: worktree('d:/work/wt/18941-inbox-badge', '18941-inbox-badge') }, present: ['d:/work/wt/18941-inbox-badge'] });
    const linked: CheckoutReaders = {
      listDir: disk.listDir,
      readText: (path) => {
        if (path === 'd:/work/wt/18941-inbox-badge/.git') return 'gitdir: d:/work/repo/.git/worktrees/badge\n';
        if (path === `${GIT}/worktrees/badge/commondir`) return '../..\n';

        return disk.readText(path);
      },
    };

    expect(clonesOf(['d:/work/wt/18941-inbox-badge/src'], linked)).toEqual([{ root: CLONE, commonDir: GIT, repository: 'github.com/org/repo' }]);
  });

  it('names the working tree it was reached from where the git directory stands apart from it', () => {
    const disk = readers({});
    const apart: CheckoutReaders = {
      listDir: (path) => (path === 'd:/work/tree' ? [] : disk.listDir(path)),
      readText: (path) => (path === 'd:/work/tree/.git' ? `gitdir: ${GIT}\n` : disk.readText(path)),
    };

    expect(clonesOf(['d:/work/tree'], apart)).toEqual([{ root: 'd:/work/tree', commonDir: GIT, repository: 'github.com/org/repo' }]);
  });

  // Session roots come before window roots, so the linked worktree usually arrives first; only the main tree
  // says where `{repo}` is when the git directory stands apart.
  it('names the working tree whichever order the tree and its linked worktree arrive in', () => {
    const APART = 'd:/gits/repo.git';
    const disk = readers({ registered: { badge: worktree('d:/work/wt/18941-inbox-badge', '18941-inbox-badge') }, present: ['d:/work/wt/18941-inbox-badge', 'd:/work/tree'] });
    // The fixture keeps its files under the clone's `.git`; read them as if they stood at `APART`.
    const at = (path: string) => path.replace(APART, GIT);
    const apart: CheckoutReaders = {
      listDir: (path) => disk.listDir(at(path)),
      readText: (path) => {
        if (path === 'd:/work/tree/.git') return `gitdir: ${APART}\n`;
        if (path === 'd:/work/wt/18941-inbox-badge/.git') return `gitdir: ${APART}/worktrees/badge\n`;
        if (path === `${APART}/worktrees/badge/commondir`) return '../..\n';

        return disk.readText(at(path));
      },
    };
    const expected = [{ root: 'd:/work/tree', commonDir: APART, repository: 'github.com/org/repo' }];

    expect(clonesOf(['d:/work/wt/18941-inbox-badge', 'd:/work/tree'], apart)).toEqual(expected);
    expect(clonesOf(['d:/work/tree', 'd:/work/wt/18941-inbox-badge'], apart)).toEqual(expected);
  });

  it('scans a clone once when several of its own directories are supplied as roots', () => {
    const disk = readers({
      registered: { badge: worktree('d:/work/wt/18941-inbox-badge', '18941-inbox-badge') },
      present: ['d:/work/wt/18941-inbox-badge'],
    });
    let listed = 0;
    const counting: CheckoutReaders = {
      listDir: (path) => {
        if (path === `${GIT}/worktrees`) listed += 1;

        return disk.listDir(path);
      },
      readText: disk.readText,
    };

    worktreeIndex([CLONE, `${CLONE}/packages/core`], counting, PATTERN);

    expect(listed).toBe(1);
  });

  // A developer who switches branches in one clone has no linked worktree: the clone itself is where the work is.
  it('links the clone’s own working tree when its branch names the issue', () => {
    const disk = readers({});
    const onBranch: CheckoutReaders = {
      listDir: disk.listDir,
      readText: (path) => (path === `${GIT}/HEAD` ? 'ref: refs/heads/18941-inbox-badge\n' : disk.readText(path)),
    };

    expect(worktreeFor(card(18941), worktreeIndex([CLONE], onBranch, PATTERN))).toEqual({ root: CLONE, branch: '18941-inbox-badge', only: true });
  });

  it('lists the main working tree first and every registered worktree after it', () => {
    const clone = { root: CLONE, commonDir: GIT, repository: 'github.com/org/repo' };
    const disk = readers({ registered: { badge: worktree('d:/work/wt/18941-inbox-badge', '18941-inbox-badge') }, present: ['d:/work/wt/18941-inbox-badge'] });

    expect(worktreesOf(clone, disk)).toEqual([
      { root: CLONE, branch: 'master', repository: 'github.com/org/repo' },
      { root: 'd:/work/wt/18941-inbox-badge', branch: '18941-inbox-badge', repository: 'github.com/org/repo' },
    ]);
  });

  it('lists no main working tree for a clone that has none', () => {
    const clone = { root: null, commonDir: GIT, repository: 'github.com/org/repo' };

    expect(worktreesOf(clone, readers({}))).toEqual([]);
  });

  // A provisioning run may name the branch however the developer's prompt likes; the record is what links it (R46).
  describe('with a recorded worktree', () => {
    const FREE = 'd:/work/wt/refund-window';
    const disk = (extra: Record<string, { gitdir: string; head: string }> = {}) => index({
      registered: { free: worktree(FREE, 'refund-window'), ...extra },
      present: [FREE, ...Object.values(extra).map((entry) => entry.gitdir.replace(/\/\.git\n$/, ''))],
    });

    it('links the recorded worktree even though its name says nothing about the issue', () => {
      expect(worktreeFor(card(19002), disk(), FREE)).toEqual({ root: FREE, branch: 'refund-window', only: true });
    });

    it('links the record however the path is spelt', () => {
      expect(worktreeFor(card(19002), disk(), 'D:\\work\\wt\\Refund-Window\\')?.root).toBe(FREE);
    });

    it('ignores a record naming a directory git no longer registers', () => {
      expect(worktreeFor(card(19002), disk(), 'd:/work/wt/gone')).toBeNull();
    });

    it('ignores a record naming a working tree of another repository', () => {
      expect(worktreeFor(card(19002, 'https://github.com/org/other/issues/19002'), disk(), FREE)).toBeNull();
    });

    it('prefers the record to a worktree named after the issue, and says the card has both', () => {
      const found = disk({ named: worktree('d:/work/wt/19002-refund', '19002-refund') });

      expect(worktreeFor(card(19002), found, FREE)).toEqual({ root: FREE, branch: 'refund-window', only: false });
      expect(worktreeFor(card(19002), found)).toEqual({ root: 'd:/work/wt/19002-refund', branch: '19002-refund', only: true });
    });

    it('counts the record once when it is the worktree named after the issue', () => {
      const named = 'd:/work/wt/19002-refund';
      const found = disk({ named: worktree(named, '19002-refund') });

      expect(worktreeFor(card(19002), found, named)).toEqual({ root: named, branch: '19002-refund', only: true });
    });
  });
});
