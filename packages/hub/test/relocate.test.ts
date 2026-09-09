import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { makeActionStore } from '../src/actionStore.js';
import { ACTION_REVISION } from '@ground-control/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapDirOf, formatStatePointer, resolveStateDir, statePointerPathOf } from '@ground-control/core';
import { relocateLockPathOf } from '../src/paths.js';
import { launchArtifacts, recoverRelocation, relocateState, relocationRefusal, relocationTarget } from '../src/relocate.js';
import type { RelocationDeps } from '../src/relocate.js';
import { tempHome } from './helpers.js';

let home: string;
let bootstrap: string;
let dispose: () => void;

beforeEach(() => {
  ({ home, dispose } = tempHome());
  home = home.replace(/\\/g, '/');
  bootstrap = bootstrapDirOf(home);
  mkdirSync(bootstrap, { recursive: true });
});

afterEach(() => dispose());

const NOW = Date.parse('2026-09-09T12:00:00.000Z');

/** Seed the layout an installed hub leaves behind: launch artifacts beside state, with a nested run report. */
function seedState(dir: string): void {
  mkdirSync(`${dir}/runs`, { recursive: true });
  mkdirSync(`${dir}/activity`, { recursive: true });
  writeFileSync(`${dir}/lanes.json`, '{"placements":{"issue:1":"review"}}');
  writeFileSync(`${dir}/config.json`, '{"agents":[]}');
  writeFileSync(`${dir}/runs/issue-1.json`, '{"outcome":"pushed"}');
  writeFileSync(`${dir}/activity/session.json`, '{"v":1}');
  writeFileSync(`${dir}/hub.log`, 'listening\n');
  writeFileSync(`${dir}/hub-exit.json`, '{"reason":"stale"}');
  writeFileSync(`${dir}/lanes.json.4242.tmp`, 'partial');
}

function seedLaunchArtifacts(): void {
  writeFileSync(`${bootstrap}/hub.js`, '// bundle');
  writeFileSync(`${bootstrap}/hook.mjs`, '// writer');
  writeFileSync(`${bootstrap}/codex-hook.mjs`, '// writer');
  writeFileSync(`${bootstrap}/ground-control-bridge.cmd`, '@echo off');
}

/** A hub that answers stop requests and is gone after the stop, unless the test says otherwise. */
function deps(over: Partial<RelocationDeps> & { stubborn?: boolean } = {}): RelocationDeps & { stops: string[]; clock: { now: number } } {
  const clock = { now: NOW };
  const stops: string[] = [];
  let live = true;

  return {
    clock,
    stops,
    home,
    now: () => clock.now,
    sleep: (ms) => {
      clock.now += ms;

      return Promise.resolve();
    },
    stopHub: (stateDir) => {
      stops.push(stateDir);
      live = over.stubborn === true;

      return Promise.resolve(!live);
    },
    hubIsLive: () => Promise.resolve(live),
    ...over,
  };
}

describe('reading the setting', () => {
  it('selects the bootstrap directory for an empty value', () => {
    expect(relocationTarget(home, '')).toEqual({ stateDir: bootstrap });
    expect(relocationTarget(home, '   ')).toEqual({ stateDir: bootstrap });
  });

  it('normalizes an absolute value', () => {
    expect(relocationTarget('C:/Users/dev', 'E:\\state\\gc\\')).toEqual({ stateDir: 'E:/state/gc' });
  });

  it.each(['relative/dir', ' E:/padded', 'E:/control\u0000char'])('refuses %j', (value) => {
    expect(relocationTarget(home, value)).toEqual({ refused: `groundControl.stateDirectory must be an absolute path without surrounding whitespace: "${value}".` });
  });
});

