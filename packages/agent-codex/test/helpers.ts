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

/**
 * The fields every recorded payload carries whatever its event. A cast is not a check: a recording missing one reads
 * `undefined` where the type promised a value, and nothing fails until something reads it.
 */
const ALWAYS = {
  session_id: true,
  transcript_path: true,
  cwd: true,
  hook_event_name: true,
} satisfies Partial<Record<keyof HookPayload, true>>;

/** The seven events one session fires, in order. A recording that lost one must fail the run, not shrink quietly. */
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
 * A machine made of literals. Every reader is the disk contract: a file that is not in `files` reads as null, and a
 * directory that is not in `dirs` lists as null — which is how a test says "absent" rather than "empty".
 */
export function machine(machine: Partial<FakeMachine>, pattern: RegExp | null = /^(\d+)-/): MachineDeps {
  const files = machine.files ?? {};
  const dirs = machine.dirs ?? {};
  const mtimes = machine.mtimes ?? {};

  const readText: ReadText = (path) => files[path] ?? null;
  const listDir: ListDir = (path) => dirs[path] ?? null;
  const mtime: StatMtime = (path) => mtimes[path] ?? (files[path] === undefined ? null : 1_000);
  const readHead: ReadTail = (path, bytes) => (files[path] === undefined ? null : files[path]!.slice(0, bytes));
  // From the end, because a fake that answers a tail with a head lies to the first reader that asks for one.
  const readTail: ReadTail = (path, bytes) => (files[path] === undefined ? null : files[path]!.slice(-bytes));

  return { readText, listDir, mtime, readTail, readHead, home: HOME, pattern };
}
