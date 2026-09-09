import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ListDir, MachineDeps, ReadTail, ReadText, StatMtime } from '@ground-control/core';

const here = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8'));
}

/** One recorded Codex hook payload, as the writer receives it on stdin. Every field is measured in M40. */
export interface HookPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  turn_id?: string;
  model?: string;
  permission_mode?: string;
  source?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: { command: string; description?: string };
  tool_use_id?: string;
  tool_response?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  reason?: string;
}

/** Validate required fields at runtime; type casts cannot detect incomplete recordings. */
const ALWAYS = {
  session_id: true,
  transcript_path: true,
  cwd: true,
  hook_event_name: true,
} satisfies Partial<Record<keyof HookPayload, true>>;

/** Require all seven recorded events in capture order. */
export const payloads = ((): HookPayload[] => {
  const read = fixture('hook-payloads') as HookPayload[];

  read.forEach((sent, index) => {
    for (const key of Object.keys(ALWAYS)) {
      if (!Object.hasOwn(sent as object, key)) {
        throw new Error(`hook-payloads.json entry ${index} has no "${key}" — re-record it with record.js`);
      }
    }
  });

  return read;
})();

export function payload(event: string): HookPayload {
  const found = payloads.find((sent) => sent.hook_event_name === event);

  if (!found) {
    throw new Error(`no recorded ${event} payload — see fixtures/README.md for how to provoke it`);
  }

  return found;
}

export const HOME = '/home/dev';

export interface FakeMachine {
  files: Record<string, string>;
  dirs: Record<string, string[]>;
  mtimes: Record<string, number>;
}

/**
 * Injected file and directory maps return null for absent paths, preserving the distinction from empty
 * directories.
 */
export function machine(machine: Partial<FakeMachine>, pattern: RegExp | null = /^(\d+)-/): MachineDeps {
  const files = machine.files ?? {};
  const dirs = machine.dirs ?? {};
  const mtimes = machine.mtimes ?? {};

  const readText: ReadText = (path) => files[path] ?? null;
  const listDir: ListDir = (path) => dirs[path] ?? null;
  const mtime: StatMtime = (path) => mtimes[path] ?? (files[path] === undefined ? null : 1_000);
  const readHead: ReadTail = (path, bytes) => (files[path] === undefined ? null : files[path]!.slice(0, bytes));
  // Honor tail-read semantics in the fake reader.
  const readTail: ReadTail = (path, bytes) => (files[path] === undefined ? null : files[path]!.slice(-bytes));

  return { readText, listDir, mtime, readTail, readHead, home: HOME, pattern };
}
