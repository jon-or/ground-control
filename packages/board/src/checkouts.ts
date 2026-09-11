import { checkoutFor, worktreeFor, worktreeIndex } from '@ground-control/core';
import type { CheckoutReaders, Lane, LanedCard } from '@ground-control/core';

/**
 * Cache filesystem reads within a snapshot so cards sharing a clone reuse them. Discard between snapshots to
 * detect deleted directories.
 */
function onceEach(readers: CheckoutReaders): CheckoutReaders {
  const dirs = new Map<string, string[] | null>();
  const texts = new Map<string, string | null>();

  return {
    listDir: (path) => {
      if (!dirs.has(path)) {
        dirs.set(path, readers.listDir(path));
      }

      return dirs.get(path)!;
    },
    readText: (path) => {
      if (!texts.has(path)) {
        texts.set(path, readers.readText(path));
      }

      return texts.get(path)!;
    },
  };
}

/**
 * Clones to scan for worktrees, the pattern that reads an issue number from a branch or directory name, and the
 * worktree recorded for each card by its provisioning run (R46).
 */
export interface WorktreeScan {
  roots: readonly string[];
  pattern: RegExp | null;
  recorded: Readonly<Record<string, string>>;
}

/** Attach checkout and worktree information after lane assignment without changing lanes. */
export function withCheckouts(
  lanes: readonly Lane[],
  remembered: Readonly<Record<string, string>>,
  readers: CheckoutReaders,
  scan: WorktreeScan,
): Lane[] {
  const once = onceEach(readers);
  const worktrees = worktreeIndex(scan.roots, once, scan.pattern);

  return lanes.map((lane) => ({
    ...lane,
    cards: lane.cards.map((card): LanedCard => {
      const worktree = worktreeFor(card, worktrees, scan.recorded[card.key]);
      const checkout = checkoutFor(card, remembered[card.key], once, worktree);

      return {
        ...card,
        ...(checkout === null ? {} : { checkout }),
        ...(worktree === null ? {} : { worktree }),
      };
    }),
  }));
}
