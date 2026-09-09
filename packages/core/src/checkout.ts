import { dirKey } from './paths.js';
import { repositoryKey, repositoryOf } from './repository.js';
import type { BoardCard } from './board.js';
import type { ListDir, ReadText } from './machine.js';
import type { Session } from './types.js';

/**
 * When a session last showed itself, by whichever signal spoke most recently. Not liveness: it orders sessions
 * against each other and nothing else.
 */
function activeAt(session: Session): number {
  return Math.max(session.activity?.since ?? 0, session.transcriptWrittenAt ?? 0, session.startedAt);
}

/** Where a session's work sits: the checkout it runs in, or its own directory where it runs outside one. */
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

  // `lastSession` is carried only by a card with no live sessions, so it is the other case rather than a fallback.
  return order.length > 0 ? order.map(checkoutDir) : card.lastSession ? [card.lastSession.cwd] : [];
}

/**
 * Where a card's checkout came from. `session` is a directory an agent has actually run in; `remembered` is one the
 * developer picked for a card nothing has run on yet. There is no third: matching a repository is not matching a
 * checkout, because a worktree shares its remote configuration with its clone (`repository.ts`), so every worktree
 * of one repo answers to every card of that repo. That is weaker evidence than the branch name R37 already refuses.
 */
export type CheckoutSource = 'session' | 'remembered';

/** `root` rather than `cwd`, because this is what an `OpenRoute` is given and every route already calls it that. */
export interface CardCheckout {
  root: string;
  source: CheckoutSource;
  only: boolean;
}

/** What `checkoutFor` needs of the machine: whether a directory is still there, and what repository it belongs to. */
export interface CheckoutReaders {
  listDir: ListDir;
  readText: ReadText;
}

/**
 * Whether a directory is one this machine can still be pointed at. A deleted directory something still holds keeps
 * its name and refuses everything (`mechanics.md` M23), while `code <it>` opens a window on nothing — so a root is
 * offered only where it reads back. Not a repository check: ad-hoc work under no checkout is still somewhere to go.
 */
function reachable(root: string, readers: CheckoutReaders): boolean {
  return readers.listDir(root) !== null;
}

/**
 * The checkout a card's work happens in, or null where there is none to offer. A session's own directory first,
 * because an agent that has run there is the strongest evidence there is; then the one the developer picked.
 *
 * A remembered root is honoured only while it still belongs to the card's own repository: a worktree deleted and
 * replaced by another issue's is a directory the developer chose for work that is no longer there.
 */
export function checkoutFor(
  card: Pick<BoardCard, 'sessions' | 'lastSession' | 'issue'>,
  remembered: string | undefined,
  readers: CheckoutReaders,
): CardCheckout | null {
  // Every session's directory, not just the best-ranked one: a deleted worktree a process still holds goes on being
  // reported and goes on ranking first, and collapsing to it would hide a second agent's perfectly good checkout.
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
