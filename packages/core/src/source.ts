import type { IssueCard } from './cards.js';
import type { ReadFailure } from './types.js';

/**
 * What one source read. The counts are what the board says about how much of the developer's work it is showing,
 * because an item that is missing has to be a number on screen rather than an absence (R1).
 */
export interface WorkItems {
  cards: IssueCard[];
  /** Who this was read for. The lane rules tell the developer's own pull request from a colleague's by it. */
  owners: string[];
  matched: number;
  totalAssigned: number;
  notOnProject: number;
  truncated: boolean;
  fetchedAt: string;
}

/**
 * One read. Every field is null for a source with nothing to say — one whose configuration was refused, which the
 * board already names. `items` null beside a failure is a source that failed and keeps whatever it last read (R24).
 *
 * `needs` is the identities the source could work out for itself but may not adopt: the hub has no screen, so it
 * detects and a client puts the question to the developer (R26, R28).
 */
export interface SourceReading {
  items: WorkItems | null;
  failure: ReadFailure | null;
  needs: { detected: string[] } | null;
}

/**
 * Where work items come from. Configured by id, so adding one is a registry entry and a configuration key: nothing
 * in the loop, the merge, or any client knows which source produced a card.
 */
export interface WorkSource {
  readonly id: string;
  readonly displayName: string;
  /** Takes this source's entry in a pushed configuration and holds it, or names why it will not read with it. */
  configure(raw: unknown): ReadFailure | null;
  read(): Promise<SourceReading>;
}
