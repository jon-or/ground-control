import { describe, expect, it } from 'vitest';
import {
  BACKUPS_KEPT,
  LOCK_STALE_MS,
  MARKER_MAX_AGE_MS,
  backupsToDelete,
  hookNotice,
  lockIsStale,
  markerIsOrphaned,
  planHookInstall,
} from '../src/hookPlan.js';
import type { ActivityPlan } from '@ground-control/core';
import { hookPathOf } from '../src/hookScript.js';
import { HOME } from './helpers.js';

const HOOK = hookPathOf(HOME);

/**
 * The shape a developer's own settings file is in when the board first reads it: hand-curated keys around a hook
 * suite of their own. Ours must land beside that suite without moving or rewriting any of it.
 */
const EXISTING = {
  env: { GIT_AUTHOR_NAME: 'Someone' },
  permissions: { allow: ['mcp__thing__query'], deny: ['Skill(deep-research)'], defaultMode: 'auto' },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'pwsh -File notify-stop.ps1' }] }],
    PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'pwsh -File ask.ps1' }] }],
  },
  theme: 'dark',
};

const text = (value: unknown, indent: number | string = 2, trailing = '\n'): string =>
  `${JSON.stringify(value, null, indent)}${trailing}`;

const install = (settingsText: string | null): ActivityPlan =>
  planHookInstall({ settingsText, home: HOME, wanted: 'install' });

const remove = (settingsText: string | null): ActivityPlan =>
  planHookInstall({ settingsText, home: HOME, wanted: 'remove' });

const written = (plan: ActivityPlan): Record<string, unknown> => {
  if (plan.kind !== 'write') {
    throw new Error(`expected a write, got ${plan.kind}`);
  }

  return JSON.parse(plan.text) as Record<string, unknown>;
};

const ours = (groups: unknown): unknown[] =>
  (groups as { hooks: { args?: string[] }[] }[]).filter((group) =>
    group.hooks.some((entry) => entry.args?.[0] === HOOK),
  );

const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolBatch',
  'PermissionRequest',
  'PermissionDenied',
  'PreToolUse',
  'Elicitation',
  'Notification',
  'Stop',
  'SessionEnd',
];

