import type { ActivityPlan, ActivityPlanInput } from '@ground-control/core';
import { hookPathOf } from './hookScript.js';

/**
 * One hook entry the board installs. `args` spawns `node` with no shell — without it Windows starts PowerShell per event and parses the path.
 * `async` keeps the session from waiting on the writer at all, which is what makes R12 literally true rather than nearly.
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
 * Always pipe-separated. Comma is a list separator only on the five tool events; elsewhere the CLI falls through to `new RegExp(matcher)`,
 * and a pattern full of commas matches nothing — so a comma there is a hook that never fires: a missing phase, not a wasted spawn.
 */
const ALTERNATION = '|';

/**
 * The events the board installs and the matcher each is filtered by. A matcher only stops a spawn; `phaseOf` handles every value regardless.
 * `Stop`, `PostToolBatch` and `UserPromptSubmit` carry no query string, so a matcher on them would be ignored and none is written.
 */
const WANTED: readonly (readonly [event: string, alternatives: string[] | null])[] = [
  // Installed for the roster, not for a phase: a new session reaches the board on the event instead of the next poll. Unfiltered, because a
  // `startup` matcher is a regex against `source` whose semantics are unconfirmed, and a matcher that misses is a hook that never fires.
  ['SessionStart', null],
  ['UserPromptSubmit', null],
  ['PostToolBatch', null],
  ['PermissionRequest', null],
  ['PermissionDenied', null],
  ['PreToolUse', ['AskUserQuestion', 'ExitPlanMode']],
  ['Elicitation', null],
  ['Notification', ['permission_prompt', 'worker_permission_prompt', 'agent_needs_input', 'agent_completed']],
  ['Stop', null],
  ['SessionEnd', null],
];

const SETTINGS_PATH = '~/.claude/settings.json';