describe('what a destination may be', () => {
  const fs = (entries: Record<string, string[] | 'file'>, aliases: Record<string, string> = {}) => ({
    list: (dir: string) => {
      const held = entries[dir];

      return held === undefined || held === 'file' ? null : held;
    },
    isFile: (path: string) => entries[path] === 'file',
    realPath: (path: string) => aliases[path] ?? (entries[path] === undefined ? null : path),
  });

  it('accepts an absent or empty directory, or one holding only launch artifacts and transient files', () => {
    expect(relocationRefusal(home, bootstrap, `${home}/elsewhere`, fs({}))).toBeNull();
    expect(relocationRefusal(home, bootstrap, `${home}/elsewhere`, fs({ [`${home}/elsewhere`]: [] }))).toBeNull();
    expect(relocationRefusal(home, `${home}/elsewhere`, bootstrap, fs({ [bootstrap]: [...launchArtifacts(home), 'hub-exit.json', 'lanes.json.1.tmp', 'hub.json', 'install.lock'] }))).toBeNull();
  });

  it('refuses a destination holding state, naming what is there', () => {
    expect(relocationRefusal(home, bootstrap, `${home}/used`, fs({ [`${home}/used`]: ['lanes.json'] })))
      .toBe(`${home}/used already contains a file (lanes.json). Choose an empty directory.`);
    expect(relocationRefusal(home, bootstrap, `${home}/used`, fs({ [`${home}/used`]: ['a', 'b', 'c', 'd'] })))
      .toBe(`${home}/used already contains 4 files (a, b, c). Choose an empty directory.`);
  });

  it('refuses a file, a directory inside the current one, and one containing it', () => {
    expect(relocationRefusal(home, bootstrap, `${home}/file`, fs({ [`${home}/file`]: 'file' }))).toBe(`${home}/file is a file, not a directory.`);
    expect(relocationRefusal(home, bootstrap, `${bootstrap}/inner`, fs({}))).toBe(`The state directory ${bootstrap}/inner cannot be inside the current one, or contain it.`);
    expect(relocationRefusal(home, bootstrap, `${home}/.claude`, fs({}))).toBe(`The state directory ${home}/.claude cannot be inside the current one, or contain it.`);
  });

  it('ignores separator and case differences when deciding nesting', () => {
    expect(relocationRefusal('C:/Users/dev', 'C:/Users/dev/.claude/ground-control', 'c:\\users\\DEV\\.claude\\ground-control\\sub', fs({})))
      .toContain('cannot be inside');
  });

  it('sees through a link to the current directory, including a destination below a missing tail', () => {
    const aliased = fs({ 'E:/link': [], 'E:/gc': ['lanes.json'] }, { 'E:/link': 'E:/gc' });

    expect(relocationRefusal(home, 'E:/gc', 'E:/link', aliased)).toContain('cannot be inside');
    expect(relocationRefusal(home, 'E:/gc', 'E:/link/deeper/still', aliased)).toContain('cannot be inside');
    expect(relocationRefusal(home, 'E:/gc', 'E:/other', aliased)).toBeNull();
  });
});

