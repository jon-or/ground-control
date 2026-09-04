import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/registry.js';
import { configPathOf } from '../src/paths.js';
import { makeSettingsStore } from '../src/settings.js';
import { tempHome } from './helpers.js';

const homes: (() => void)[] = [];

afterEach(() => {
  while (homes.length) {
    homes.pop()?.();
  }
});

function home(): string {
  const made = tempHome();

  homes.push(made.dispose);

  return made.home;
}

/** The developer's own settings, as an editor window pushes them. */
function configured() {
  return {
    ...defaultConfig(),
    sources: { github: { repo: 'example-org/example-repo', logins: ['dev-1'] } },
    refreshIntervalMs: 60_000,
  };
}

describe('the configuration the hub was last given', () => {
  it('is nothing at all before a client has pushed one', () => {
    expect(makeSettingsStore(home()).read()).toBeNull();
  });

  it('comes back as it was written', () => {
    const where = home();
    const store = makeSettingsStore(where);

    store.write(configured());

    expect(store.read()).toEqual(configured());
  });

  /**
   * Parsed on the way back in, never trusted for having been written here. One field of a configuration becomes a
   * process the hub spawns, and this file sits in a directory any process running as the developer can write.
   */
  it('is refused when the file names something the hub would spawn', () => {
    const where = home();
    const store = makeSettingsStore(where);

    store.write(configured());
    writeFileSync(
      configPathOf(where),
      JSON.stringify({ ...configured(), agents: [{ id: 'claude', path: 'd:/nothing/here/claude.exe' }] }),
    );

    expect(store.read()).toBeNull();
  });

  it('is nothing when the file is not a configuration at all', () => {
    const where = home();

    mkdirSync(dirname(configPathOf(where)), { recursive: true });
    writeFileSync(configPathOf(where), 'half a file');

    expect(makeSettingsStore(where).read()).toBeNull();

    writeFileSync(configPathOf(where), JSON.stringify({ nothing: 'the hub can read' }));

    expect(makeSettingsStore(where).read()).toBeNull();
  });
});
