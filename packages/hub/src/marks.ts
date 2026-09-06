import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import { groundControlDirOf } from '@ground-control/core';
import { read, writeIfChanged } from './fs.js';
import { marksPathOf } from './paths.js';

const marks = z.object({
  /** When the activity signal was last actually installed, or absent where it is not installed. */
  installedAt: z.number().nullable().default(null),
  /** The install each client has already been told about, so a second board still sees the notice once (R25). */
  announcedAt: z.record(z.string(), z.number()).default({}),
  /** Whether this machine has been told that reading cards spends usage and sends text to an API (R38). */
  triageToldAt: z.number().nullable().default(null),
  /** Whether this machine has been told that the board has started work on the developer's own code (R39). */
  actionsToldAt: z.number().nullable().default(null),
});

export type Marks = z.infer<typeof marks>;

const EMPTY: Marks = { installedAt: null, announcedAt: {}, triageToldAt: null, actionsToldAt: null };

/**
 * What the hub has already done and already said. Machine-wide for the install, per client for the announcement:
 * installing is one act, but a developer opening a second board has not read the first board's notice.
 */
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
        // A mark that could not be stored costs one repeated notice, not a render.
      }
    },
  };
}

/**
 * The install stamp after a run. Only a run that actually added entries starts the clock: stamping one that added
 * nothing would have the board claim every session listed before this moment cannot report, of sessions that report
 * on their next event. A removal clears it, so putting the hooks back says so again.
 */
export function afterInstall(held: Marks, wanted: 'install' | 'remove', added: number, now: number): Marks {
  // The triage notice is not the install's to clear: putting the hooks back is not a second time to be told what
  // reading a card costs.
  if (wanted === 'remove') {
    return { ...held, installedAt: null, announcedAt: {} };
  }

  if (held.installedAt !== null || added === 0) {
    return held;
  }

  return { ...held, installedAt: now };
}

/** Whether this client has yet to be told about the install the marks record, and the marks after telling it. */
export function announce(held: Marks, client: string): { say: boolean; next: Marks } {
  if (held.installedAt === null || held.announcedAt[client] === held.installedAt) {
    return { say: false, next: held };
  }

  return { say: true, next: { ...held, announcedAt: { ...held.announcedAt, [client]: held.installedAt } } };
}
