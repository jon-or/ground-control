import { describe, expect, it } from 'vitest';
import { planHookInstall } from '../src/hookPlan.js';
import { hookPathOf } from '../src/hookScript.js';
import { phaseOf } from '../src/phase.js';
import { HOME } from './helpers.js';

/**
 * Every event the board installs, and the phase each one claims. Asserted whole rather than sampled: an event
 * dropped from the install is a phase the board silently stops seeing, and one installed but unmapped is a spawn
 * per event that buys nothing. Measured in `docs/mechanics.md` §40.
 */
const WANTED = [
  ['SessionStart', null],
  ['UserPromptSubmit', 'running'],
  ['PreToolUse', 'running'],
  ['PermissionRequest', 'waiting'],
  ['PostToolUse', 'running'],
  ['SubagentStart', 'running'],
  ['SubagentStop', 'running'],
  ['PreCompact', 'running'],
  ['PostCompact', 'running'],
  ['Stop', 'idle'],
  ['Interrupt', 'idle'],
  ['SessionEnd', null],
] as const;

const WRITER = hookPathOf(HOME);
const COMMAND = `node "${WRITER}"`;

interface Written {
  hooks?: Record<string, { hooks: { type: string; command: string; async?: boolean; timeout?: number }[] }[]>;
  [key: string]: unknown;
}

function install(settingsText: string | null) {
  return planHookInstall({ settingsText, home: HOME, wanted: 'install' });
}

function remove(settingsText: string | null) {
  return planHookInstall({ settingsText, home: HOME, wanted: 'remove' });
}

function written(plan: ReturnType<typeof planHookInstall>): Written {
  if (plan.kind !== 'write') {
    throw new Error(`expected a write, got ${plan.kind}`);
  }

  return JSON.parse(plan.text) as Written;
}

describe('installing the Codex hook entries', () => {
  it('writes one entry per event into a file that does not exist yet', () => {
    const plan = install(null);
    const file = written(plan);

    expect(plan).toMatchObject({ kind: 'write', added: WANTED.length, removed: 0 });
    expect(Object.keys(file.hooks ?? {})).toEqual(WANTED.map(([event]) => event));
    expect(file.hooks?.['SessionStart']).toEqual([
      { hooks: [{ type: 'command', command: COMMAND, async: true, timeout: 5 }] },
    ]);
  });

  it('installs an entry for every event the board maps, and maps every event it installs', () => {
    const installed = Object.keys(written(install(null)).hooks ?? {});

    for (const [event, phase] of WANTED) {
      expect(installed).toContain(event);
      expect(phaseOf({ event, turnAt: null, at: 0 } as never)).toBe(phase);
    }

    expect(installed).toHaveLength(WANTED.length);
  });

  it('asks for the three seconds Codex clamps its shutdown events to', () => {
    const file = written(install(null));

    expect(file.hooks?.['SessionEnd']?.[0]?.hooks[0]?.timeout).toBe(3);
    expect(file.hooks?.['Interrupt']?.[0]?.hooks[0]?.timeout).toBe(3);
    expect(file.hooks?.['Stop']?.[0]?.hooks[0]?.timeout).toBe(5);
  });

  it('writes nothing the second time, so opening the board does not rewrite the developer file', () => {
    const first = written(install(null));

    expect(install(JSON.stringify(first, null, 2))).toEqual({ kind: 'up-to-date' });
  });

  it('collapses two entries of ours into one', () => {
    const doubled = {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: COMMAND, async: true, timeout: 5 }] },
          { hooks: [{ type: 'command', command: COMMAND, async: true, timeout: 5 }] },
        ],
      },
    };
    const plan = install(JSON.stringify(doubled));

    expect(plan).toMatchObject({ kind: 'write', added: WANTED.length, removed: 2 });
    expect(written(plan).hooks?.['Stop']).toHaveLength(1);
  });

  /** §41: Codex reports `matcher` and `enabled` on every entry and persists neither, so this converges. */
  it('rewrites an entry of ours that carries a key the board never writes', () => {
    const extra = { hooks: { Stop: [{ hooks: [{ type: 'command', command: COMMAND, async: true, timeout: 5, matcher: null }] }] } };
    const plan = install(JSON.stringify(extra));

    // One taken out and one put back for `Stop`, and the eleven events this file never had.
    expect(plan).toMatchObject({ kind: 'write', added: WANTED.length, removed: 1 });
    expect(JSON.stringify(written(plan).hooks?.['Stop'])).not.toContain('matcher');
  });

  it('leaves a hook of the developer that only mentions the writer alone', () => {
    // A substring test would take this one: it wraps the same writer with arguments of theirs, and is not ours.
    const theirs = { hooks: { Stop: [{ hooks: [{ type: 'command', command: `${COMMAND} --mine` }] }] } };
    const file = written(install(JSON.stringify(theirs)));

    expect(JSON.stringify(file.hooks?.['Stop'])).toContain('--mine');
    expect(file.hooks?.['Stop']).toHaveLength(2);
  });

  it('rewrites an entry of ours a hand edit changed', () => {
    const file = written(install(null));
    file.hooks!['Stop'] = [{ hooks: [{ type: 'command', command: COMMAND, async: true, timeout: 60 }] }];

    const plan = install(JSON.stringify(file));

    expect(plan).toMatchObject({ kind: 'write', added: 1, removed: 1 });
    expect(written(plan).hooks?.['Stop']?.[0]?.hooks[0]?.timeout).toBe(5);
  });

  it('keeps a hook the developer put in the same event', () => {
    const theirs = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }] } };
    const file = written(install(JSON.stringify(theirs)));

    expect(file.hooks?.['Stop']).toHaveLength(2);
    expect(JSON.stringify(file.hooks?.['Stop'])).toContain('notify-send done');
  });

  it('keeps every other key in the file, and its indentation and line endings', () => {
    const theirs = '{\r\n    "model": "gpt-6-astra",\r\n    "hooks": {}\r\n}\r\n';
    const plan = install(theirs);

    if (plan.kind !== 'write') {
      throw new Error('expected a write');
    }

    expect(plan.text).toContain('\r\n');
    expect(plan.text).toContain('\r\n    "model"');
    expect(plan.text.endsWith('\r\n')).toBe(true);
    expect(written(plan).model).toBe('gpt-6-astra');
  });

  it('keeps a byte-order mark, because Codex reads a file that has one', () => {
    const plan = install('﻿{}\n');

    if (plan.kind !== 'write') {
      throw new Error('expected a write');
    }

    expect(plan.text.startsWith('﻿')).toBe(true);
  });
});