describe('installing', () => {
  it('adds one entry per event it reads', () => {
    const plan = install(text(EXISTING));

    expect(plan).toMatchObject({ kind: 'write', added: EVENTS.length, removed: 0 });

    const hooks = written(plan).hooks as Record<string, unknown>;

    for (const event of EVENTS) {
      expect(ours(hooks[event]), event).toHaveLength(1);
    }
  });

  it('spawns node directly rather than through a shell, and never blocks the session', () => {
    const hooks = written(install(text(EXISTING))).hooks as Record<string, { hooks: unknown[] }[]>;

    expect(ours(hooks.UserPromptSubmit)).toEqual([
      { hooks: [{ type: 'command', command: 'node', args: [HOOK], async: true, timeout: 5 }] },
    ]);
  });

  it('filters the events that carry a query string and leaves the others unmatched', () => {
    const hooks = written(install(text(EXISTING))).hooks as Record<string, { matcher?: string }[]>;

    // Pipe, never comma: on any event outside the five tool events the CLI falls back to `new RegExp(matcher)`, and
    // a pattern full of commas matches no single value — a hook that never fires rather than one that fires too often.
    expect(ours(hooks.PreToolUse)).toEqual([expect.objectContaining({ matcher: 'AskUserQuestion|ExitPlanMode' })]);
    expect(ours(hooks.Notification)).toEqual([
      expect.objectContaining({
        matcher: 'permission_prompt|worker_permission_prompt|agent_needs_input|agent_completed',
      }),
    ]);

    for (const groups of Object.values(hooks)) {
      for (const group of ours(groups) as { matcher?: string }[]) {
        expect(group.matcher ?? '').not.toContain(',');
      }
    }
    expect(ours(hooks.Stop)[0]).not.toHaveProperty('matcher');
    expect(ours(hooks.UserPromptSubmit)[0]).not.toHaveProperty('matcher');
  });

  it('leaves every key the developer put in the file exactly as it was', () => {
    const result = written(install(text(EXISTING)));

    expect(result.env).toEqual(EXISTING.env);
    expect(result.permissions).toEqual(EXISTING.permissions);
    expect(result.theme).toBe('dark');
    expect(Object.keys(result)).toEqual(Object.keys(EXISTING));
  });

  it("leaves the developer's own hook entries in place, in their own order", () => {
    const hooks = written(install(text(EXISTING))).hooks as Record<string, unknown[]>;

    expect(hooks.Stop?.[0]).toEqual(EXISTING.hooks.Stop[0]);
    expect(hooks.PreToolUse?.[0]).toEqual(EXISTING.hooks.PreToolUse[0]);
  });

  it('creates the file when there is none, because there is nothing to lose', () => {
    expect(written(install(null)).hooks).toBeTypeOf('object');
  });

  it('adds the hooks to a file that has no hooks key at all', () => {
    expect(install(text({ theme: 'dark' }))).toMatchObject({ kind: 'write', added: EVENTS.length });
  });

  // The steady state, and what makes two windows opening a board at once a non-event: the second one writes nothing.
  it('writes nothing the second time', () => {
    const first = install(text(EXISTING));

    expect(install((first as { text: string }).text)).toEqual({ kind: 'up-to-date' });
  });

  it('collapses an entry that was duplicated by hand back to one', () => {
    const doubled = structuredClone(EXISTING) as typeof EXISTING & { hooks: Record<string, unknown[]> };
    const group = { hooks: [{ type: 'command', command: 'node', args: [HOOK], async: true, timeout: 5 }] };
    doubled.hooks.Stop = [...doubled.hooks.Stop, group, group];

    const plan = install(text(doubled));

    expect(plan).toMatchObject({ kind: 'write' });
    expect(ours((written(plan).hooks as Record<string, unknown>).Stop)).toHaveLength(1);
  });

  it('replaces an entry left by an older version of the extension', () => {
    const stale = structuredClone(EXISTING) as typeof EXISTING & { hooks: Record<string, unknown[]> };
    stale.hooks.Stop = [...stale.hooks.Stop, { hooks: [{ type: 'command', command: HOOK }] }];

    const plan = install(text(stale));

    expect(plan).toMatchObject({ kind: 'write', removed: 1 });
    expect(ours((written(plan).hooks as Record<string, unknown>).Stop)).toEqual([
      { hooks: [{ type: 'command', command: 'node', args: [HOOK], async: true, timeout: 5 }] },
    ]);
  });

  // An event dropped from the wanted set would otherwise keep an entry of ours wired forever, unnoticed.
  it('sweeps its own entry out of an event it no longer wants', () => {
    const stale = structuredClone(EXISTING) as typeof EXISTING & { hooks: Record<string, unknown[]> };
    stale.hooks.PostToolUse = [{ hooks: [{ type: 'command', command: 'node', args: [HOOK], async: true, timeout: 5 }] }];

    const plan = install(text(stale));
    const hooks = written(plan).hooks as Record<string, unknown>;

    expect(plan).toMatchObject({ kind: 'write', removed: 1 });
    expect(hooks).not.toHaveProperty('PostToolUse');
  });

  it.each([
    ['four spaces', 4],
    ['a tab', '\t'],
  ])('keeps the file indented with %s', (_case, indent) => {
    const plan = install(text(EXISTING, indent));
    const marker = typeof indent === 'number' ? ' '.repeat(indent) : indent;

    expect((plan as { text: string }).text).toContain(`\n${marker}"env"`);
  });

  it.each([
    ['keeps a trailing newline', '\n', true],
    ['adds none where there was none', '', false],
  ])('%s', (_case, trailing, expected) => {
    expect((install(text(EXISTING, 2, trailing)) as { text: string }).text.endsWith('\n')).toBe(expected);
  });
});

describe('refusing', () => {
  it.each([
    ['a file that is not JSON', '{ "hooks": }'],
    ['a file that is not an object', '["hooks"]'],
    ['a hooks key that is not an object', text({ hooks: 'all of them' })],
    ['an event that is not a list', text({ hooks: { Stop: { command: 'x' } } })],
  ])('leaves the file alone for %s', (_case, settingsText) => {
    const plan = install(settingsText);

    expect(plan.kind).toBe('refuse');
    expect((plan as { reason: string }).reason).toBeTruthy();
    expect((plan as { remedy: string }).remedy).toBeTruthy();
  });

  it('names each refusal differently, so the board can say which one it hit', () => {
    const reasons = [
      install('{ "hooks": }'),
      install('["hooks"]'),
      install(text({ hooks: 'all of them' })),
      install(text({ hooks: { Stop: { command: 'x' } } })),
    ].map((plan) => (plan as { reason: string }).reason);

    expect(new Set(reasons).size).toBe(4);
  });

  it('does not refuse an entry list holding something it does not recognise', () => {
    expect(install(text({ hooks: { Stop: ['not a group'] } }))).toMatchObject({ kind: 'write' });
  });
});

