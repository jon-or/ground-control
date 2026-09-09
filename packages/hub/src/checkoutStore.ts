import { mkdirSync } from 'node:fs';
import { groundControlDirOf } from '@ground-control/core';
import { z } from 'zod';
import { read, writeIfChanged } from './fs.js';
import { checkoutsPathOf } from './paths.js';

/**
 * Persist explicit checkout picks by card key, shared across clients. Retain entries when cards temporarily
 * leave the board. Session-derived checkout selection remains separate from this store.
 */
export type CheckoutMemory = Record<string, string>;

export interface CheckoutStore {
  read(): CheckoutMemory;
  /** Return whether the checkout selection was stored. */
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

    // Ignore invalid stored values. checkoutFor later rejects roots that no longer match their cards.
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
        // Return failed writes without interrupting rendering.
        return false;
      }
    },
  };
}
