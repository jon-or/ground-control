import type { ActivityPlan, ActivityPlanInput } from '@ground-control/core';
import { hookPathOf } from './hookScript.js';

/**
 * Run node with an args array to avoid a shell and Windows path parsing. Async hooks do not block the session
 * (R12).
 */
interface HookEntry {
  type: 'command';
  command: string;
  args: string[];
  async: true;
  timeout: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

/**
 * Use regex alternation for all matchers. Commas separate values only for tool events; other events parse them
 * literally.
 */
const ALTERNATION = '|';

/**
 * Install events with optional spawn filters. phaseOf handles payload values independently. Stop,
 * PostToolBatch, and UserPromptSubmit ignore matchers.
 */
const HOOK_EVENTS: readonly (readonly [event: string, alternatives: string[] | null])[] = [
  // Refresh discovery on SessionStart before the next poll. Leave it unfiltered because source matcher
  // semantics are unverified.
  ['SessionStart', null],
  ['UserPromptSubmit', null],
  ['PostToolBatch', null],
  ['PermissionRequest', null],
  ['PermissionDenied', null],
  ['PreToolUse', ['AskUserQuestion', 'ExitPlanMode']],
  ['Elicitation', null],
  // agent_completed reports another job finishing to the session watching it, not this session's turn (M20).
  ['Notification', ['permission_prompt', 'worker_permission_prompt', 'agent_needs_input']],
  ['Stop', null],
  // Replaces Stop when the turn ends on an API error (M55).
  ['StopFailure', null],
  ['SessionEnd', null],
];

const SETTINGS_PATH = '~/.claude/settings.json';

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

/**
 * Identify board entries by writer path; Claude strips undeclared marker fields on rewrite, which would cause
 * duplicate installs.
 */
function isOurEntry(entry: unknown, hookPath: string): boolean {
  if (!isRecord(entry)) {
    return false;
  }

  const arg = Array.isArray(entry.args) ? entry.args[0] : undefined;

  return arg === hookPath || entry.command === hookPath;
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

/** Check for board entries, including malformed non-array event values. */
function hasOurEntry(group: unknown, hookPath: string): boolean {
  return isRecord(group) && Array.isArray(group.hooks) && group.hooks.some((entry) => isOurEntry(entry, hookPath));
}

function groupFor(alternatives: string[] | null, hookPath: string): HookGroup {
  const entry: HookEntry = { type: 'command', command: 'node', args: [hookPath], async: true, timeout: 5 };

  return alternatives === null ? { hooks: [entry] } : { matcher: alternatives.join(ALTERNATION), hooks: [entry] };
}

/** Allowed keys for installed board groups and entries. */
const GROUP_KEYS = new Set(['matcher', 'hooks']);
const ENTRY_KEYS = new Set(['type', 'command', 'args', 'async', 'timeout']);

function keysAre(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

/**
 * Compare fields without relying on JSON key order. Reject extra keys because timeout, once, and if can disable
 * hooks.
 */
function matchesGroup(group: unknown, wanted: HookGroup): boolean {
  if (!isRecord(group) || group.matcher !== wanted.matcher || !Array.isArray(group.hooks)) {
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
    entry.timeout === expected.timeout &&
    Array.isArray(entry.args) &&
    entry.args.length === 1 &&
    entry.args[0] === expected.args[0]
  );
}

/** Plan edits to shared Claude settings, preserving unrelated entries and refusing unsupported structure. */
export function planHookInstall({ settingsText, home, wanted }: ActivityPlanInput): ActivityPlan {
  const hookPath = hookPathOf(home);

  // Create missing files as empty objects; reject malformed existing files below.
  const text = settingsText ?? '{}\n';

  // Strip and preserve the BOM accepted by the CLI but rejected by JSON.parse. PowerShell 5.1 and Notepad can
  // write it.
  const body = text.replace(/^\uFEFF/, '');
  const bom = text.length === body.length ? '' : '\uFEFF';

  let root: unknown;

  try {
    root = JSON.parse(body);
  } catch (error) {
    return refuse(
      `${SETTINGS_PATH} contains invalid JSON. File unchanged: ${(error as Error).message}`,
      `Fix ${SETTINGS_PATH}, then reopen the board. Activity reporting may be unavailable.`,
    );
  }

  if (!isRecord(root)) {
    return refuse(
      `${SETTINGS_PATH} must contain a JSON object. File unchanged.`,
      `Fix ${SETTINGS_PATH}, then reopen the board.`,
    );
  }

  if (root.hooks !== undefined && !isRecord(root.hooks)) {
    return refuse(
      `The "hooks" key in ${SETTINGS_PATH} must be an object. File unchanged.`,
      `Fix or remove "hooks" in ${SETTINGS_PATH}, then reopen the board.`,
    );
  }

  const hooks: Record<string, unknown> = isRecord(root.hooks) ? { ...root.hooks } : {};

  // Inspect desired and existing events to remove obsolete board hooks. Uninstall inspects existing events
  // only.
  const events = [...new Set([...(wanted === 'install' ? HOOK_EVENTS.map(([event]) => event) : []), ...Object.keys(hooks)])];

  let added = 0;
  let removed = 0;

  for (const event of events) {
    const existing = hooks[event];
    const eventSpec = HOOK_EVENTS.find(([name]) => name === event);
    const wants = wanted === 'install' && eventSpec !== undefined;

    if (existing !== undefined && !Array.isArray(existing)) {
      // Validate only events being changed; unrelated malformed events must not block hook removal.
      if (!wants && !hasOurEntry(existing, hookPath)) {
        continue;
      }

      return refuse(
        `"hooks.${event}" in ${SETTINGS_PATH} must be a list. File unchanged.`,
        `Fix "hooks.${event}" in ${SETTINGS_PATH}, then reopen the board.`,
      );
    }

    const current = Array.isArray(existing) ? existing : [];
    const group = wants ? groupFor(eventSpec![1], hookPath) : null;

    // Skip writes when exactly one matching board group is already installed.
    if (group && current.filter((c) => hasOurEntry(c, hookPath)).length === 1) {
      if (current.some((c) => matchesGroup(c, group))) {
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

  // Preserve line endings and the trailing newline to avoid unrelated diffs.
  const crlf = body.includes('\r\n');
  const trailing = body.endsWith('\n') ? (crlf ? '\r\n' : '\n') : '';
  const serialised = JSON.stringify(root, null, indentOf(body));
  const written = `${crlf ? serialised.replace(/\n/g, '\r\n') : serialised}${trailing}`;

  return { kind: 'write', text: `${bom}${written}`, added, removed };
}

/**
 * Treat install locks older than this limit as stale; installation normally needs only a read, comparison, and
 * rename.
 */
export const LOCK_STALE_MS = 60_000;

/** Expire old or far-future lock timestamps to recover from crashes and clock changes. */
export function lockIsStale(mtimeMs: number, now: number): boolean {
  return now - mtimeMs > LOCK_STALE_MS || mtimeMs > now + LOCK_STALE_MS;
}

/** Maximum retained settings backups. */
export const BACKUPS_KEPT = 5;

/**
 * Select old settings backups for deletion, preserving the newest BACKUPS_KEPT files. Timestamped names sort
 * chronologically.
 */
export function backupsToDelete(names: readonly string[]): string[] {
  const ours = names.filter((name) => /^settings-backup-.+\.json$/.test(name)).sort();

  return ours.slice(0, Math.max(0, ours.length - BACKUPS_KEPT));
}

/** Retention limit for markers left without SessionEnd. */
export const MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Check whether a marker exceeds the retention limit. */
export function markerIsOrphaned(mtimeMs: number, now: number): boolean {
  return now - mtimeMs > MARKER_MAX_AGE_MS;
}
