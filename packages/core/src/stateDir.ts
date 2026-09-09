import { z } from 'zod';
import { readTextFromDisk } from './machine.js';
import type { ReadText } from './machine.js';
import { bootstrapDirOf, isAbsolute, join, normalize } from './paths.js';

/** Pointer in the bootstrap directory naming the state directory. Absent means the bootstrap directory itself. */
export const STATE_POINTER_FILE = 'state-dir.json';

export function statePointerPathOf(home: string): string {
  return `${bootstrapDirOf(home)}/${STATE_POINTER_FILE}`;
}

/** A recorded migration older than this is treated as interrupted rather than in progress. */
export const MIGRATION_STALE_MS = 10 * 60 * 1000;

/** Absolute, normalized, with `.` and `..` segments collapsed, without trailing separators or control characters. */
export const stateDirSchema = z
  .string()
  .refine((value) => value.trim() === value && value !== '' && !/[\u0000-\u001f]/.test(value), 'Not a usable directory path.')
  .refine((value) => isAbsolute(value), 'Not an absolute path.')
  .transform((value) => trimDir(join(normalize(value), '')));

const pointerSchema = z.object({
  stateDir: stateDirSchema,
  migration: z.object({ to: stateDirSchema, startedAt: z.string() }).optional(),
});

export interface StatePointer {
  stateDir: string;
  migration?: { to: string; startedAt: string } | undefined;
}

export interface ResolvedStateDir {
  stateDir: string;
  /** Destination of a migration recorded less than MIGRATION_STALE_MS ago; hubs refuse to start meanwhile. */
  migratingTo: string | null;
  /** Interrupted migration destination whose recorded start is stale. */
  interruptedTo: string | null;
  /** Why an existing pointer was ignored. */
  problem: string | null;
}

function trimDir(path: string): string {
  return /^([A-Za-z]:\/|\/)$/.test(path) ? path : path.replace(/\/+$/, '');
}

/** Parse pointer text. Null means no pointer; a string is the reason it was ignored. */
export function parseStatePointer(text: string): StatePointer | string {
  try {
    const parsed = pointerSchema.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : `${STATE_POINTER_FILE} is not a usable state pointer.`;
  } catch {
    return `${STATE_POINTER_FILE} is not JSON.`;
  }
}

export function formatStatePointer(pointer: StatePointer): string {
  return `${JSON.stringify(pointer, null, 2)}\n`;
}

/** Resolve the state directory for a home from its pointer, defaulting to the bootstrap directory. */
export function resolveStateDir(home: string, readText: ReadText = readTextFromDisk, now: number = Date.now()): ResolvedStateDir {
  const fallback = bootstrapDirOf(home);
  const text = readText(statePointerPathOf(home));

  if (text === null) {
    return { stateDir: fallback, migratingTo: null, interruptedTo: null, problem: null };
  }

  const pointer = parseStatePointer(text);

  if (typeof pointer === 'string') {
    return { stateDir: fallback, migratingTo: null, interruptedTo: null, problem: pointer };
  }

  const startedAt = pointer.migration ? Date.parse(pointer.migration.startedAt) : Number.NaN;
  const fresh = Number.isFinite(startedAt) && now - startedAt < MIGRATION_STALE_MS;

  return {
    stateDir: pointer.stateDir,
    migratingTo: pointer.migration && fresh ? pointer.migration.to : null,
    interruptedTo: pointer.migration && !fresh ? pointer.migration.to : null,
    problem: null,
  };
}

/**
 * Hook writers embed this to follow the pointer at run time, so relocation needs no hook reinstall. Requires
 * `readFileSync`, `homedir`, and `join` in scope. A pointer mid-migration still names the old directory.
 */
export const HOOK_STATE_DIR_SOURCE = `const BOOTSTRAP = join(homedir(), '.claude', 'ground-control');

function stateDir() {
  try {
    const held = JSON.parse(readFileSync(join(BOOTSTRAP, '${STATE_POINTER_FILE}'), 'utf8')).stateDir;

    if (typeof held === 'string' && /^([A-Za-z]:[\\\\/]|\\/)/.test(held) && held.trim() === held) {
      return held;
    }
  } catch {}

  return BOOTSTRAP;
}`;
