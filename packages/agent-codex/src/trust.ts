import { z } from 'zod';
import { normalize } from '@ground-control/core';
import type { MachineReaders, ReadFailure } from '@ground-control/core';
import { codexHomeOf, codexHooksPathOf, hookPathOf } from './hookScript.js';
import { CODEX_AGENT_ID, CODEX_DISPLAY_NAME } from './ids.js';

/** The hash Codex trusts is taken over its own representation of an entry, so the board never computes one: it asks
 * `hooks/list` for the hash and hands it straight back through `config/batchWrite` (`docs/mechanics.md` M41). */
const TRUST_TABLE = /^\s*\[hooks\.state\.(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\]\s*$/;
const TRUSTED_HASH = /^\s*trusted_hash\s*=/;

export function codexConfigPathOf(home: string, env: NodeJS.ProcessEnv = {}): string {
  return `${codexHomeOf(home, env)}/config.toml`;
}

/** One key, comparable across the two spellings of a Windows path: Codex writes the separators and case of the path
 * it resolved, which is not the one the board joined. */
function comparable(key: string): string {
  return normalize(key).toLowerCase();
}

/** `SessionStart` as Codex keys it. The event half of a trust key is snake case, the JSON half is Pascal (M41). */
export function trustKeyEventOf(event: string): string {
  return event.replace(/(?<!^)([A-Z])/g, '_$1').toLowerCase();
}

/**
 * The trust keys that carry a `trusted_hash`. A table with no hash under it is an entry Codex is tracking without
 * trusting, which fires nothing — so the hash is the evidence rather than the table.
 */
export function trustedKeysFrom(text: string | null): Set<string> {
  const trusted = new Set<string>();
  let key: string | null = null;

  for (const line of (text ?? '').split('\n')) {
    const table = TRUST_TABLE.exec(line);

    if (table) {
      const raw = table[1] ?? table[2] ?? '';

      // A basic string escapes its backslashes; a literal one does not. Both spell the same Windows path.
      key = table[1] === undefined ? raw.replace(/\\\\/g, '\\') : raw;
      continue;
    }

    // Any other table header ends ours, so a `trusted_hash` further down belongs to something else.
    if (/^\s*\[/.test(line)) {
      key = null;
      continue;
    }

    if (key !== null && TRUSTED_HASH.test(line)) {
      trusted.add(comparable(key));
      key = null;
    }
  }

  return trusted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The board's own installed entries, as the trust keys Codex would name them. Group and entry index come from where
 * the entry actually sits in the file, because a developer's own group for the same event shifts ours along.
 */
export function installedTrustKeys(hooksText: string | null, home: string, env: NodeJS.ProcessEnv = {}): string[] {
  const command = `node "${hookPathOf(home)}"`;
  const keys: string[] = [];

  let root: unknown;

  try {
    root = JSON.parse((hooksText ?? '').replace(/^﻿/, ''));
  } catch {
    return keys;
  }

  if (!isRecord(root) || !isRecord(root.hooks)) {
    return keys;
  }

  const path = codexHooksPathOf(home, env);

  for (const [event, groups] of Object.entries(root.hooks)) {
    if (!Array.isArray(groups)) {
      continue;
    }

    groups.forEach((group, groupIndex) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        return;
      }

      group.hooks.forEach((entry, entryIndex) => {
        if (isRecord(entry) && entry.command === command) {
          keys.push(`${path}:${trustKeyEventOf(event)}:${groupIndex}:${entryIndex}`);
        }
      });
    });
  }

  return keys;
}

/** Which of the board's own entries Codex will run. Read from files, so asking costs no process. */
export interface TrustState {
  installed: string[];
  untrusted: string[];
}

export function trustState(readers: MachineReaders, env: NodeJS.ProcessEnv = {}): TrustState {
  const installed = installedTrustKeys(readers.readText(codexHooksPathOf(readers.home, env)), readers.home, env);

  if (installed.length === 0) {
    return { installed, untrusted: [] };
  }

  const trusted = trustedKeysFrom(readers.readText(codexConfigPathOf(readers.home, env)));

  return { installed, untrusted: installed.filter((key) => !trusted.has(comparable(key))) };
}

/** What `hooks/list` reports, narrowed to the four fields a trust edit is built from. */
const hooksList = z.object({
  data: z
    .array(
      z.object({
        hooks: z
          .array(
            z.object({
              key: z.string(),
              command: z.string().optional(),
              currentHash: z.string().nullish(),
              trustStatus: z.string(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

/** One `config/batchWrite` edit: the `hooks.state` table, merged rather than replaced. */
export interface TrustEdit {
  keyPath: 'hooks.state';
  mergeStrategy: 'upsert';
  value: Record<string, { trusted_hash: string }>;
}

/**
 * What to write, and how many of the board's own entries Codex reported at all. The count is what separates the two
 * ways an edit comes back null: every entry already trusted, and Codex reading a hooks file that is not the one the
 * board installed into — which looks like success and fixes nothing.
 */
export interface TrustPlan {
  edit: TrustEdit | null;
  ours: number;
}

/**
 * The edit that trusts the board's own hooks, from what `hooks/list` reported. Only entries whose command is exactly
 * the writer this board installed: Codex reports every hook on the machine, and trusting one the developer wrote —
 * or one a plugin did — would be the board granting a command it has never seen the right to run.
 */
export function trustEditFor(raw: unknown, home: string): TrustPlan {
  const parsed = hooksList.safeParse(raw);

  if (!parsed.success) {
    return { edit: null, ours: 0 };
  }

  const command = `node "${hookPathOf(home)}"`;
  const value: Record<string, { trusted_hash: string }> = {};
  let ours = 0;

  for (const scope of parsed.data.data ?? []) {
    for (const hook of scope.hooks ?? []) {
      if (hook.command !== command) {
        continue;
      }

      ours += 1;

      if (hook.trustStatus !== 'trusted' && hook.currentHash) {
        value[hook.key] = { trusted_hash: hook.currentHash };
      }
    }
  }

  const edit = Object.keys(value).length === 0 ? null : ({ keyPath: 'hooks.state', mergeStrategy: 'upsert', value } as const);

  return { edit, ours };
}

/**
 * Report untrusted hooks after a trust attempt returns (mechanics M41). Without hooks, the marker roster is
 * empty. Suppress the notice while automatic trust is pending to avoid reporting a condition the exchange may
 * resolve.
 */
export function trustFailure(state: TrustState, attempt: string | null): ReadFailure | null {
  if (state.untrusted.length === 0 || attempt === null) {
    return null;
  }

  // Reported at any count, not only when none are trusted: Codex arms trust per entry, so a partly trusted install
  // is the state where `SessionEnd` alone is inert and a finished session never leaves the board.
  const some =
    state.untrusted.length < state.installed.length
      ? `${state.untrusted.length} of the board's ${state.installed.length} session hooks`
      : `the board's session hooks`;

  return {
    subject: CODEX_AGENT_ID,
    kind: 'bad-response',
    message: `${CODEX_DISPLAY_NAME} will not run ${some}, and the board could not ask it to: ${attempt}`,
    remedy: `Run ${CODEX_DISPLAY_NAME} once and accept the hooks it asks about. Until then its sessions cannot report what they are doing, and may not appear at all.`,
  };
}
