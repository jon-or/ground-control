import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { z } from 'zod';
import { DEBRIEF_ENV, frictionAnswer } from '@ground-control/core';
import type { DebriefForkInput, DebriefForkResult, DebriefRange, DebriefSignal, ExecJson, FrictionEntry, MachineReaders, ReadFailure } from '@ground-control/core';
import { findTranscript } from './claude.js';
import { CLAUDE_AGENT_ID, CLAUDE_DISPLAY_NAME } from './ids.js';

/**
 * Fork the session into a transient print-mode turn (mechanics M64). Model, effort, tool and MCP flags would change
 * the prompt prefix and lose the session's cache, so none are passed. The prompt goes on stdin.
 */
export function debriefArgs(input: DebriefForkInput): string[] {
  return [
    '-p',
    '--resume',
    input.sessionId,
    '--fork-session',
    '--session-id',
    input.forkId,
    '--no-session-persistence',
    '--output-format',
    'json',
  ];
}

const record = z.object({
  type: z.string(),
  uuid: z.string().optional(),
  sessionId: z.string().optional(),
  isSidechain: z.boolean().optional(),
  /** Context the CLI inserts, such as a skill's text, rather than a message in the conversation. */
  isMeta: z.boolean().optional(),
  timestamp: z.string().optional(),
  message: z.object({ content: z.unknown() }).optional(),
});

type TranscriptRecord = z.infer<typeof record>;

const block = z.object({
  type: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  content: z.unknown().optional(),
  text: z.string().optional(),
});

type Block = z.infer<typeof block>;

/** The fork sees messages, not uuids, so a repeat debrief names its start by the first message's opening text. */
export const PROMPT_EXCERPT = 200;

const DELEGATE_TOOL = /^mcp__agent-delegate__/;
const DELEGATED_ID = /"session_id"\s*:\s*"([^"\\]+)"/g;

function recordsOf(text: string): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;

    try {
      const parsed = record.safeParse(JSON.parse(line));
      if (parsed.success) records.push(parsed.data);
    } catch {
      // A transcript being written can end inside a line.
    }
  }

  return records;
}

