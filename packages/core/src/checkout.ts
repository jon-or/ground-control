import { dirKey } from './paths.js';
import { repositoryKey, repositoryOf } from './repository.js';
import type { BoardCard } from './board.js';
import type { ListDir, ReadText } from './machine.js';
import type { Session } from './types.js';

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
 * A recorded session directory or a developer-selected folder. Matching remotes alone cannot identify a checkout
 * because worktrees share remote configuration (R37).
 */
export type CheckoutSource = 'session' | 'remembered';

/** Resolved checkout passed to an `OpenRoute`. */
export interface CardCheckout {
  root: string;
  source: CheckoutSource;
  only: boolean;
}

/** Filesystem readers for directory access and repository identity. */
export interface CheckoutReaders {
  listDir: ListDir;
  readText: ReadText;
}

/**
 * Require a readable directory: deleted worktrees can remain listed while a process holds them (mechanics M23).
 * Ad-hoc directories need no repository.
 */
function reachable(root: string, readers: CheckoutReaders): boolean {
  return readers.listDir(root) !== null;
}

/**
 * Prefer a readable session checkout, then a saved folder that still matches the issue repository. Return null
 * when neither qualifies.
 */
export function checkoutFor(
  card: Pick<BoardCard, 'sessions' | 'lastSession' | 'issue'>,
  remembered: string | undefined,
  readers: CheckoutReaders,
): CardCheckout | null {
  // Check all ranked directories so a deleted worktree does not hide another session checkout.
  const dirs = ranked(card).filter((dir) => reachable(dir, readers));
  const [root] = dirs;

  if (root !== undefined) {
    return { root, source: 'session', only: new Set(dirs.map(dirKey)).size < 2 };
  }

  if (remembered === undefined || !reachable(remembered, readers)) {
    return null;
  }

  const issue = card.issue;
  const wanted = issue === null ? null : repositoryKey(issue.url);

  return wanted !== null && repositoryOf(remembered, readers.readText) === wanted
    ? { root: remembered, source: 'remembered', only: true }
    : null;
}
