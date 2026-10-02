import { readFile } from 'node:fs/promises';
import { join } from '@ground-control/core';
import type { Logger } from '@ground-control/core';
import { z } from 'zod';

/** How often the hub reads the analyzer's summary, whether or not debriefs are enabled (R52). */
export const FRICTION_SUMMARY_MS = 60 * 1000;

/** The analyzer's count of the fixes its report holds; a contract with that tool. */
export const frictionSummary = z.object({ v: z.literal(1), generatedAt: z.string().datetime({ offset: true }), toReview: z.number().int().nonnegative() }).passthrough();

/** The summary the analyzer writes beside its report, under the debrief directory. */
export function frictionSummaryPath(dir: string): string {
  return join(join(dir, 'fixes'), 'summary.json');
}

/** The analyzer's review report, the only file a friction-report request reads. */
export function frictionReportPath(dir: string): string {
  return join(dir, 'report.md');
}

export interface FrictionFixesDeps {
  log: Logger;
  /** Rejects with `ENOENT` for a missing file. */
  readFile(path: string): Promise<string>;
}

export const realFrictionRead = (path: string): Promise<string> => readFile(path, 'utf8');

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' || (error as NodeJS.ErrnoException | null)?.code === 'ENOTDIR';
}

/**
 * The friction fixes awaiting review (R52). A missing, unreadable, or invalid summary counts as none; an unreadable or
 * invalid one is logged once until the reading changes.
 */
export class FrictionFixes {
  readonly #deps: FrictionFixesDeps;
  #count = 0;
  #said: string | null = null;
  /** Bumped by every read, so an older read finishing late cannot replace a newer one. */
  #reads = 0;

  constructor(deps: FrictionFixesDeps) {
    this.#deps = deps;
  }

  count(): number {
    return this.#count;
  }

  /** Read the summary under `dir`; true when the count changed. */
  async read(dir: string): Promise<boolean> {
    const read = ++this.#reads;
    const path = frictionSummaryPath(dir);
    const count = await this.#readCount(path);

    if (read !== this.#reads || count === this.#count) {
      return false;
    }

    this.#count = count;

    return true;
  }

  async #readCount(path: string): Promise<number> {
    let text: string;

    try {
      text = await this.#deps.readFile(path);
    } catch (error) {
      if (missing(error)) {
        this.#said = null;

        return 0;
      }

      this.#say(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);

      return 0;
    }

    let parsed: z.SafeParseReturnType<unknown, z.infer<typeof frictionSummary>>;

    try {
      parsed = frictionSummary.safeParse(JSON.parse(text));
    } catch {
      this.#say(`${path} is not JSON, so no friction fixes are shown.`);

      return 0;
    }

    if (!parsed.success) {
      const issue = parsed.error.issues[0];

      this.#say(`${path} is not a version 1 summary (${issue?.path.join('.') || 'value'}: ${issue?.message ?? 'invalid'}), so no friction fixes are shown.`);

      return 0;
    }

    this.#said = null;

    return parsed.data.toReview;
  }

  #say(message: string): void {
    if (message === this.#said) return;
    this.#said = message;
    this.#deps.log.warn(message, 'debrief');
  }
}
