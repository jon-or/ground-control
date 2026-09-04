import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

    expect(store.read()).toEqual({ config: configured() });
  });

  /** A file the developer alone reads: it holds their repository, their logins, and the paths the hub spawns. */
  it('is written for the developer and nobody else', () => {
    const where = home();

    makeSettingsStore(where).write(configured());

    // Windows carries the directory's own permissions rather than the file's, so there is nothing here to assert.
    if (process.platform !== 'win32') {
      expect(statSync(configPathOf(where)).mode & 0o777).toBe(0o600);
    }
  });

  /**
   * A configuration that cannot be stored is one the next editor window pushes again. Refusing the settings the
   * developer just made because a write failed is the worse of the two.
   */
  it('says nothing and keeps what it had when the file cannot be written', () => {
    const where = home();
    const store = makeSettingsStore(where);

    store.write(configured());
    // A directory where the file goes: every write onto it fails, and none of them may throw.
    rmSync(configPathOf(where));
    mkdirSync(configPathOf(where));

    expect(() => store.write({ ...configured(), refreshIntervalMs: 90_000 })).not.toThrow();
    expect(store.read()).toBeNull();
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

    const held = store.read();

    // Named, never quietly replaced by defaults: a CLI that moved would otherwise take the repository with it.
    expect(held && 'failure' in held && held.failure.subject).toBe('config');
    expect(held && 'failure' in held && held.failure.remedy).toContain(configPathOf(where));
  });

  it('is refused when the file is not a configuration at all', () => {
    const where = home();

    mkdirSync(dirname(configPathOf(where)), { recursive: true });
    writeFileSync(configPathOf(where), 'half a file');

    expect(makeSettingsStore(where).read()).toMatchObject({ failure: { kind: 'bad-config' } });

    writeFileSync(configPathOf(where), JSON.stringify({ nothing: 'the hub can read' }));

    expect(makeSettingsStore(where).read()).toMatchObject({ failure: { kind: 'bad-config' } });
  });
});
