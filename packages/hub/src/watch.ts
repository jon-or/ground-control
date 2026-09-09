import { existsSync, readdirSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import type { ActivityChange } from '@ground-control/core';

/** Batch marker events from the first event without extending the deadline; continuous writes must not delay session-end updates. */
export const BATCH_MS = 150;

/** Retry interval for missing directories, which fs.watch cannot watch. */
const DIRECTORY_RETRY_MS = 1000;

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
  let retryTimer: NodeJS.Timeout | undefined;
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
    // Check only the changed path; listing all markers would misclassify pending create events as changes.
    const there = existsSync(`${dir}/${file}`);

    // Check absence first to detect markers created and deleted within one batch.
    const kind: ActivityChange['kind'] = !there ? 'deleted' : held ? 'changed' : 'created';

    if (there) {
      present.add(sessionId);
    } else {
      present.delete(sessionId);
    }

    // Preserve deletion when a marker is written and unlinked in one batch; rosterIsStale must observe the session end.
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
            // The directory disappeared during the event; the close handler restarts the watcher.
          }
        }
      });

      // Restart after either error or close so watching resumes when the directory is recreated.
      watcher.on('error', reArm);
      watcher.on('close', reArm);
    } catch {
      // Retry before the first install and after directory removal.
      retryTimer = deps.setTimeout(arm, DIRECTORY_RETRY_MS);
    }
  };

  function reArm(): void {
    watcher?.removeAllListeners();
    watcher = undefined;

    if (!disposed) {
      retryTimer = deps.setTimeout(arm, DIRECTORY_RETRY_MS);
    }
  }

  arm();

  return {
    dispose(): void {
      disposed = true;

      if (pending !== undefined) {
        deps.clearTimeout(pending);
      }

      if (retryTimer !== undefined) {
        deps.clearTimeout(retryTimer);
      }

      watcher?.removeAllListeners();
      watcher?.close();
    },
  };
}
