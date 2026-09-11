import { dirKey } from './paths.js';
import { repositoryKey, repositoryOf } from './repository.js';
import type { BoardCard } from './board.js';
import type { CheckoutReaders } from './machine.js';
import type { Session } from './types.js';
import type { CardWorktree } from './worktrees.js';

/** Latest activity timestamp for ordering sessions, not evidence of liveness. */
function activeAt(session: Session): number {
  return Math.max(session.activity?.since ?? 0, session.transcriptWrittenAt ?? 0, session.startedAt);
}

/** Session checkout, or working directory outside a checkout. */
function checkoutDir(session: Session): string {
  return session.checkoutRoot ?? session.cwd;
}

/**
 * Rank recorded session checkouts by recent activity, then stable agent/session ID ties. Do not derive paths
 * from branch names. Distinct checkouts require the caller to identify its selection; multiple sessions in one
 * checkout do not.
 */
function ranked(card: Pick<BoardCard, 'sessions' | 'lastSession'>): string[] {
  const order = [...card.sessions].sort(
    (a, b) => activeAt(b) - activeAt(a) || a.agent.localeCompare(b.agent) || a.sessionId.localeCompare(b.sessionId),
  );

  // `lastSession` applies only when there are no live sessions.
  return order.length > 0 ? order.map(checkoutDir) : card.lastSession ? [card.lastSession.cwd] : [];
}

/**
 * A recorded session directory, a developer-selected folder, or the worktree for the card's issue. Matching
 * remotes alone cannot identify a checkout because worktrees share remote configuration (R37).
 */
export type CheckoutSource = 'session' | 'remembered' | 'worktree';

/** Resolved checkout passed to an `OpenRoute`. */
export interface CardCheckout {
  root: string;
  source: CheckoutSource;
  only: boolean;
}

/**
 * Require a readable directory: deleted worktrees can remain listed while a process holds them (mechanics M23).
 * Ad-hoc directories need no repository.
 */
function reachable(root: string, readers: CheckoutReaders): boolean {
  return readers.listDir(root) !== null;
}

/**
 * Prefer a readable session checkout, then a saved folder that still matches the issue repository, then the
 * issue's worktree. An explicit pick outranks a discovered worktree (R41). Null when none qualifies.
 */
export function checkoutFor(
  card: Pick<BoardCard, 'sessions' | 'lastSession' | 'issue'>,
  remembered: string | undefined,
  readers: CheckoutReaders,
  worktree: CardWorktree | null = null,
): CardCheckout | null {
  // Check all ranked directories so a deleted worktree does not hide another session checkout.
  const dirs = ranked(card).filter((dir) => reachable(dir, readers));
  const [root] = dirs;

  // A worktree the card did not select still qualifies, so a caller must say which directory it used. The one
  // passed in is the first of its issue's, so a second worktree counts even when the chosen directory is this one.
  const alone = (chosen: string): boolean => worktree === null || (worktree.only && dirKey(worktree.root) === dirKey(chosen));

  if (root !== undefined) {
    return { root, source: 'session', only: new Set(dirs.map(dirKey)).size < 2 && alone(root) };
  }

  const issue = card.issue;
  const wanted = issue === null ? null : repositoryKey(issue.url);

  if (remembered !== undefined && reachable(remembered, readers) && wanted !== null && repositoryOf(remembered, readers.readText) === wanted) {
    return { root: remembered, source: 'remembered', only: alone(remembered) };
  }

  return worktree === null ? null : { root: worktree.root, source: 'worktree', only: worktree.only };
}