function refuse(reason: string, remedy: string): ActivityPlan {
  return { kind: 'refuse', reason, remedy };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Two spaces unless the file says otherwise: a re-indented settings file is a diff the developer did not ask for. */
function indentOf(text: string): string | number {
  const found = /\n([ \t]+)"/.exec(text)?.[1];

  if (!found) {
    return 2;
  }

  return found.startsWith('\t') ? '\t' : found.length;
}

/**
 * Ours by the hook's own path. A marker key of our own would not survive: entries go through a schema that strips
 * what it does not declare, so the key would vanish on the CLI's first rewrite and every install would duplicate.
 */
function isOurEntry(entry: unknown, hookPath: string): boolean {
  if (!isRecord(entry)) {
    return false;
  }

  const arg = Array.isArray(entry.args) ? entry.args[0] : undefined;

  return arg === hookPath || entry.command === hookPath;
}

/**
 * A group with our entries taken out, or null when nothing of ours was in it. Entry by entry, never the whole group: a developer who put a
 * hook of their own beside ours would otherwise lose it to an install, and the board must not change what it did not write.
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

/** Whether anything of ours is in this group, or in this non-array value the developer put under an event. */
function hasOurEntry(group: unknown, hookPath: string): boolean {
  return isRecord(group) && Array.isArray(group.hooks) && group.hooks.some((entry) => isOurEntry(entry, hookPath));
}

function groupFor(alternatives: string[] | null, hookPath: string): HookGroup {
  const entry: HookEntry = { type: 'command', command: 'node', args: [hookPath], async: true, timeout: 5 };

  return alternatives === null ? { hooks: [entry] } : { matcher: alternatives.join(ALTERNATION), hooks: [entry] };
}

/** The keys a group and an entry of ours are allowed to carry. Anything else is a hand edit, not what we wrote. */
const GROUP_KEYS = new Set(['matcher', 'hooks']);
const ENTRY_KEYS = new Set(['type', 'command', 'args', 'async', 'timeout']);

function keysAre(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

/**
 * Whether a group already says exactly what the board would write. Field by field, not by serialised text: the CLI may reorder keys, and a text
 * comparison would rewrite the file every board open. No extra key is tolerated — `timeout: 0`, `once` and `if` each disable the hook.
 */
function alreadySays(group: unknown, wanted: HookGroup): boolean {
  if (!isRecord(group) || group.matcher !== wanted.matcher || !Array.isArray(group.hooks)) {
    return false;
  }

  const entry = group.hooks[0];
  const mine = wanted.hooks[0]!;

  return (
    keysAre(group, GROUP_KEYS) &&
    group.hooks.length === 1 &&
    isRecord(entry) &&
    keysAre(entry, ENTRY_KEYS) &&
    entry.type === mine.type &&
    entry.command === mine.command &&
    entry.async === mine.async &&
    entry.timeout === mine.timeout &&
    Array.isArray(entry.args) &&
    entry.args.length === 1 &&
    entry.args[0] === mine.args[0]
  );
}

/**
 * What to write to `~/.claude/settings.json`, as text. Pure, so the whole merge is testable: the file is hand-curated, written by the CLI
 * itself, and shared by every window on the machine, so the board refuses anything it does not fully understand rather than repairing it.
 */
export function planHookInstall({ settingsText, home, wanted }: ActivityPlanInput): ActivityPlan {
  const hookPath = hookPathOf(home);

  // Nothing to lose and nothing to misread. Creating the file is not the repair of a corrupt one.
  const text = settingsText ?? '{}\n';

  // PowerShell 5.1's `Out-File` and Notepad both write one, and `JSON.parse` rejects it. Refusing a file the CLI
  // itself reads happily would be the board's own bug, not the developer's.
  const body = text.replace(/^\uFEFF/, '');
  const bom = text.length === body.length ? '' : '\uFEFF';

  let root: unknown;

  try {
    root = JSON.parse(body);
  } catch (error) {
    return refuse(
      `${SETTINGS_PATH} is not valid JSON, so the board left it alone: ${(error as Error).message}`,
      `Fix ${SETTINGS_PATH}, then reopen the board. Sessions still appear; they cannot report what they are doing.`,
    );
  }

  if (!isRecord(root)) {
    return refuse(
      `${SETTINGS_PATH} does not hold a JSON object, so the board left it alone.`,
      `Fix ${SETTINGS_PATH}, then reopen the board.`,
    );
  }

  if (root.hooks !== undefined && !isRecord(root.hooks)) {
    return refuse(
      `The "hooks" key in ${SETTINGS_PATH} is not an object, so the board left it alone.`,
      `Fix or remove "hooks" in ${SETTINGS_PATH}, then reopen the board.`,
    );
  }

  const hooks: Record<string, unknown> = isRecord(root.hooks) ? { ...root.hooks } : {};

  // Install walks what it wants *and* what is already there: an event dropped from WANTED would otherwise keep an
  // entry of ours wired forever, with nothing to notice it. Remove walks only what is there.
  const events = [...new Set([...(wanted === 'install' ? WANTED.map(([event]) => event) : []), ...Object.keys(hooks)])];

  let added = 0;
  let removed = 0;

  for (const event of events) {
    const existing = hooks[event];
    const mine = WANTED.find(([name]) => name === event);
    const wants = wanted === 'install' && mine !== undefined;

    if (existing !== undefined && !Array.isArray(existing)) {
      // Only an event the plan is about to touch. Refusing over one it would never write is a refusal the
      // developer cannot act on, and it would leave the board's own entries installed on a removal.
      if (!wants && !hasOurEntry(existing, hookPath)) {
        continue;
      }

      return refuse(
        `"hooks.${event}" in ${SETTINGS_PATH} is not a list, so the board left the file alone.`,
        `Fix "hooks.${event}" in ${SETTINGS_PATH}, then reopen the board.`,
      );
    }

    const current = Array.isArray(existing) ? existing : [];
    const group = wants ? groupFor(mine![1], hookPath) : null;

    // One correct group already there is the steady state, and reaching it means writing nothing at all.
    if (group && current.filter((c) => hasOurEntry(c, hookPath)).length === 1) {
      if (current.some((c) => alreadySays(c, group))) {
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

  // Assigned back whole, so JSON's insertion order — and with it every key the developer put in this file — survives.
  if (Object.keys(hooks).length === 0) {
    delete root.hooks;
  } else {
    root.hooks = hooks;
  }

  // A file kept in a dotfiles repo would otherwise come back as a whole-file diff, which is the same thing
  // `indentOf` exists to avoid.
  const crlf = body.includes('\r\n');
  const trailing = body.endsWith('\n') ? (crlf ? '\r\n' : '\n') : '';
  const serialised = JSON.stringify(root, null, indentOf(body));
  const written = `${crlf ? serialised.replace(/\n/g, '\r\n') : serialised}${trailing}`;

  return { kind: 'write', text: `${bom}${written}`, added, removed };
}

/**
 * How stale a lock has to be before it is another window's crash rather than its work in progress. One install is a
 * read, a compare and a rename, so a lock this old is not being held by anything alive.
 */
export const LOCK_STALE_MS = 60_000;

/** Whether to take a lock, given the age of the one already there. A lock nobody clears would block installs forever. */
export function lockIsStale(mtimeMs: number, now: number): boolean {
  return now - mtimeMs > LOCK_STALE_MS || mtimeMs > now + LOCK_STALE_MS;
}

/** How many backups of the developer's settings file are kept. Enough to undo a bad run, not enough to accumulate. */
export const BACKUPS_KEPT = 5;

/**
 * The backups to delete, oldest first. Named for the time they were taken, so the names sort chronologically and the newest are the tail.
 * This list is handed to `rmSync` in the developer's home, which is why it is a tested function rather than a slice expression in glue code.
 */
export function backupsToDelete(names: readonly string[]): string[] {
  const ours = names.filter((name) => /^settings-backup-.+\.json$/.test(name)).sort();

  return ours.slice(0, Math.max(0, ours.length - BACKUPS_KEPT));
}

/** How long an orphaned marker is kept. A session that never fired SessionEnd leaves one, and nothing else sweeps it. */
export const MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Whether a marker is old enough to be an orphan rather than a live session's. Deletes files, so it is tested. */
export function markerIsOrphaned(mtimeMs: number, now: number): boolean {
  return now - mtimeMs > MARKER_MAX_AGE_MS;
}