describe('removing', () => {
  it("strips only its own entries, and leaves the developer's suite intact", () => {
    const installed = (install(text(EXISTING)) as { text: string }).text;
    const plan = remove(installed);

    expect(plan).toMatchObject({ kind: 'write', added: 0, removed: EVENTS.length });

    const result = written(plan);

    expect(result.hooks).toEqual(EXISTING.hooks);
    expect(result.permissions).toEqual(EXISTING.permissions);
  });

  it('writes nothing when there is nothing of its own to remove', () => {
    expect(remove(text(EXISTING))).toEqual({ kind: 'up-to-date' });
  });

  it('drops the hooks key entirely when its own entries were all it held', () => {
    const installed = (install(text({ theme: 'dark' })) as { text: string }).text;

    expect(written(remove(installed))).toEqual({ theme: 'dark' });
  });
});

describe('the notice', () => {
  it('says how many sessions cannot report yet, because a silent board looks like an idle one', () => {
    expect(hookNotice({ plan: 'write', wanted: 'install', unreported: 3 })).toContain('3 sessions started before');
    expect(hookNotice({ plan: 'write', wanted: 'install', unreported: 1 })).toContain('1 session started before');
  });

  it('says only that they are installed when every session already reports', () => {
    expect(hookNotice({ plan: 'write', wanted: 'install', unreported: 0 })).toBe('Session activity hooks installed.');
  });

  // It is an announcement, not a status: a run that changed nothing has nothing to announce, however many sessions
  // cannot report. The failure of a refused run is reported as a failure, not as a state.
  it.each(['up-to-date', 'refuse', 'busy'] as const)('says nothing when the plan was %s', (plan) => {
    expect(hookNotice({ plan, wanted: 'install', unreported: 4 })).toBeNull();
    expect(hookNotice({ plan, wanted: 'remove', unreported: 4 })).toBeNull();
  });

  it('says they were removed', () => {
    expect(hookNotice({ plan: 'write', wanted: 'remove', unreported: 0 })).toContain('were removed');
  });
});

