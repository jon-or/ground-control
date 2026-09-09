import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import { groundControlDirOf } from '@ground-control/core';
import { read, writeIfChanged } from './fs.js';
import { marksPathOf } from './paths.js';

const marks = z.object({
  /** Last installation timestamp, or null when uninstalled. */
  installedAt: z.number().nullable().default(null),
  /** Last installation announced to each client (R25). */
  announcedAt: z.record(z.string(), z.number()).default({}),
  /** Whether triage usage and API disclosure was shown (R38). */
  triageToldAt: z.number().nullable().default(null),
  /** Whether the first automatic action notice was shown (R39). */
  actionsToldAt: z.number().nullable().default(null),
});

export type Marks = z.infer<typeof marks>;

const EMPTY: Marks = { installedAt: null, announcedAt: {}, triageToldAt: null, actionsToldAt: null };

/** Persist installation state per machine and announcement state per client. */
export interface MarkStore {
  read(): Marks;
  write(next: Marks): void;
}

export function makeMarkStore(home: string): MarkStore {
  const path = marksPathOf(home);

  return {
    read(): Marks {
      const text = read(path);

      if (text === null) {
        return { ...EMPTY, announcedAt: {} };
      }

      try {
        const parsed = marks.safeParse(JSON.parse(text));

        return parsed.success ? parsed.data : { ...EMPTY, announcedAt: {} };
      } catch {
        return { ...EMPTY, announcedAt: {} };
      }
    },

    write(next: Marks): void {
      try {
        mkdirSync(groundControlDirOf(home), { recursive: true });
        writeIfChanged(path, `${JSON.stringify(next, null, 2)}\n`);
      } catch {
        // A failed write may repeat a notice without failing rendering.
      }
    },
  };
}

/** Update the timestamp only when entries were added, so reporting sessions are not counted as pre-install. Clear it on removal. */
export function afterInstall(held: Marks, wanted: 'install' | 'remove', added: number, now: number): Marks {
  // Preserve the triage disclosure when reinstalling activity hooks.
  if (wanted === 'remove') {
    return { ...held, installedAt: null, announcedAt: {} };
  }

  if (held.installedAt !== null || added === 0) {
    return held;
  }

  return { ...held, installedAt: now };
}

/** Check whether this client needs the install notice and record its acknowledgment. */
export function announce(held: Marks, client: string): { say: boolean; next: Marks } {
  if (held.installedAt === null || held.announcedAt[client] === held.installedAt) {
    return { say: false, next: held };
  }

  return { say: true, next: { ...held, announcedAt: { ...held.announcedAt, [client]: held.installedAt } } };
}
