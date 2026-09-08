import type { ActivityPlan, ActivityPlanInput } from '@ground-control/core';
import { hookPathOf } from './hookScript.js';

/**
 * One hook entry the board installs. Codex takes the whole command as one string rather than a command and an
 * argument list, so the writer's path is quoted inside it. `async` keeps the session from waiting on the writer.
 */
interface HookEntry {
  type: 'command';
  command: string;
  async: true;
  timeout: number;
}

interface HookGroup {
  hooks: HookEntry[];
}

/**
 * Codex clamps these two events to three seconds and reports every longer timeout as an error item in the
 * developer's own session, so the shipped entry asks for what it will get (`docs/mechanics.md` §41).
 */
const CLAMPED_EVENTS = new Set(['SessionEnd', 'Interrupt']);
const TIMEOUT_SECONDS = 5;
const CLAMPED_TIMEOUT_SECONDS = 3;

/**
 * The events the board installs, in Codex's own PascalCase. No matcher is written on any of them: Codex accepts one
 * per entry, its semantics per event are unmeasured, and a matcher that misses is a hook that never fires — a
 * missing phase rather than a wasted spawn. `phaseOf` handles every value regardless.
 */
const WANTED: readonly string[] = [
  // Installed for the roster, not for a phase: this is the only event that reports a session the board has not seen.
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

/** Two spaces unless the file says otherwise: a re-indented hooks file is a diff the developer did not ask for. */
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
 * Ours by the exact command we write. A substring test would take a hook of the developer's own that wraps the same
 * writer with arguments of theirs; Codex leaves this file byte-identical (`docs/mechanics.md` §41), so the command
 * it holds is the command we wrote.
 */
function isOurEntry(entry: unknown, hookPath: string): boolean {
  return isRecord(entry) && entry.command === commandFor(hookPath);
}

/**
 * A group with our entries taken out, or null when nothing of ours was in it. Entry by entry, never the whole group:
 * a developer who put a hook of their own beside ours would otherwise lose it to an install.
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

/** The keys a group and an entry of ours are allowed to carry. Anything else is a hand edit, not what we wrote. */
const GROUP_KEYS = new Set(['hooks']);
const ENTRY_KEYS = new Set(['type', 'command', 'async', 'timeout']);

function keysAre(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

/**
 * Whether a group already says exactly what the board would write. Field by field rather than by serialised text, and
 * no extra key is tolerated because `enabled: false` and a `matcher` each change whether the hook fires. Codex
 * reports those two on every entry but persists neither, so this converges on the second run (`mechanics.md` §41).
 */
function alreadySays(group: unknown, wanted: HookGroup): boolean {
  if (!isRecord(group) || !Array.isArray(group.hooks)) {
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
    entry.timeout === mine.timeout
  );
}

/**
 * What to write to `~/.codex/hooks.json`, as text. Pure, so the whole merge is testable: the file is hand-curated,
 * rewritten by Codex itself, and shared by every session on the machine, so the board refuses anything it does not
 * fully understand rather than repairing it.
 *
 * A written entry does not fire yet: Codex hashes each command and runs only the entries a developer has trusted,
 * so the install is complete when they accept it in Codex (`docs/mechanics.md` §41).
 */
export function planHookInstall({ settingsText, home, wanted }: ActivityPlanInput): ActivityPlan {
  const hookPath = hookPathOf(home);

  // Nothing to lose and nothing to misread. Creating the file is not the repair of a corrupt one.
  const text = settingsText ?? '{}\n';

  // PowerShell 5.1's `Out-File` and Notepad both write one, and `JSON.parse` rejects it. Refusing a file Codex
  // itself reads happily would be the board's own bug, not the developer's.
  const body = text.replace(/^﻿/, '');
  const bom = text.length === body.length ? '' : '﻿';

  let root: unknown;

  try {
    root = JSON.parse(body);
  } catch (error) {
    return refuse(
      `${HOOKS_PATH} is not valid JSON, so the board left it alone: ${(error as Error).message}`,
      `Fix ${HOOKS_PATH}, then reopen the board. Sessions still appear; they cannot report what they are doing.`,
    );
  }

  if (!isRecord(root)) {
    return refuse(
      `${HOOKS_PATH} does not hold a JSON object, so the board left it alone.`,
      `Fix ${HOOKS_PATH}, then reopen the board.`,
    );
  }

  if (root.hooks !== undefined && !isRecord(root.hooks)) {
    return refuse(
      `The "hooks" key in ${HOOKS_PATH} is not an object, so the board left it alone.`,
      `Fix or remove "hooks" in ${HOOKS_PATH}, then reopen the board.`,
    );
  }

  const hooks: Record<string, unknown> = isRecord(root.hooks) ? { ...root.hooks } : {};

  // Install walks what it wants *and* what is already there: an event dropped from WANTED would otherwise keep an
  // entry of ours wired forever, with nothing to notice it. Remove walks only what is there.
  const events = [...new Set([...(wanted === 'install' ? WANTED : []), ...Object.keys(hooks)])];

  let added = 0;
  let removed = 0;

  for (const event of events) {
    const existing = hooks[event];
    const wants = wanted === 'install' && WANTED.includes(event);

    if (existing !== undefined && !Array.isArray(existing)) {
      // Only an event the plan is about to touch. Refusing over one it would never write is a refusal the developer
      // cannot act on, and it would leave the board's own entries installed on a removal.
      if (!wants && !hasOurEntry(existing, hookPath)) {
        continue;
      }

      return refuse(
        `"hooks.${event}" in ${HOOKS_PATH} is not a list, so the board left the file alone.`,
        `Fix "hooks.${event}" in ${HOOKS_PATH}, then reopen the board.`,
      );
    }

    const current = Array.isArray(existing) ? existing : [];
    const group = wants ? groupFor(event, hookPath) : null;

    // One correct group already there is the steady state, and reaching it means writing nothing at all.
    if (group && current.filter((held) => hasOurEntry(held, hookPath)).length === 1) {
      if (current.some((held) => alreadySays(held, group))) {
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

  const crlf = body.includes('\r\n');
  const trailing = body.endsWith('\n') ? (crlf ? '\r\n' : '\n') : '';
  const serialised = JSON.stringify(root, null, indentOf(body));
  const written = `${crlf ? serialised.replace(/\n/g, '\r\n') : serialised}${trailing}`;

  return { kind: 'write', text: `${bom}${written}`, added, removed };
}