describe('moving the state', () => {
  it('stops the hub, copies state without launch artifacts or transient files, commits the pointer, then removes the sources', async () => {
    seedState(bootstrap);
    seedLaunchArtifacts();

    const to = `${home}/elsewhere/state`;
    const d = deps();
    const result = await relocateState(to, d);

    expect(result).toEqual({ stateDir: to, moved: 5, leftover: [] });
    expect(d.stops).toEqual([bootstrap]);
    expect(readdirSync(to).sort()).toEqual(['activity', 'config.json', 'hub.log', 'lanes.json', 'runs']);
    expect(readFileSync(`${to}/runs/issue-1.json`, 'utf8')).toBe('{"outcome":"pushed"}');
    expect(readFileSync(`${to}/activity/session.json`, 'utf8')).toBe('{"v":1}');
    expect(readdirSync(bootstrap).sort()).toEqual(['codex-hook.mjs', 'ground-control-bridge.cmd', 'hook.mjs', 'hub-exit.json', 'hub.js', 'lanes.json.4242.tmp', 'state-dir.json']);
    expect(resolveStateDir(home, undefined, NOW)).toEqual({ stateDir: to, migratingTo: null, interruptedTo: null, problem: null });
    expect(existsSync(relocateLockPathOf(home))).toBe(false);
  });

  it('moves back to the bootstrap directory and removes the pointer', async () => {
    const custom = `${home}/custom`;

    seedState(custom);
    seedLaunchArtifacts();
    writeFileSync(statePointerPathOf(home), formatStatePointer({ stateDir: custom }));

    const result = await relocateState(bootstrap, deps());

    expect(result).toEqual({ stateDir: bootstrap, moved: 5, leftover: [] });
    expect(existsSync(statePointerPathOf(home))).toBe(false);
    expect(readFileSync(`${bootstrap}/lanes.json`, 'utf8')).toBe('{"placements":{"issue:1":"review"}}');
    expect(readdirSync(custom).sort()).toEqual(['hub-exit.json', 'lanes.json.4242.tmp']);
  });

  it('is a no-op when the target is already the state directory', async () => {
    seedState(bootstrap);

    const d = deps();

    expect(await relocateState(`${home}\\.claude\\ground-control\\`, d)).toEqual({ stateDir: bootstrap, moved: 0, leftover: [] });
    expect(d.stops).toEqual([]);
    expect(existsSync(`${bootstrap}/lanes.json`)).toBe(true);
  });

  it('refuses a destination holding state before touching the hub', async () => {
    seedState(bootstrap);
    mkdirSync(`${home}/used`);
    writeFileSync(`${home}/used/lanes.json`, '{}');

    const d = deps();

    expect(await relocateState(`${home}/used`, d)).toEqual({ refused: `${home}/used already contains a file (lanes.json). Choose an empty directory.` });
    expect(d.stops).toEqual([]);
    expect(existsSync(statePointerPathOf(home))).toBe(false);
  });

  it('records the migration before stopping the hub, and clears it when the hub will not stop', async () => {
    seedState(bootstrap);

    const to = `${home}/elsewhere`;
    const seen: ReturnType<typeof resolveStateDir>[] = [];
    const d = deps({
      stubborn: true,
      stopHub: (stateDir) => {
        seen.push(resolveStateDir(home, undefined, NOW));

        return Promise.resolve(stateDir === bootstrap);
      },
    });

    expect(await relocateState(to, d)).toEqual({ failed: `The hub serving ${bootstrap} did not stop. Close other Ground Control windows and try again.` });
    expect(seen).toEqual([{ stateDir: bootstrap, migratingTo: to, interruptedTo: null, problem: null }]);
    expect(existsSync(statePointerPathOf(home))).toBe(false);
    expect(existsSync(to)).toBe(false);
    expect(existsSync(`${bootstrap}/lanes.json`)).toBe(true);
  });

  it('removes its copies and restores the pointer when copying fails, leaving the source complete', async () => {
    const custom = `${home}/custom`;
    const to = `${home}/blocked`;

    seedState(custom);
    writeFileSync(statePointerPathOf(home), formatStatePointer({ stateDir: custom }));
    mkdirSync(to, { recursive: true });
    writeFileSync(`${to}/lanes.json.1.tmp`, 'transient');

    // Someone else's directory appearing at the destination during shutdown stops the move; it is theirs to keep.
    const d = deps({ stopHub: () => { mkdirSync(`${to}/runs`, { recursive: true }); writeFileSync(`${to}/runs/theirs.json`, 'not ours'); return Promise.resolve(true); }, hubIsLive: () => Promise.resolve(false) });
    const failed = await relocateState(to, d);

    expect(failed).toMatchObject({ failed: expect.stringContaining(`Could not move Ground Control state to ${to}: ${to}/runs appeared at the destination.`) });
    expect(failed).toMatchObject({ failed: expect.stringContaining(`The state remains in ${custom}.`) });
    expect(readdirSync(custom).sort()).toEqual(['activity', 'config.json', 'hub-exit.json', 'hub.log', 'lanes.json', 'lanes.json.4242.tmp', 'runs']);
    expect(readFileSync(statePointerPathOf(home), 'utf8')).toBe(formatStatePointer({ stateDir: custom }));
    expect(readdirSync(to).sort()).toEqual(['lanes.json.1.tmp', 'runs']);
    expect(readFileSync(`${to}/runs/theirs.json`, 'utf8')).toBe('not ours');

    rmSync(`${to}/runs`, { recursive: true });
    expect(await relocateState(to, deps({ hubIsLive: () => Promise.resolve(false) }))).toEqual({ stateDir: to, moved: 5, leftover: [] });
  });

  it('refuses to move under a running card action, which was told to report into the current directory', async () => {
    seedState(bootstrap);
    makeActionStore(bootstrap).write({
      runs: { 'issue:1': { key: 'issue:1', action: 'merge-upstream', revision: ACTION_REVISION, evidence: 'e', startedAt: NOW, endedAt: null, agent: 'claude', sessionId: 's', shortId: 's', outcome: 'running', detail: 'Working.' } },
      refusals: {}, gates: {}, dispatches: [NOW],
    });

    const d = deps();

    expect(await relocateState(`${home}/elsewhere`, d)).toEqual({ refused: `A card action is still running from ${bootstrap}. Wait for or stop them, then try again.` });
    expect(d.stops).toEqual([]);
  });

  it('fails rather than committing an empty move when the current directory cannot be read', async () => {
    const custom = `${home}/custom-file`;

    writeFileSync(custom, 'a file where the state directory should be');
    writeFileSync(statePointerPathOf(home), formatStatePointer({ stateDir: custom }));

    const d = deps();

    expect(await relocateState(`${home}/elsewhere`, d)).toEqual({ failed: `The current state directory ${custom} cannot be read, so its state cannot be moved.` });
    expect(d.stops).toEqual([]);
    expect(readFileSync(statePointerPathOf(home), 'utf8')).toBe(formatStatePointer({ stateDir: custom }));
  });

  it('fails while the pointer is unusable instead of treating the bootstrap directory as current', async () => {
    seedState(bootstrap);
    writeFileSync(statePointerPathOf(home), '{ not json');

    const d = deps();

    expect(await relocateState(`${home}/elsewhere`, d)).toEqual({ failed: `state-dir.json is not JSON. Fix or delete it in ${bootstrap} before moving the state.` });
    expect(d.stops).toEqual([]);
    expect(existsSync(`${home}/elsewhere`)).toBe(false);
  });

  it('renews its lock while copying, so another window cannot clear a slow move as abandoned', async () => {
    seedState(bootstrap);

    const to = `${home}/elsewhere`;
    const d = deps();
    let stopped = false;
    let recoveries = 0;

    // The hub confirms it stopped, then the clock jumps past the stale-lock window before the copy begins.
    d.hubIsLive = () => {
      stopped = true;
      d.clock.now += 120_000;

      return Promise.resolve(false);
    };
    // Between two entries of the copy, a second window tries to recover the move; a renewed lock must refuse it.
    let renewals = 0;
    d.now = () => {
      if (stopped && ++renewals === 3) {
        recoveries += 1;
        expect(recoverRelocation(home, d.clock.now)).toBeNull();
      }

      return d.clock.now;
    };

    expect(await relocateState(to, d)).toEqual({ stateDir: to, moved: 5, leftover: [] });
    expect(recoveries).toBe(1);
    expect(existsSync(relocateLockPathOf(home))).toBe(false);
  });

  it('reports busy while another window holds the relocation lock', async () => {
    seedState(bootstrap);
    writeFileSync(relocateLockPathOf(home), 'another window');
    utimesSync(relocateLockPathOf(home), new Date(NOW), new Date(NOW));

    const d = deps();

    expect(await relocateState(`${home}/elsewhere`, d)).toEqual({ busy: true });
    expect(d.stops).toEqual([]);
    expect(existsSync(statePointerPathOf(home))).toBe(false);
  });
});

