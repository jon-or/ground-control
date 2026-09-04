import { mkdirSync } from 'node:fs';
import { groundControlDirOf, parseHubConfig } from '@ground-control/core';
import type { HubConfig } from '@ground-control/core';
import { read, writeIfChanged } from './fs.js';
import { configPathOf } from './paths.js';

/**
 * The last configuration a client gave the hub, kept so the next hub starts on it rather than on defaults nobody
 * chose. Which repository work is tracked in cannot be guessed, so a hub the browser started alone would otherwise
 * be permanently unconfigured — and the developer's settings live in an editor that may not be open (R9, R35).
 */
export interface SettingsStore {
  read(): HubConfig | null;
  write(config: HubConfig): void;
}

export function makeSettingsStore(home: string): SettingsStore {
  const path = configPathOf(home);

  return {
    read(): HubConfig | null {
      const text = read(path);

      if (text === null) {
        return null;
      }

      // Parsed the same way a pushed one is, never trusted for having been written here: one field of it becomes a
      // process, the file sits in a directory any process running as the developer can write, and a build that
      // changed the shape would otherwise hand the loop something it cannot use.
      try {
        const parsed = parseHubConfig(JSON.parse(text));

        return 'failure' in parsed ? null : parsed.config;
      } catch {
        return null;
      }
    },

    write(config: HubConfig): void {
      try {
        mkdirSync(groundControlDirOf(home), { recursive: true });
        writeIfChanged(path, `${JSON.stringify(config, null, 2)}\n`);
      } catch {
        // A configuration that could not be stored is one the next editor window pushes again. Refusing the
        // settings the developer just made because a write failed is the worse of the two.
      }
    },
  };
}
