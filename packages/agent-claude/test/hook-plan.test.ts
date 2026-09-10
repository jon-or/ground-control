import { describe, expect, it } from 'vitest';
import {
  BACKUPS_KEPT,
  LOCK_STALE_MS,
  MARKER_MAX_AGE_MS,
  backupsToDelete,
  lockIsStale,
  markerIsOrphaned,
  planHookInstall,
} from '../src/hookPlan.js';
import type { ActivityPlan } from '@ground-control/core';
import { hookPathOf } from '../src/hookScript.js';
import { HOME } from './helpers.js';

const HOOK = hookPathOf(HOME);

/** Existing user settings and hooks that installation must preserve. */
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

    // Use pipe alternation; non-tool event matchers parse commas literally.
    expect(ours(hooks.PreToolUse)).toEqual([expect.objectContaining({ matcher: 'AskUserQuestion|ExitPlanMode' })]);
    expect(ours(hooks.Notification)).toEqual([
      expect.objectContaining({
        matcher: 'permission_prompt|worker_permission_prompt|agent_needs_input',
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

  // Repeated installation must not rewrite unchanged settings.
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

  // Remove installed hooks for events no longer requested.
  it('removes board hooks from obsolete events', () => {
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

  it('distinguishes configuration refusal reasons', () => {
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

  it('skips writes when no board hooks exist', () => {
    expect(remove(text(EXISTING))).toEqual({ kind: 'up-to-date' });
  });

  it('removes the hooks key after removing all entries', () => {
    const installed = (install(text({ theme: 'dark' })) as { text: string }).text;

    expect(written(remove(installed))).toEqual({ theme: 'dark' });
  });
});

describe('what it must not disturb', () => {
  const ourEntry = { type: 'command', command: 'node', args: [HOOK], async: true, timeout: 5 };

  /** Remove board entries individually to preserve user hooks in the same group. */
  it("keeps a hook of the developer's own that shares a group with one of ours", () => {
    const shared = {
      hooks: { Stop: [{ hooks: [ourEntry, { type: 'command', command: 'my-own-notifier.sh' }] }] },
    };

    const hooks = written(remove(text(shared))).hooks as Record<string, { hooks: unknown[] }[]>;

    expect(hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'my-own-notifier.sh' }] }]);
  });

  it('preserves user hooks while installing board entries', () => {
    const shared = {
      hooks: { Stop: [{ hooks: [ourEntry, { type: 'command', command: 'my-own-notifier.sh' }] }] },
    };

    const hooks = written(install(text(shared))).hooks as Record<string, { hooks: unknown[] }[]>;

    expect(hooks.Stop?.[0]).toEqual({ hooks: [{ type: 'command', command: 'my-own-notifier.sh' }] });
    expect(ours(hooks.Stop)).toEqual([{ hooks: [ourEntry] }]);
  });

  /**
   * Ignore JSON key order during comparison to avoid repeated rewrites that would expire useful pre-install
   * backups.
   */
  it('ignores key order when comparing installed hooks', () => {
    const reordered = {
      hooks: {
        Stop: [{ hooks: [{ command: 'node', timeout: 5, args: [HOOK], type: 'command', async: true }] }],
        ...Object.fromEntries(EVENTS.filter((e) => e !== 'Stop').map((e) => [e, undefined])),
      },
    };

    const installed = JSON.parse((install(text(reordered)) as { text: string }).text) as {
      hooks: Record<string, unknown>;
    };

    // Preserve the existing Stop entry, including key order.
    expect((installed.hooks.Stop as { hooks: unknown[] }[])[0]?.hooks[0]).toEqual({
      command: 'node',
      timeout: 5,
      args: [HOOK],
      type: 'command',
      async: true,
    });
  });

  it('rewrites board entries with changed fields', () => {
    const stale = { hooks: { Stop: [{ hooks: [{ ...ourEntry, async: false }] }] } };

    expect(install(text(stale))).toMatchObject({ kind: 'write' });
  });

  // Existing installs carry the earlier matcher that included agent_completed.
  it('replaces a board group whose matcher has changed', () => {
    const matcher = 'permission_prompt|worker_permission_prompt|agent_needs_input|agent_completed';
    const stale = { hooks: { Notification: [{ matcher, hooks: [ourEntry] }] } };
    const plan = install(text(stale));

    expect(plan).toMatchObject({ kind: 'write', removed: 1 });
    expect(ours((written(plan).hooks as Record<string, unknown>).Notification)).toEqual([
      { matcher: 'permission_prompt|worker_permission_prompt|agent_needs_input', hooks: [ourEntry] },
    ]);
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

  /** Unrelated malformed events must not block removal of board hooks. */
  it('removes board hooks despite unrelated malformed events', () => {
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

  it('expires stale locks and preserves fresh locks', () => {
    expect(lockIsStale(now - LOCK_STALE_MS - 1, now)).toBe(true);
    expect(lockIsStale(now - 1_000, now)).toBe(false);
    expect(lockIsStale(now, now)).toBe(false);
  });

  // Far-future lock timestamps must expire after clock changes.
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

  // Only selected backup files may reach rmSync.
  it('selects only settings backups for deletion', () => {
    const names = [
      'settings.json',
      'hook.mjs',
      'install.lock',
      'activity',
      ...Array.from({ length: BACKUPS_KEPT + 1 }, (_, i) => `settings-backup-2026-09-0${i}.json`),
    ];

    expect(backupsToDelete(names)).toEqual(['settings-backup-2026-09-00.json']);
  });

  it('expires markers beyond the retention limit', () => {
    expect(markerIsOrphaned(now - MARKER_MAX_AGE_MS - 1, now)).toBe(true);
    expect(markerIsOrphaned(now - MARKER_MAX_AGE_MS + 1, now)).toBe(false);
    expect(markerIsOrphaned(now, now)).toBe(false);
  });
});
