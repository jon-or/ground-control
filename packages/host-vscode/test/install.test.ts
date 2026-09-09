import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stagedUpdate, stagedUpdateRefusal } from '../src/install.js';

/** The commit as VS Code's updater writes it, the ten characters of it that name the directory, and one running (M49). */
const COMMIT = '88e44fa0e00b08f7758b4f6d05632e4fd5e4df6f';
const STAGED = '88e44fa0e0';
const RUNNING = 'a44adf7f53';

const made: string[] = [];

interface Install {
  execPath: string;
  appRoot: string;
  stagedAppRoot: string;
}

/** An install directory shaped like the measured one: an executable, a marker, and a version tree per build (M49). */
function install(marker?: string, staged?: { version?: unknown } | string): Install {
  const dir = mkdtempSync(join(tmpdir(), 'gc-install-'));
  made.push(dir);

  writeFileSync(join(dir, 'Code.exe'), '');

  if (marker !== undefined) {
    writeFileSync(join(dir, 'updating_version'), marker);
  }

  const stagedAppRoot = join(dir, STAGED, 'resources', 'app');

  if (staged !== undefined) {
    mkdirSync(stagedAppRoot, { recursive: true });
    writeFileSync(join(stagedAppRoot, 'product.json'), typeof staged === 'string' ? staged : JSON.stringify(staged));
  }

  return { execPath: join(dir, 'Code.exe'), appRoot: join(dir, RUNNING, 'resources', 'app'), stagedAppRoot };
}

afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('a staged background update', () => {
  it('is nothing to report when no marker sits beside the executable', () => {
    const { execPath, appRoot } = install(undefined, { version: '1.136.2' });

    expect(stagedUpdate(execPath, appRoot)).toBeNull();
  });

  it('names the version the marker staged', () => {
    const { execPath, appRoot } = install(`${COMMIT}\n`, { version: '1.136.2' });

    expect(stagedUpdate(execPath, appRoot)).toEqual({ version: '1.136.2' });
  });

  it('is nothing to report when these windows already run the staged commit', () => {
    const { execPath, stagedAppRoot } = install(COMMIT, { version: '1.136.2' });

    expect(stagedUpdate(execPath, stagedAppRoot)).toBeNull();
  });

  it('compares commit directories for Insiders builds', () => {
    const { execPath, stagedAppRoot } = install(COMMIT, { version: '1.137.0-insider' });

    expect(stagedUpdate(execPath, stagedAppRoot)).toBeNull();
  });

  it('still reports a marker whose product.json is missing', () => {
    const { execPath, appRoot } = install(COMMIT);

    expect(stagedUpdate(execPath, appRoot)).toEqual({ version: null });
  });

  it('still reports a marker whose product.json will not parse', () => {
    const { execPath, appRoot } = install(COMMIT, '{ not json');

    expect(stagedUpdate(execPath, appRoot)).toEqual({ version: null });
  });

  it('still reports a marker whose product.json carries no version string', () => {
    const { execPath, appRoot } = install(COMMIT, { version: 2 });

    expect(stagedUpdate(execPath, appRoot)).toEqual({ version: null });
  });

  it('is nothing to report when the marker is empty', () => {
    const { execPath, appRoot } = install('   \n', { version: '1.136.2' });

    expect(stagedUpdate(execPath, appRoot)).toBeNull();
  });
});

describe('the refusal', () => {
  it('names both versions and tells the developer to restart', () => {
    const message = stagedUpdateRefusal({ version: '1.136.2' }, '1.136.1');

    expect(message).toContain('1.136.2');
    expect(message).toContain('1.136.1');
    expect(message).toContain('Restart VS Code');
  });

  it('describes an unreadable staged version as a newer build', () => {
    expect(stagedUpdateRefusal({ version: null }, '1.136.1')).toContain('a newer build');
  });
});
