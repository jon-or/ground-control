import { existsSync, readdirSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import type { ActivityChange } from '@ground-control/core';

/**
 * A turn boundary writes several markers at once, and every one of them would otherwise re-post the whole board. The
 * window runs from the first event and is never extended: seventeen live sessions can write faster than it, and a
 * batch that re-arms on every write is a session end that never reaches the board.
 */
export const BATCH_MS = 150;

/** How often a directory that does not exist yet is looked for. `fs.watch` cannot be armed on a missing path. */
const APPEAR_MS = 1000;

export interface WatchDeps {
  setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout: (handle: NodeJS.Timeout) => void;
}

const REAL: WatchDeps = { setTimeout, clearTimeout };

const nameOf = (file: string): string => file.replace(/\.json$/, '');

/**
 * Re-arm fs.watch after missing or removed directories. Classify changes by file existence and prior
 * membership, not the platform event name. A deletion still absent at listing wins within the batch; a
 * recreated marker is changed. The hub decides whether the update requires a roster read.
 */
export function watchDir(
  dir: string,
  onChange: (changes: ActivityChange[]) => void,
  deps: WatchDeps = REAL,
): { dispose: () => void } {
  let watcher: FSWatcher | undefined;
  let appearing: NodeJS.Timeout | undefined;
  let pending: NodeJS.Timeout | undefined;
  let disposed = false;

  let present = new Set<string>();
  let batch = new Map<string, ActivityChange['kind']>();

  const flush = (): void => {
    const changes = [...batch.values()].length === 0 ? [] : [...batch].map(([sessionId, kind]) => ({ kind, sessionId }));

    batch = new Map();
    pending = undefined;

    if (changes.length > 0 && !disposed) {
      onChange(changes);
    }
  };

  const record = (file: string): void => {
    const sessionId = nameOf(file);
    const held = present.has(sessionId);
    // This one path, not a listing of the directory: a listing taken while a turn boundary is writing already holds
    // the markers whose own events have not arrived yet, which would read every one of them as a rewrite.
    const there = existsSync(`${dir}/${file}`);

    // A marker that appeared and went inside one batch is a session that ended, so absence decides before presence.
    const kind: ActivityChange['kind'] = !there ? 'deleted' : held ? 'changed' : 'created';

    if (there) {
      present.add(sessionId);
    } else {
      present.delete(sessionId);
    }

    // A `deleted` wins whenever it is seen, because it is the only kind `rosterIsStale` acts on: a session that ends
    // just after a tool completes writes then unlinks inside one batch, and first-kind-wins would drop the end.
    if (kind === 'deleted' || !batch.has(sessionId)) {
      batch.set(sessionId, kind);
    }

    pending ??= deps.setTimeout(flush, BATCH_MS);
  };

  const arm = (): void => {
    if (disposed) {
      return;
    }

    try {
      present = new Set(readdirSync(dir, 'utf8').map(nameOf));
      watcher = watch(dir, (_event, file) => {
        if (typeof file === 'string' && file.endsWith('.json')) {
          try {
            record(file);
          } catch {
            // The directory went away mid-event. The watcher's own close re-arms.
          }
        }
      });

      // A watcher whose directory is removed emits an error or simply closes, and either leaves the board deaf to
      // every phase from then on. Both re-arm rather than being reported: the install brings it back.
      watcher.on('error', reArm);
      watcher.on('close', reArm);
    } catch {
      // The directory is not there yet, which is the state before the first install and after a removal.
      appearing = deps.setTimeout(arm, APPEAR_MS);
    }
  };

  function reArm(): void {
    watcher?.removeAllListeners();
    watcher = undefined;

    if (!disposed) {
      appearing = deps.setTimeout(arm, APPEAR_MS);
    }
  }

  arm();

  return {
    dispose(): void {
      disposed = true;

      if (pending !== undefined) {
        deps.clearTimeout(pending);
      }

      if (appearing !== undefined) {
        deps.clearTimeout(appearing);
      }

      watcher?.removeAllListeners();
      watcher?.close();
    },
  };
}
