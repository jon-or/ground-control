import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writeAtomic } from './fs.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const timestamps = z.array(z.number().finite().nonnegative());

/** Reserve automatic attempts before source reads. Corrupt or unwritable usage fails closed. */
export class TriageUsage {
  readonly #directory: string;
  readonly #path: string;

  constructor(stateDir: string) {
    this.#directory = stateDir;
    this.#path = join(this.#directory, 'triage-usage.json');
  }

  read(now: number): number[] | null {
    try {
      const stored = timestamps.parse(JSON.parse(readFileSync(this.#path, 'utf8')));
      // Future timestamps remain charged after a clock rollback.
      return stored.filter((at) => at > now - DAY_MS);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
    }
  }

  reserve(now: number, limit: number): 'reserved' | 'exhausted' | 'unavailable' {
    const held = this.read(now);
    if (held === null) return 'unavailable';
    if (held.length >= limit) return 'exhausted';
    try {
      mkdirSync(this.#directory, { recursive: true });
      writeAtomic(this.#path, `${JSON.stringify([...held, now])}\n`);
      return 'reserved';
    } catch {
      return 'unavailable';
    }
  }
}
