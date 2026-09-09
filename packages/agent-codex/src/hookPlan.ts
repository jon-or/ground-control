import type { ActivityPlan, ActivityPlanInput } from '@ground-control/core';
import { hookPathOf } from './hookScript.js';

/** Codex accepts one command string, so quote the writer path. Async hooks do not block the session. */
interface HookEntry {
  type: 'command';
  command: string;
  async: true;
  timeout: number;
}

interface HookGroup {
  hooks: HookEntry[];
}

/** Use the three-second limit for SessionEnd and Interrupt to avoid Codex timeout-clamping errors (M41). */
const CLAMPED_EVENTS = new Set(['SessionEnd', 'Interrupt']);
const TIMEOUT_SECONDS = 5;
const CLAMPED_TIMEOUT_SECONDS = 3;

/**
 * Use Codex PascalCase events without matchers. Matcher semantics are unverified and could suppress activity;
 * phaseOf handles all payload values.
 */
const HOOK_EVENTS: readonly string[] = [
  // Discover sessions on SessionStart without assigning an activity phase.
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Stop',
  'Interrupt',
  // Removes the marker, which is how a session leaves the board.
  'SessionEnd',
];

const HOOKS_PATH = '~/.codex/hooks.json';

function refuse(reason: string, remedy: string): ActivityPlan {
  return { kind: 'refuse', reason, remedy };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Preserve existing indentation; default to two spaces. */
function indentOf(text: string): string | number {
  const found = /\n([ \t]+)"/.exec(text)?.[1];

  if (!found) {
    return 2;
  }

  return found.startsWith('\t') ? '\t' : found.length;
}

function commandFor(hookPath: string): string {
  return `node "${hookPath}"`;
}

/**
 * Match the exact board command to preserve user wrappers with extra arguments. Codex leaves hooks.json
 * unchanged (M41).
 */
function isOurEntry(entry: unknown, hookPath: string): boolean {
  return isRecord(entry) && entry.command === commandFor(hookPath);
}

/**
 * Remove board entries individually, preserving user hooks in the same group. Return null when no board entry
 * exists.
 */
function withoutOurs(group: unknown, hookPath: string): { kept: unknown; removed: number } | null {
  if (!isRecord(group) || !Array.isArray(group.hooks)) {
    return null;
  }

  const kept = group.hooks.filter((entry) => !isOurEntry(entry, hookPath));
  const removed = group.hooks.length - kept.length;

  if (removed === 0) {
    return null;
  }

  return { kept: kept.length === 0 ? null : { ...group, hooks: kept }, removed };
}

function hasOurEntry(group: unknown, hookPath: string): boolean {
  return isRecord(group) && Array.isArray(group.hooks) && group.hooks.some((entry) => isOurEntry(entry, hookPath));
}

function groupFor(event: string, hookPath: string): HookGroup {
  return {
    hooks: [
      {
        type: 'command',
        command: commandFor(hookPath),
        async: true,
        timeout: CLAMPED_EVENTS.has(event) ? CLAMPED_TIMEOUT_SECONDS : TIMEOUT_SECONDS,
      },
    ],
  };
}

/** Allowed keys for installed board groups and entries. */
const GROUP_KEYS = new Set(['hooks']);
const ENTRY_KEYS = new Set(['type', 'command', 'async', 'timeout']);

function keysAre(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

/**
 * Compare installed fields and reject extra keys that can affect execution. Codex reports enabled and matcher
 * but persists neither, so repeat installation makes no changes (M41).
 */
function matchesGroup(group: unknown, wanted: HookGroup): boolean {
  if (!isRecord(group) || !Array.isArray(group.hooks)) {
    return false;
  }

  const entry = group.hooks[0];
  const expected = wanted.hooks[0]!;

  return (
    keysAre(group, GROUP_KEYS) &&
    group.hooks.length === 1 &&
    isRecord(entry) &&
    keysAre(entry, ENTRY_KEYS) &&
    entry.type === expected.type &&
    entry.command === expected.command &&
    entry.async === expected.async &&
    entry.timeout === expected.timeout
  );
}

/**
 * Plan edits to shared hooks.json, preserving unrelated entries and refusing unsupported structure. Installed
 * entries require trust; the adapter requests it through Codex's app-server exchange (mechanics M41).
 */
export function planHookInstall({ settingsText, home, wanted }: ActivityPlanInput): ActivityPlan {
  const hookPath = hookPathOf(home);

  // Create missing files as empty objects; reject malformed existing files below.
  const text = settingsText ?? '{}\n';

  // Strip and preserve the BOM accepted by the CLI but rejected by JSON.parse. PowerShell 5.1 and Notepad can
  // write it.
  const body = text.replace(/^﻿/, '');
  const bom = text.length === body.length ? '' : '﻿';

  let root: unknown;

  try {
    root = JSON.parse(body);
  } catch (error) {
    return refuse(
      `${HOOKS_PATH} contains invalid JSON. File unchanged: ${(error as Error).message}`,
      `Fix ${HOOKS_PATH}, then reopen the board. Activity reporting may be unavailable.`,
    );
  }

  if (!isRecord(root)) {
    return refuse(
      `${HOOKS_PATH} must contain a JSON object. File unchanged.`,
      `Fix ${HOOKS_PATH}, then reopen the board.`,
    );
  }

  if (root.hooks !== undefined && !isRecord(root.hooks)) {
    return refuse(
      `The "hooks" key in ${HOOKS_PATH} must be an object. File unchanged.`,
      `Fix or remove "hooks" in ${HOOKS_PATH}, then reopen the board.`,
    );
  }

  const hooks: Record<string, unknown> = isRecord(root.hooks) ? { ...root.hooks } : {};

  // Inspect desired and existing events to remove obsolete board hooks. Uninstall inspects existing events
  // only.
  const events = [...new Set([...(wanted === 'install' ? HOOK_EVENTS : []), ...Object.keys(hooks)])];

  let added = 0;
  let removed = 0;

  for (const event of events) {
    const existing = hooks[event];
    const wants = wanted === 'install' && HOOK_EVENTS.includes(event);

    if (existing !== undefined && !Array.isArray(existing)) {
      // Validate only events being changed; unrelated malformed events must not block hook removal.
      if (!wants && !hasOurEntry(existing, hookPath)) {
        continue;
      }

      return refuse(
        `"hooks.${event}" in ${HOOKS_PATH} must be a list. File unchanged.`,
        `Fix "hooks.${event}" in ${HOOKS_PATH}, then reopen the board.`,
      );
    }

    const current = Array.isArray(existing) ? existing : [];
    const group = wants ? groupFor(event, hookPath) : null;

    // Skip writes when exactly one matching board group is already installed.
    if (group && current.filter((held) => hasOurEntry(held, hookPath)).length === 1) {
      if (current.some((held) => matchesGroup(held, group))) {
        continue;
      }
    }

    const kept: unknown[] = [];

    for (const held of current) {
      const stripped = withoutOurs(held, hookPath);

      if (stripped === null) {
        kept.push(held);
        continue;
      }

      removed += stripped.removed;

      if (stripped.kept !== null) {
        kept.push(stripped.kept);
      }
    }

    if (group) {
      kept.push(group);
      added += 1;
    }

    if (kept.length === 0) {
      delete hooks[event];
      continue;
    }

    hooks[event] = kept;
  }

  if (added === 0 && removed === 0) {
    return { kind: 'up-to-date' };
  }

  // Preserve existing object key order.
  if (Object.keys(hooks).length === 0) {
    delete root.hooks;
  } else {
    root.hooks = hooks;
  }

  const crlf = body.includes('\r\n');
  const trailing = body.endsWith('\n') ? (crlf ? '\r\n' : '\n') : '';
  const serialised = JSON.stringify(root, null, indentOf(body));
  const written = `${crlf ? serialised.replace(/\n/g, '\r\n') : serialised}${trailing}`;

  return { kind: 'write', text: `${bom}${written}`, added, removed };
}
