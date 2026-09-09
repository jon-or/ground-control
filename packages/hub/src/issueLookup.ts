import { knownIssueHolds, knownIssueKey, pruneKnownIssues, sameKnownCard, withKnownIssue } from '@ground-control/board';
import { repositoryKey } from '@ground-control/core';
import type { IssueCard, Logger, Session, WorkSource } from '@ground-control/core';
import type { IssueStore } from './issueStore.js';

export interface IssueLookupDeps {
  store: IssueStore;
  /** Configured sources, queried in order when they support readCard. */
  sources(): readonly WorkSource[];
  log: Logger;
  now(): number;
  /** Redraw after a lookup completes. */
  changed(): void;
  /** Current session policy; a completed read must not publish or log an excluded session-derived issue. */
  allowed?(key: string): boolean;
}

/** Maximum concurrent issue lookups. */
const CONCURRENCY = 3;

/** Delay failed lookups across session polls during outages. */
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;

/** Build the repository-scoped issue key, or null if the repository is unknown. */
function keyOf(session: Session): string | null {
  return session.repository !== null && session.issueNumber !== null
    ? knownIssueKey(session.repository, session.issueNumber)
    : null;
}

/** Resolve session-linked issues absent from assigned results. Prefer stored cards to avoid repeat requests after unassignment. */
export class IssueLookup {
  readonly #deps: IssueLookupDeps;
  readonly #inFlight = new Set<string>();
  /** In-memory retry deadlines for failed lookups. */
  readonly #retryAt = new Map<string, number>();
  readonly #aborts = new Set<AbortController>();
  #disposed = false;

  constructor(deps: IssueLookupDeps) {
    this.#deps = deps;
  }

  /** Supply cached issues for session-linked numbers absent from assigned results. Missing entries retain checkout cards; expired entries remain visible during refresh (R4). */
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

  /** Cache assigned issues and asynchronously refresh missing or expired session-linked issues. Call changed on completion. */
  consider(cards: readonly IssueCard[], sessions: readonly Session[], assigned: ReadonlySet<number>): void {
    if (this.#disposed) {
      return;
    }

    const state = this.#deps.store.read();
    const now = this.#deps.now();
    const referenced = new Set<string>();
    let entries = state.entries;

    // Cache assigned cards before unassignment so their metadata remains available without a lookup.
    for (const card of cards) {
      const repository = repositoryKey(card.url);

      if (repository === null) {
        continue;
      }

      const key = knownIssueKey(repository, card.number);
      referenced.add(key);

      // Write only changed cards to avoid redundant disk writes on each poll.
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

    // Bound concurrent gh processes; remaining lookups wait for the next pass.
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
   * Cache absence only when a source serves the repository and confirms no issue. Unserved repositories and
   * failed reads establish nothing about existence. Delay failed lookups to avoid a gh request on every
   * session poll.
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
        if (this.#deps.allowed?.(key) === false) return;
        const reading = await source.readCard?.(repository, number, abort.signal);

        if (this.#disposed || this.#deps.allowed?.(key) === false) {
          return;
        }

        if (reading === undefined || reading === null) {
          continue;
        }

        served = true;

        // Try all serving sources even if an earlier source fails.
        if (reading.failure) {
          this.#deps.log.debug(`issue ${key} could not be read: ${reading.failure.message}`, 'issues');
          continue;
        }

        this.#retryAt.delete(key);
        this.#record(key, reading.card);

        return;
      }

      // Delay retries when serving sources fail. Unserved repositories incur no CLI request and may be checked again immediately.
      if (served) {
        this.#retryAt.set(key, this.#deps.now() + RETRY_AFTER_FAILURE_MS);
      }
    } catch (error) {
      this.#retryAt.set(key, this.#deps.now() + RETRY_AFTER_FAILURE_MS);
      if (this.#deps.allowed?.(key) !== false) this.#deps.log.debug(`issue ${key} could not be read: ${String(error)}`, 'issues');
    } finally {
      this.#inFlight.delete(key);
      this.#aborts.delete(abort);
    }
  }

  #record(key: string, card: IssueCard | null): void {
    this.#deps.store.write(withKnownIssue(this.#deps.store.read(), key, card, this.#deps.now()));
    this.#deps.log.info(card === null ? `issue ${key} not found` : `issue ${key} read: ${card.title}`, 'issues');
    this.#deps.changed();
  }
}
