import { z } from 'zod';
import { normalize } from '@ground-control/core';
import type { MachineReaders, ReadFailure } from '@ground-control/core';
import { codexHomeOf, codexHooksPathOf, hookPathOf } from './hookScript.js';
import { CODEX_AGENT_ID, CODEX_DISPLAY_NAME } from './ids.js';

/**
 * Read hashes from `hooks/list` and return them through `config/batchWrite`; only Codex computes hook hashes
 * (M41).
 */
const TRUST_TABLE = /^\s*\[hooks\.state\.(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\]\s*$/;
const TRUSTED_HASH = /^\s*trusted_hash\s*=/;

export function codexConfigPathOf(home: string, env: NodeJS.ProcessEnv = {}): string {
  return `${codexHomeOf(home, env).replace(/\/$/, '')}/config.toml`;
}

/** Normalize separators and case to compare Windows paths from Codex and the board. */
function comparable(key: string): string {
  return normalize(key).toLowerCase();
}

/** Convert JSON event names from PascalCase to snake_case trust keys (M41). */
export function trustKeyEventOf(event: string): string {
  return event.replace(/(?<!^)([A-Z])/g, '_$1').toLowerCase();
}

/** Read keys with a `trusted_hash`; a table without a hash does not authorize its hook. */
export function trustedKeysFrom(text: string | null): Set<string> {
  const trusted = new Set<string>();
  let key: string | null = null;

  for (const line of (text ?? '').split('\n')) {
    const table = TRUST_TABLE.exec(line);

    if (table) {
      const raw = table[1] ?? table[2] ?? '';

      // TOML basic strings escape backslashes; literal strings do not.
      key = table[1] === undefined ? raw.replace(/\\\\/g, '\\') : raw;
      continue;
    }

    // Stop reading the current trust key at the next table header.
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
 * Derive trust keys from installed board hooks. Use actual group and entry indices because user hooks can
 * precede them.
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

/** Installed and untrusted board hooks, read from files without starting Codex. */
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

/** `hooks/list` fields required for a trust edit. */
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
 * Trust edit and matching board-hook count. A null edit with zero matches means no installed hooks were found;
 * a positive count can indicate hooks are already trusted.
 */
export interface TrustPlan {
  edit: TrustEdit | null;
  ours: number;
}

/** Build trust edits only for commands matching the installed board hook. Leave user and plugin hooks unchanged. */
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

  // Report partial trust failures too: an untrusted `SessionEnd` hook leaves finished sessions on the board.
  const some =
    state.untrusted.length < state.installed.length
      ? `${state.untrusted.length} of the board's ${state.installed.length} session hooks`
      : `the board's session hooks`;

  return {
    subject: CODEX_AGENT_ID,
    kind: 'bad-response',
    message: `Could not trust ${some} in ${CODEX_DISPLAY_NAME}: ${attempt}`,
    remedy: `Open ${CODEX_DISPLAY_NAME} and approve the Ground Control hooks to enable session discovery and activity reporting.`,
  };
}
