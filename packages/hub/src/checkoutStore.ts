import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import { read, writeIfChanged } from './fs.js';
import { checkoutsPathOf, worktreesPathOf } from './paths.js';

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

/** A directory per card key at `path`. The reader later rejects roots that no longer match their cards. */
function makeRootStore(stateDir: string, path: string): CheckoutStore {
  const load = (): CheckoutMemory => {
    const text = read(path);

    if (text === null) {
      return {};
    }

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
        mkdirSync(stateDir, { recursive: true });
        writeIfChanged(path, `${JSON.stringify({ ...load(), [key]: root }, null, 2)}\n`);

        return true;
      } catch {
        // Return failed writes without interrupting rendering.
        return false;
      }
    },
  };
}

export function makeCheckoutStore(stateDir: string): CheckoutStore {
  return makeRootStore(stateDir, checkoutsPathOf(stateDir));
}

/**
 * Persist the worktree each provisioning run reported, by card key (R46). The scan links a recorded root only
 * while git still registers it in a clone of the card's repository, so a stale entry is inert.
 */
export function makeWorktreeStore(stateDir: string): CheckoutStore {
  return makeRootStore(stateDir, worktreesPathOf(stateDir));
}
