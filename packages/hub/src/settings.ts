import { chmodSync, mkdirSync } from 'node:fs';
import { groundControlDirOf, parseHubConfig } from '@ground-control/core';
import type { HubConfig, ReadFailure } from '@ground-control/core';
import { read, writeIfChanged } from './fs.js';
import { configPathOf } from './paths.js';

/**
 * The last configuration a client gave the hub, kept so the next hub starts on it rather than on defaults nobody
 * chose. Which repository work is tracked in cannot be guessed, so a hub the browser started alone would otherwise
 * be permanently unconfigured — and the developer's settings live in an editor that may not be open (R9, R35).
 */
export type StoredConfig = { config: HubConfig } | { failure: ReadFailure };

export interface SettingsStore {
  /** Null where nothing has been stored. A stored configuration that cannot be used comes back as the reason why. */
  read(): StoredConfig | null;
  write(config: HubConfig): void;
}

/** What the board shows for a stored configuration it will not run on: the file, and what was wrong with it. */
function settingsFailure(path: string, message: string): ReadFailure {
  return {
    subject: 'config',
    kind: 'bad-config',
    message: `The settings this machine last accepted cannot be used: ${message}`,
    remedy: `Open the board in an editor to push its settings again, or delete ${path}.`,
  };
}

export function makeSettingsStore(home: string): SettingsStore {
  const path = configPathOf(home);

  return {
    read(): StoredConfig | null {
      const text = read(path);

      if (text === null) {
        return null;
      }

      // Parsed the same way a pushed one is, never trusted for having been written here: one field of it becomes a
      // process, the file sits in a directory any process running as the developer can write, and a build that
      // changed the shape would otherwise hand the loop something it cannot use. What it refuses is said out loud
      // rather than quietly replaced by defaults — a CLI that moved would otherwise drop the repository with it.
      try {
        const parsed = parseHubConfig(JSON.parse(text));

        return 'failure' in parsed ? { failure: settingsFailure(path, parsed.failure.message) } : parsed;
      } catch {
        return { failure: settingsFailure(path, 'It is not the JSON a hub writes.') };
      }
    },

    write(config: HubConfig): void {
      try {
        mkdirSync(groundControlDirOf(home), { recursive: true, mode: 0o700 });

        if (writeIfChanged(path, `${JSON.stringify(config, null, 2)}\n`)) {
          // The developer's repository, their logins, and the paths of the processes the hub spawns. Read and
          // written by them alone, the way the hub's own bundle is; on Windows the mode is the directory's.
          chmodSync(path, 0o600);
        }
      } catch {
        // A configuration that could not be stored is one the next editor window pushes again. Refusing the
        // settings the developer just made because a write failed is the worse of the two.
      }
    },
  };
}
