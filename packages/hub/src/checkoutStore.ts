import { mkdirSync } from 'node:fs';
import { groundControlDirOf } from '@ground-control/core';
import { z } from 'zod';
import { read, writeIfChanged } from './fs.js';
import { checkoutsPathOf } from './paths.js';

/**
 * The directory the developer picked for each card, by card key. Written only by an explicit pick — never by the
 * loop and never from a match the board made itself, which is the whole reason this file exists rather than an
 * inference (`checkoutFor`). One record per machine, so a pick made on one board is the pick on every board.
 *
 * An entry outlives the card it was made for: a key nothing on the board matches costs one unused string, and a
 * prune keyed on today's cards would forget a pick while its issue was merely off the board for an afternoon.
 */
export type CheckoutMemory = Record<string, string>;

export interface CheckoutStore {
  read(): CheckoutMemory;
  /** Whether the file now holds this pick. A caller about to tell the developer it was stored has to know. */
  write(key: string, root: string): boolean;
}

const memory = z.record(z.string(), z.string());

export function makeCheckoutStore(home: string): CheckoutStore {
  const path = checkoutsPathOf(home);

  const load = (): CheckoutMemory => {
    const text = read(path);

    if (text === null) {
      return {};
    }

    // Hand-editable, as every other store here is: an unparsed read would throw on every render with no way back
    // but deleting the file. A root that no longer belongs to its card is dropped later, by `checkoutFor`.
    try {
      const parsed = memory.safeParse(JSON.parse(text));

      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  };

  return {
    read: load,

    write(key: string, root: string): boolean {
      try {
        mkdirSync(groundControlDirOf(home), { recursive: true });
        writeIfChanged(path, `${JSON.stringify({ ...load(), [key]: root }, null, 2)}\n`);

        return true;
      } catch {
        // A pick that could not be stored is one the developer makes again. Failing the render is worse.
        return false;
      }
    },
  };
}
