import { chmodSync, mkdirSync } from 'node:fs';
import { groundControlDirOf, parseHubConfig } from '@ground-control/core';
import type { HubConfig, ReadFailure } from '@ground-control/core';
import { read, writeIfChanged } from './fs.js';
import { configPathOf } from './paths.js';

/** Persist client settings so Chrome can restart a configured hub without an editor open (R9, R35). */
export type StoredConfig = { config: HubConfig } | { failure: ReadFailure };

export interface SettingsStore {
  /** Return null for absent settings, or a failure for unusable stored settings. */
  read(): StoredConfig | null;
  write(config: HubConfig): void;
}

/** Report the settings file and validation failure. */
function settingsFailure(path: string, message: string): ReadFailure {
  return {
    subject: 'config',
    kind: 'bad-config',
    message: `Saved hub settings are invalid: ${message}`,
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

      // Validate stored settings like client input, including executable paths. Report rejected settings rather than silently replacing them with defaults.
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
          // Restrict configuration access to its owner; Windows inherits directory permissions.
          chmodSync(path, 0o600);
        }
      } catch {
        // Keep accepted settings active after persistence failure; another client can save them later.
      }
    },
  };
}