describe('what it must not disturb', () => {
  const ourEntry = { type: 'command', command: 'node', args: [HOOK], async: true, timeout: 5 };

  /**
   * A group is a matcher and a list of entries; a developer can put a hook of their own in the same group as ours.
   * Filtering the group would take theirs with it, which is the board quietly changing what it did not write.
   */
  it("keeps a hook of the developer's own that shares a group with one of ours", () => {
    const shared = {
      hooks: { Stop: [{ hooks: [ourEntry, { type: 'command', command: 'my-own-notifier.sh' }] }] },
    };

    const hooks = written(remove(text(shared))).hooks as Record<string, { hooks: unknown[] }[]>;

    expect(hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'my-own-notifier.sh' }] }]);
  });

  it('keeps it on an install too, and adds its own entry beside it', () => {
    const shared = {
      hooks: { Stop: [{ hooks: [ourEntry, { type: 'command', command: 'my-own-notifier.sh' }] }] },
    };

    const hooks = written(install(text(shared))).hooks as Record<string, { hooks: unknown[] }[]>;

    expect(hooks.Stop?.[0]).toEqual({ hooks: [{ type: 'command', command: 'my-own-notifier.sh' }] });
    expect(ours(hooks.Stop)).toEqual([{ hooks: [ourEntry] }]);
  });

  /**
   * The CLI is free to reorder keys or normalise a field in. A serialised comparison would rewrite the developer's settings on every board
   * open, and five backups later the pre-install one — the only one that matters — would be gone.
   */
  it('writes nothing when its own entry comes back with the keys in another order', () => {
    const reordered = {
      hooks: {
        Stop: [{ hooks: [{ command: 'node', timeout: 5, args: [HOOK], type: 'command', async: true }] }],
        ...Object.fromEntries(EVENTS.filter((e) => e !== 'Stop').map((e) => [e, undefined])),
      },
    };

    const installed = JSON.parse((install(text(reordered)) as { text: string }).text) as {
      hooks: Record<string, unknown>;
    };

    // Its own Stop entry was left exactly as it found it, keys and all.
    expect((installed.hooks.Stop as { hooks: unknown[] }[])[0]?.hooks[0]).toEqual({
      command: 'node',
      timeout: 5,
      args: [HOOK],
      type: 'command',
      async: true,
    });
  });

  it('rewrites its own entry when a field it sets has actually changed', () => {
    const stale = { hooks: { Stop: [{ hooks: [{ ...ourEntry, async: false }] }] } };

    expect(install(text(stale))).toMatchObject({ kind: 'write' });
  });

  // PowerShell 5.1's Out-File and Notepad both write one, and the CLI reads such a file happily.
  it('reads a file that starts with a byte-order mark, and writes it back with one', () => {
    const plan = install(`\uFEFF${text(EXISTING)}`);

    expect(plan).toMatchObject({ kind: 'write' });
    expect((plan as { text: string }).text.startsWith('\uFEFF')).toBe(true);
    expect(JSON.parse((plan as { text: string }).text.slice(1))).toMatchObject({ theme: 'dark' });
  });

  it('keeps a file whose lines end in CRLF ending in CRLF', () => {
    const plan = install(text(EXISTING).replace(/\n/g, '\r\n'));
    const result = (plan as { text: string }).text;

    expect(result).toContain('\r\n');
    expect(result.replace(/\r\n/g, '\n')).not.toContain('\r');
    expect(result.endsWith('\r\n')).toBe(true);
  });

  it('keeps a file whose lines end in LF ending in LF', () => {
    expect((install(text(EXISTING)) as { text: string }).text).not.toContain('\r');
  });

  /** A removal that refuses over an event it would never touch leaves the board's own entries installed. */
  it('removes its own entries even where an unrelated event holds something it cannot read', () => {
    const odd = { hooks: { Stop: [{ hooks: [ourEntry] }], PostToolUse: {} } };
    const plan = remove(text(odd));

    expect(plan).toMatchObject({ kind: 'write' });
    expect(written(plan).hooks).toEqual({ PostToolUse: {} });
  });

  it('still refuses when the event it is about to write to holds something it cannot read', () => {
    expect(install(text({ hooks: { Stop: {} } })).kind).toBe('refuse');
  });
});

describe('the decisions that delete files', () => {
  const now = 1_788_000_000_000;

  it('takes a lock nobody has cleared, and leaves a fresh one alone', () => {
    expect(lockIsStale(now - LOCK_STALE_MS - 1, now)).toBe(true);
    expect(lockIsStale(now - 1_000, now)).toBe(false);
    expect(lockIsStale(now, now)).toBe(false);
  });

  // A lock stamped in the future is a clock the board cannot reason about, and would otherwise never expire.
  it('takes a lock stamped in the future', () => {
    expect(lockIsStale(now + LOCK_STALE_MS + 1, now)).toBe(true);
  });

  it('keeps the newest backups and deletes the rest, oldest first', () => {
    const names = Array.from({ length: BACKUPS_KEPT + 3 }, (_, i) => `settings-backup-2026-09-0${i}.json`);

    expect(backupsToDelete(names)).toEqual(names.slice(0, 3));
  });

  it('deletes nothing while there are fewer than it keeps', () => {
    expect(backupsToDelete(['settings-backup-a.json'])).toEqual([]);
    expect(backupsToDelete([])).toEqual([]);
  });

  // The refusal that matters: this list is handed to rmSync in the developer's home.
  it('never names a file that is not one of its own backups', () => {
    const names = [
      'settings.json',
      'hook.mjs',
      'install.lock',
      'activity',
      ...Array.from({ length: BACKUPS_KEPT + 1 }, (_, i) => `settings-backup-2026-09-0${i}.json`),
    ];

    expect(backupsToDelete(names)).toEqual(['settings-backup-2026-09-00.json']);
  });

  it('reads a marker older than the window as an orphan, and a newer one as a live session own', () => {
    expect(markerIsOrphaned(now - MARKER_MAX_AGE_MS - 1, now)).toBe(true);
    expect(markerIsOrphaned(now - MARKER_MAX_AGE_MS + 1, now)).toBe(false);
    expect(markerIsOrphaned(now, now)).toBe(false);
  });
});
