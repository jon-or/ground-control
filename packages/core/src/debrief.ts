import { z } from 'zod';
import type { MachineReaders } from './machine.js';
import type { ReadFailure } from './types.js';

/** Friction debrief settings (R52). Empty paths resolve to the hub's defaults under the user's home. */
export interface DebriefSettings {
  enabled: boolean;
  /** Directory holding `state.json`, `log/`, and the analyzer's `report.md` and `fixes/summary.json`. */
  directory: string;
  /** The debrief prompt; `{{scope}}` in it names the work the debrief covers. */
  promptPath: string;
  /** Node script that debriefs one agent-delegate Codex thread; used only when the file exists. */
  codexScript: string;
}

export const DEFAULT_DEBRIEF: DebriefSettings = { enabled: false, directory: '', promptPath: '', codexScript: '' };

/** Environment variable set on every debrief process; hook writers and the runner ignore sessions carrying it. */
export const DEBRIEF_ENV = 'FRICTION_DEBRIEF';

const answered = z.string().refine((value) => value.trim() !== '');

/**
 * One problem a debriefed session reports. The analyzer groups by `source` and counts `cost`, so these five fields must
 * be filled; the log keeps the item as answered, including `fix` from older prompts and fields this build does not know.
 */
export const frictionEntry = z
  .object({ what: answered, source: answered, workaround: answered, cost: answered, evidence: answered })
  .passthrough();

export type FrictionEntry = z.infer<typeof frictionEntry>;

/** The fork answers `{"friction": [...]}` or the bare array. */
export const frictionAnswer = z.union([z.array(frictionEntry), z.object({ friction: z.array(frictionEntry) }).transform((answer) => answer.friction)]);

/** A session's transcript from the message after the last debrief through its latest message. */
export interface DebriefRange {
  /** The latest main-transcript message; the next debrief starts after it. */
  throughMessageUuid: string;
  /** Tool calls in the main transcript's range; subagent transcripts are excluded. */
  toolCalls: number;
  /** Skills the range invoked, in first-use order. */
  skills: string[];
  /** Session IDs agent-delegate returned in the range, in the main and subagent transcripts. */
  delegated: string[];
  /** The opening of the first user message after `fromMessageUuid`; null for a first debrief or when none is found. */
  fromPrompt: string | null;
}

export interface DebriefForkInput {
  /** The CLI, from the same configuration the roster read spawns. */
  path: string;
  sessionId: string;
  /** Caller-chosen ID for the fork, so the roster read can drop it while it runs. */
  forkId: string;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Finds the session's transcript, beside which its subagent transcripts are. */
  readers: MachineReaders;
  /** When each of the session's subagents was last debriefed, by agent ID. */
  subagentsDebriefed: Readonly<Record<string, string>>;
  /** Epoch milliseconds, for the subagents' cache window. */
  now: number;
}

export interface DebriefCache {
  read: number;
  created: number;
  costUsd: number;
}

/** `subagents` names the subagents the fork was shown and may have asked. */
export type DebriefForkResult = { friction: FrictionEntry[]; subagents: string[]; cache: DebriefCache | null } | { failure: ReadFailure };

/** Agent side of a friction debrief: reading a session's transcript range and forking the session to ask about it. */
export interface DebriefSignal {
  /**
   * The range after `fromMessageUuid` (null: the whole transcript), or null when the transcript cannot be read. An
   * unknown `fromMessageUuid` also reads the whole transcript.
   */
  readRange(readers: MachineReaders, session: { sessionId: string; cwd: string }, fromMessageUuid: string | null): DebriefRange | null;
  /** Transcript write time, which the cache check keys on; null when there is none. */
  transcriptWrittenAt(readers: MachineReaders, session: { sessionId: string; cwd: string }): number | null;
  fork(input: DebriefForkInput): Promise<DebriefForkResult>;
}