function blocksOf(entry: TranscriptRecord): Block[] {
  const content = entry.message?.content;

  if (!Array.isArray(content)) return [];

  return content.flatMap((raw) => {
    const parsed = block.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => (item !== null && typeof item === 'object' && 'text' in item && typeof item.text === 'string' ? item.text : '')).join('\n');
  return '';
}

/** A user record's own text: a prompt or a harness notice, not a tool result or inserted context. */
function userTextOf(entry: TranscriptRecord): string | null {
  const content = entry.message?.content;

  if (entry.type !== 'user' || entry.isMeta === true) return null;
  if (typeof content === 'string') return content;

  const texts = blocksOf(entry).filter((item) => item.type === 'text' && item.text !== undefined).map((item) => item.text);

  return texts.length === 0 || blocksOf(entry).some((item) => item.type === 'tool_result') ? null : texts.join('\n');
}

/** Tool-use IDs of agent-delegate calls, and the session IDs their results name. */
function delegatedIn(records: readonly TranscriptRecord[], found: string[]): void {
  const calls = new Set<string>();

  for (const entry of records) {
    for (const item of blocksOf(entry)) {
      if (item.type === 'tool_use' && item.id !== undefined && DELEGATE_TOOL.test(item.name ?? '')) calls.add(item.id);

      if (item.type === 'tool_result' && item.tool_use_id !== undefined && calls.has(item.tool_use_id)) {
        for (const match of textOf(item.content).matchAll(DELEGATED_ID)) {
          if (match[1] !== undefined && !found.includes(match[1])) found.push(match[1]);
        }
      }
    }
  }
}

/**
 * Read the range after `fromMessageUuid` from the main transcript and the subagent transcripts beside it. Subagent
 * records count from the start message's time, since they share no message chain with the parent.
 */
export function debriefRange(main: string, subagents: readonly string[], sessionId: string, fromMessageUuid: string | null): DebriefRange | null {
  const messages = recordsOf(main).filter((entry) =>
    (entry.type === 'user' || entry.type === 'assistant') && entry.uuid !== undefined && entry.isSidechain !== true &&
    (entry.sessionId === undefined || entry.sessionId === sessionId));
  const last = messages.at(-1);

  if (last?.uuid === undefined) return null;

  const start = fromMessageUuid === null ? -1 : messages.findIndex((entry) => entry.uuid === fromMessageUuid);
  const range = messages.slice(start + 1);
  const since = start < 0 ? null : Date.parse(messages[start]?.timestamp ?? '');
  const toolUses = new Set<string>();
  const skills: string[] = [];
  const opening = start < 0 ? null : range.map(userTextOf).find((text) => text !== null && text.trim() !== '') ?? null;

  for (const entry of range) {
    for (const item of blocksOf(entry)) {
      if (entry.type === 'assistant' && item.type === 'tool_use' && item.id !== undefined) {
        toolUses.add(item.id);

        if (item.name === 'Skill' && item.input !== null && typeof item.input === 'object' && 'skill' in item.input && typeof item.input.skill === 'string') {
          if (!skills.includes(item.input.skill)) skills.push(item.input.skill);
        }
      }
    }
  }

  const delegated: string[] = [];
  delegatedIn(range, delegated);

  for (const text of subagents) {
    const records = recordsOf(text).filter((entry) => since === null || Number.isNaN(since) || Date.parse(entry.timestamp ?? '') > since);
    delegatedIn(records, delegated);
  }

  return { throughMessageUuid: last.uuid, toolCalls: toolUses.size, skills, delegated, fromPrompt: opening?.trimStart().slice(0, PROMPT_EXCERPT) ?? null };
}

const usage = z.object({
  cache_read_input_tokens: z.number().catch(0).default(0),
  cache_creation_input_tokens: z.number().catch(0).default(0),
});

const printResult = z.object({
  type: z.literal('result'),
  is_error: z.boolean().optional(),
  subtype: z.string().optional(),
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
  usage: usage.optional(),
});

function failure(kind: string, message: string): ReadFailure {
  return { subject: CLAUDE_AGENT_ID, kind, message, remedy: 'The debrief is retried on a later scan, at most three times for the same work.' };
}

/** Strip a Markdown code fence the model may wrap its JSON in. */
function unfenced(text: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  return fenced?.[1] ?? text;
}

type PrintResult = z.infer<typeof printResult>;

const failed = (result: PrintResult): boolean => result.is_error === true || (result.subtype !== undefined && result.subtype !== 'success');

function frictionOf(result: PrintResult): FrictionEntry[] | null {
  if (failed(result)) return null;

  try {
    const answer = frictionAnswer.safeParse(JSON.parse(unfenced(result.result ?? '')));
    return answer.success ? answer.data : null;
  } catch {
    return null;
  }
}

/**
 * `--output-format json` prints the result object, or an array of stream events. A fork that waits on its subagents
 * prints several results: interim ones, the answer, and an empty one after it (M64). The answer is the last result
 * that parses as the friction JSON; the last result carries the run's cost and token counts.
 */
export function readDebriefOutput(value: unknown): DebriefForkResult {
  const results = (Array.isArray(value) ? (value as unknown[]) : [value]).flatMap((item) => {
    const parsed = printResult.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  const last = results.at(-1);

  if (last === undefined) return { failure: failure('debrief-unreadable', `${CLAUDE_DISPLAY_NAME} returned no debrief result.`) };

  const friction = results.map(frictionOf).reverse().find((answer) => answer !== null) ?? null;

  if (friction === null) {
    if (failed(last)) return { failure: failure('debrief-refused', `${CLAUDE_DISPLAY_NAME} did not finish the debrief${last.subtype ? ` (${last.subtype})` : ''}.`) };

    const said = results.map((result) => result.result ?? '').reverse().find((text) => text.trim() !== '') ?? '';

    return { failure: failure('debrief-unparsable', `The debrief answer was not the friction JSON: ${said.slice(0, 200)}`) };
  }

  return {
    friction,
    subagents: [],
    cache: last.usage === undefined ? null : { read: last.usage.cache_read_input_tokens, created: last.usage.cache_creation_input_tokens, costUsd: last.total_cost_usd ?? 0 },
  };
}

/** Transcript directory `<project>/<sessionId>/subagents/`, beside the session's transcript file. */
function subagentTexts(readers: MachineReaders, transcriptPath: string): string[] {
  const dir = `${transcriptPath.replace(/\.jsonl$/, '')}/subagents`;
  const names = readers.listDir(dir) ?? [];

  return names.filter((name) => name.endsWith('.jsonl')).flatMap((name) => readers.readText(`${dir}/${name}`) ?? []);
}

/** Copying and removing the fork's subagent transcripts, injected so tests need no disk. */
export interface DebriefFiles {
  copyFile(from: string, to: string): void;
  remove(path: string): void;
}

const DISK_FILES: DebriefFiles = {
  copyFile: (from, to) => {
    mkdirSync(to.slice(0, to.lastIndexOf('/')), { recursive: true });
    copyFileSync(from, to);
  },
  // A transcript or a shell's directory inside the copy can hold it briefly after the fork exits.
  remove: (path) => rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
};

/** A subagent older than this has a cold cache; the fork is not shown it, so it cannot message it. */
export const SUBAGENT_WINDOW_MS = 55 * 60 * 1000;

/** `codex` threads are debriefed through agent-delegate; `Explore` and `Plan` subagents cannot be resumed. */
const UNASKED_AGENT_TYPES = new Set(['codex', 'Explore', 'Plan']);

const subagentMeta = z.object({ agentType: z.string().optional(), description: z.string().optional() });

export interface SubagentChoice {
  agentId: string;
  description: string;
  /** What the prompt asks it about. */
  scope: string;
  transcript: string;
  meta: string;
}

/**
 * The subagents the fork may message: resumable ones whose transcript was written within the cache window and that have
 * a message since their last debrief (`debriefed`, by agent ID). One debriefed before is asked about the work after
 * the first message it received since (M64).
 */
export function chooseSubagents(readers: MachineReaders, dir: string, debriefed: Readonly<Record<string, string>>, now: number): SubagentChoice[] {
  const choices: SubagentChoice[] = [];

  for (const name of (readers.listDir(dir) ?? []).sort()) {
    const agentId = /^agent-(.+)\.jsonl$/.exec(name)?.[1];

    if (agentId === undefined) continue;

    const transcript = `${dir}/${name}`;
    const meta = `${dir}/agent-${agentId}.meta.json`;
    let parsed;

    try {
      parsed = subagentMeta.safeParse(JSON.parse(readers.readText(meta) ?? ''));
    } catch {
      continue;
    }

    if (!parsed.success || parsed.data.agentType === undefined || UNASKED_AGENT_TYPES.has(parsed.data.agentType)) continue;

    const records = recordsOf(readers.readText(transcript) ?? '').filter((entry) => entry.timestamp !== undefined);
    const last = Math.max(...records.map((entry) => Date.parse(entry.timestamp!)).filter((at) => !Number.isNaN(at)));

    if (!Number.isFinite(last) || now - last >= SUBAGENT_WINDOW_MS) continue;

    const since = debriefed[agentId];
    let scope = 'all of your work in this conversation';

    if (since !== undefined) {
      // A subagent works again only on a new message; records without one hold nothing the last debrief missed.
      const opening = records.filter((entry) => Date.parse(entry.timestamp!) > Date.parse(since)).map(userTextOf).find((text) => text !== null && text.trim() !== '');

      if (opening === undefined || opening === null) continue;

      scope = `the work after the message that begins "${opening.trimStart().slice(0, PROMPT_EXCERPT)}"`;
    }

    choices.push({ agentId, description: parsed.data.description?.trim() || parsed.data.agentType, scope, transcript, meta });
  }

  return choices;
}

/** The prompt's `{{subagents}}`: a line per subagent the fork may message, or `none`. */
export function subagentLines(choices: readonly SubagentChoice[]): string {
  return choices.length === 0 ? 'none' : choices.map((choice) => `- \`${choice.agentId}\` (${choice.description}): ${choice.scope}`).join('\n');
}

/**
 * A fork copies only the main transcript; a subagent it messages resumes from `<project>/<forkId>/subagents/`, so the
 * chosen subagents' files are copied there for the run and removed after it (M64).
 */
async function withSubagents<T>(project: string, forkId: string, choices: readonly SubagentChoice[], files: DebriefFiles, run: () => Promise<T>): Promise<T> {
  if (choices.length === 0) return run();

  const forkDir = `${project}/${forkId}`;

  try {
    for (const choice of choices) {
      for (const file of [choice.transcript, choice.meta]) files.copyFile(file, `${forkDir}/subagents/${file.slice(file.lastIndexOf('/') + 1)}`);
    }

    return await run();
  } finally {
    try {
      files.remove(forkDir);
    } catch {
      // Failing a finished debrief would pay for it again; a copy left behind is named for a fork no roster lists.
    }
  }
}

export function makeClaudeDebrief(run: ExecJson, environment: () => NodeJS.ProcessEnv, files: DebriefFiles = DISK_FILES): DebriefSignal {
  return {
    transcriptWrittenAt: (readers, session) => findTranscript(readers.home, session.cwd, session.sessionId, readers, environment())?.writtenAt ?? null,

    readRange(readers, session, fromMessageUuid) {
      const transcript = findTranscript(readers.home, session.cwd, session.sessionId, readers, environment());
      const main = transcript && readers.readText(transcript.path);

      return transcript && main ? debriefRange(main, subagentTexts(readers, transcript.path), session.sessionId, fromMessageUuid) : null;
    },

    async fork(input) {
      const env = environment();
      const transcript = findTranscript(input.readers.home, input.cwd, input.sessionId, input.readers, env);
      const project = transcript === null ? null : transcript.path.slice(0, transcript.path.lastIndexOf('/'));
      // The fork's directory is removed afterwards, so it must never be the session's own.
      const choices = project === null || input.forkId === input.sessionId ? [] : chooseSubagents(input.readers, `${project}/${input.sessionId}/subagents`, input.subagentsDebriefed, input.now);
      // A function replacement keeps `$&` and the like in quoted messages literal.
      const prompt = input.prompt.replaceAll('{{subagents}}', () => subagentLines(choices));
      let outcome;

      try {
        outcome = await withSubagents(project ?? '', input.forkId, choices, files, () => run(input.path, debriefArgs(input), {
          env: { ...env, [DEBRIEF_ENV]: '1' },
          cwd: input.cwd,
          stdin: prompt,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
        }));
      } catch (error) {
        return { failure: failure('debrief-subagents', `The session's subagent transcripts could not be copied for the debrief: ${error instanceof Error ? error.message : String(error)}`) };
      }

      if (!outcome.ok) return { failure: failure(`debrief-${outcome.reason}`, `${CLAUDE_DISPLAY_NAME} could not run the debrief: ${outcome.detail}`) };

      const result = readDebriefOutput(outcome.value);

      return 'failure' in result ? result : { ...result, subagents: choices.map((choice) => choice.agentId) };
    },
  };
}