describe('taking the Codex hook entries out', () => {
  it('removes only ours and leaves the developer their own', () => {
    const theirs = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }] } };
    const installed = JSON.stringify(written(install(JSON.stringify(theirs))));
    const plan = remove(installed);
    const file = written(plan);

    expect(plan).toMatchObject({ kind: 'write', added: 0 });
    expect(file.hooks?.['SessionStart']).toBeUndefined();
    expect(JSON.stringify(file.hooks?.['Stop'])).toContain('notify-send done');
  });

  it('drops the hooks key entirely when nothing the developer wrote is left in it', () => {
    const installed = JSON.stringify(written(install(null)));

    expect(written(remove(installed)).hooks).toBeUndefined();
  });

  it('has nothing to do on a file it never wrote to', () => {
    expect(remove('{"hooks":{}}')).toEqual({ kind: 'up-to-date' });
  });

  /** R30: an agent nobody enabled must not have a hooks file created for it by a removal. */
  it('creates nothing when there is no file at all', () => {
    expect(remove(null)).toEqual({ kind: 'up-to-date' });
  });

  it('keeps a hook of the developer that sits in the same group as ours', () => {
    const theirs = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: COMMAND, async: true, timeout: 5 }, { type: 'command', command: 'notify-send done' }] }] },
    };
    const file = written(remove(JSON.stringify(theirs)));

    expect(JSON.stringify(file.hooks?.['Stop'])).toContain('notify-send done');
    expect(JSON.stringify(file.hooks?.['Stop'])).not.toContain(WRITER);
  });
});

describe('what the plan refuses to touch', () => {
  it('refuses a file that is not JSON', () => {
    expect(install('{ not json')).toMatchObject({ kind: 'refuse' });
  });

  it('refuses a file that does not hold an object', () => {
    expect(install('[]')).toMatchObject({ kind: 'refuse' });
  });

  it('refuses a hooks key that is not an object', () => {
    expect(install('{"hooks": []}')).toMatchObject({ kind: 'refuse' });
  });

  it('refuses an event whose value is not a list', () => {
    expect(install('{"hooks": {"Stop": {}}}')).toMatchObject({ kind: 'refuse' });
  });

  it('leaves an event it would never write alone', () => {
    const plan = install('{"hooks": {"SomethingElse": {}}}');

    expect(plan.kind).toBe('write');
    expect(written(plan).hooks?.['SomethingElse']).toEqual({});
  });
});
