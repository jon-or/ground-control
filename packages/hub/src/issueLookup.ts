import { knownIssueHolds, knownIssueKey, pruneKnownIssues, sameKnownCard, withKnownIssue } from '@ground-control/board';
import { repositoryKey } from '@ground-control/core';
import type { IssueCard, Logger, Session, WorkSource } from '@ground-control/core';
import type { IssueStore } from './issueStore.js';

export interface IssueLookupDeps {
  store: IssueStore;
  /** The configured sources, asked in order. Only one that implements `readCard` can answer at all. */
  sources(): readonly WorkSource[];
  log: Logger;
  now(): number;
  /** A reading landed, so whatever is on screen is now a card short of the truth. */
  changed(): void;
}

/** How many issues the board reads at once. A stale board is a handful of these, and not one of them is urgent. */
const CONCURRENCY = 3;

/** How long a key whose read failed is left alone. The session poll comes round twice a minute; an outage does not lift that fast. */
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;

/** A session's issue, as this store keys it. Null where the session's checkout names no repository to key it under. */
function keyOf(session: Session): string | null {
  return session.repository !== null && session.issueNumber !== null
    ? knownIssueKey(session.repository, session.issueNumber)
    : null;
}

/**
 * The titles for issues a session names but the developer is not assigned — an issue they finished and handed on,
 * with the session still open on it. Reads the store first and the source only for what is not in it, which makes
 * the ordinary case free: the board saw the issue while it was assigned and wrote it down then.
 */
export class IssueLookup {
  readonly #deps: IssueLookupDeps;
  readonly #inFlight = new Set<string>();
  /** When a key whose read failed may be tried again. In memory: an outage is not a thing to remember across restarts. */
  readonly #retryAt = new Map<string, number>();
  readonly #aborts = new Set<AbortController>();
  #disposed = false;

  constructor(deps: IssueLookupDeps) {
    this.#deps = deps;
  }

  /**
   * What `mergeBoard` takes: the issue behind each session-named number the assigned read did not return. A number
   * with no reading yet is absent, and the session it came from keeps its checkout card until one lands (R4). A
   * reading that is due to be taken again still answers, so no card is blanked while it is being refreshed.
   */
  known(sessions: readonly Session[], assigned: ReadonlySet<number>): Map<number, IssueCard> {
    const entries = this.#deps.store.read().entries;
    const found = new Map<number, IssueCard>();

    for (const session of sessions) {
      const number = session.issueNumber;
      const key = keyOf(session);

      if (number === null || key === null || assigned.has(number)) {
        continue;
      }

      const entry = entries[key];

      if (entry && 'card' in entry) {
        found.set(number, entry.card);
      }
    }

    return found;
  }

  /**
   * Records the issues a source just reported as assigned, and starts a read for every session-named number whose
   * reading is missing or due to be taken again. Returns at once; a reading calls `changed` when it lands.
   */
  consider(cards: readonly IssueCard[], sessions: readonly Session[], assigned: ReadonlySet<number>): void {
    if (this.#disposed) {
      return;
    }

    const state = this.#deps.store.read();
    const now = this.#deps.now();
    const referenced = new Set<string>();
    let entries = state.entries;

    // Every assigned card, written down while it still is one. This is what makes the unassignment itself cost
    // nothing: by the time the search stops returning the issue, its title is already on disk.
    for (const card of cards) {
      const repository = repositoryKey(card.url);

      if (repository === null) {
        continue;
      }

      const key = knownIssueKey(repository, card.number);
      referenced.add(key);

      // Only a card that actually changed, so a poll that read the same board again does not churn the file.
      if (!sameKnownCard(entries[key], card)) {
        entries = withKnownIssue({ entries }, key, card, now).entries;
      }
    }

    const wanted = new Set<string>();

    for (const session of sessions) {
      const number = session.issueNumber;
      const key = keyOf(session);

      if (number === null || key === null || assigned.has(number)) {
        continue;
      }

      referenced.add(key);

      if (!knownIssueHolds(entries[key], now) && !this.#inFlight.has(key) && (this.#retryAt.get(key) ?? 0) <= now) {
        wanted.add(key);
      }
    }

    this.#deps.store.write(pruneKnownIssues({ entries }, referenced, now));

    // A board of a dozen stale sessions must not put a dozen `gh` processes up at once. The rest come round on the
    // next pass, and nothing on screen is waiting on any one of them.
    for (const key of [...wanted].slice(0, CONCURRENCY)) {
      void this.#read(key);
    }
  }

  dispose(): void {
    this.#disposed = true;

    for (const abort of this.#aborts) {
      abort.abort();
    }

    this.#aborts.clear();
  }

  /**
   * One issue, from whichever source serves its repository. A source answering null does not serve it, which is not
   * an answer about the issue: recording that as "no such issue" is how a hub started before its settings arrive
   * comes to say the developer's own cards do not exist. Only a source that served the read and found nothing does.
   *
   * A failure records nothing either — an unreachable GitHub is not an issue that does not exist — and holds the key
   * off for a few minutes, because the session poll would otherwise spawn `gh` for it twice a minute all outage.
   */
  async #read(key: string): Promise<void> {
    const [repository = '', rest = ''] = key.split('#');
    const number = Number(rest);
    const abort = new AbortController();

    this.#inFlight.add(key);
    this.#aborts.add(abort);

    try {
      let served = false;

      for (const source of this.#deps.sources()) {
        const reading = await source.readCard?.(repository, number, abort.signal);

        if (this.#disposed) {
          return;
        }

        if (reading === undefined || reading === null) {
          continue;
        }

        served = true;

        // Every source that serves it is asked: one being unreachable is not the others having nothing to say.
        if (reading.failure) {
          this.#deps.log.debug(`issue ${key} could not be read: ${reading.failure.message}`, 'issues');
          continue;
        }

        this.#retryAt.delete(key);
        this.#record(key, reading.card);

        return;
      }

      // Served and answered by nobody is every source that serves it having failed. Nothing serving it at all is a
      // repository this machine's sources do not cover, which spawns nothing and so is asked again for free.
      if (served) {
        this.#retryAt.set(key, this.#deps.now() + RETRY_AFTER_FAILURE_MS);
      }
    } catch (error) {
      this.#retryAt.set(key, this.#deps.now() + RETRY_AFTER_FAILURE_MS);
      this.#deps.log.debug(`issue ${key} could not be read: ${String(error)}`, 'issues');
    } finally {
      this.#inFlight.delete(key);
      this.#aborts.delete(abort);
    }
  }

  #record(key: string, card: IssueCard | null): void {
    this.#deps.store.write(withKnownIssue(this.#deps.store.read(), key, card, this.#deps.now()));
    this.#deps.log.info(card === null ? `issue ${key} names no issue` : `issue ${key} read: ${card.title}`, 'issues');
    this.#deps.changed();
  }
}