describe('an interrupted move', () => {
  it('is cleared when nobody holds the lock, and the developer is told what was left', () => {
    const to = `${home}/elsewhere`;

    writeFileSync(statePointerPathOf(home), formatStatePointer({ stateDir: bootstrap, migration: { to, startedAt: new Date(NOW - 5000).toISOString() } }));

    expect(recoverRelocation(home, NOW)).toBe(`A move of Ground Control state to ${to} did not finish. State remains in ${bootstrap}; remove any files copied to ${to} before choosing it again.`);
    expect(existsSync(statePointerPathOf(home))).toBe(false);
    expect(recoverRelocation(home, NOW)).toBeNull();
  });

  it('keeps a custom directory named by the pointer', () => {
    const custom = `${home}/custom`;

    writeFileSync(statePointerPathOf(home), formatStatePointer({ stateDir: custom, migration: { to: `${home}/next`, startedAt: 'never' } }));
    recoverRelocation(home, NOW);

    expect(readFileSync(statePointerPathOf(home), 'utf8')).toBe(formatStatePointer({ stateDir: custom }));
  });

  it('leaves a move alone while its window holds the lock', () => {
    writeFileSync(statePointerPathOf(home), formatStatePointer({ stateDir: bootstrap, migration: { to: `${home}/next`, startedAt: new Date(NOW).toISOString() } }));
    writeFileSync(relocateLockPathOf(home), 'another window');
    utimesSync(relocateLockPathOf(home), new Date(NOW), new Date(NOW));

    expect(recoverRelocation(home, NOW)).toBeNull();
    expect(resolveStateDir(home, undefined, NOW).migratingTo).toBe(`${home}/next`);
  });
});
