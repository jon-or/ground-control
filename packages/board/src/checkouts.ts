import { checkoutFor } from '@ground-control/core';
import type { CheckoutReaders, Lane, LanedCard } from '@ground-control/core';

/**
 * The same reads, answered once per pass. `checkoutFor` walks up from a root reading `.git`, `commondir` and
 * `config`, and cards sharing a clone would each walk it. Held no longer than the pass, so a directory deleted
 * between two snapshots is seen to have gone.
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
 * Which directory each card's work happens in, attached after the lanes are settled. It changes no lane: where a
 * card can be opened is not a claim about what stage it is at.
 */
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
