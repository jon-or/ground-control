import { checkoutFor } from '@ground-control/core';
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

/** Attach checkout information after lane assignment without changing lanes. */
export function withCheckouts(
  lanes: readonly Lane[],
  remembered: Readonly<Record<string, string>>,
  readers: CheckoutReaders,
): Lane[] {
  const once = onceEach(readers);

  return lanes.map((lane) => ({
    ...lane,
    cards: lane.cards.map((card): LanedCard => {
      const checkout = checkoutFor(card, remembered[card.key], once);

      return checkout === null ? card : { ...card, checkout };
    }),
  }));
}
