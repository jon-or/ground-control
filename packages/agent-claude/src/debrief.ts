import { z } from 'zod';
import { DEBRIEF_ENV, frictionAnswer } from '@ground-control/core';
import type { DebriefForkInput, DebriefForkResult, DebriefRange, DebriefSignal, ExecJson, MachineReaders, ReadFailure } from '@ground-control/core';
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

/** `--output-format json` prints the result object, or an array of stream events ending with it. */
export function readDebriefOutput(value: unknown): DebriefForkResult {
  const candidate = Array.isArray(value) ? [...(value as unknown[])].reverse().find((item) => printResult.safeParse(item).success) : value;
  const parsed = printResult.safeParse(candidate);

  if (!parsed.success) return { failure: failure('debrief-unreadable', `${CLAUDE_DISPLAY_NAME} returned no debrief result.`) };

  const result = parsed.data;

  if (result.is_error === true || (result.subtype !== undefined && result.subtype !== 'success')) {
    return { failure: failure('debrief-refused', `${CLAUDE_DISPLAY_NAME} did not finish the debrief${result.subtype ? ` (${result.subtype})` : ''}.`) };
  }

  let answer;

  try {
    answer = frictionAnswer.safeParse(JSON.parse(unfenced(result.result ?? '')));
  } catch {
    answer = null;
  }

  if (!answer?.success) {
    return { failure: failure('debrief-unparsable', `The debrief answer was not the friction JSON: ${(result.result ?? '').slice(0, 200)}`) };
  }

  return {
    friction: answer.data,
    cache: result.usage === undefined ? null : { read: result.usage.cache_read_input_tokens, created: result.usage.cache_creation_input_tokens, costUsd: result.total_cost_usd ?? 0 },
  };
}

/** Transcript directory `<project>/<sessionId>/subagents/`, beside the session's transcript file. */
function subagentTexts(readers: MachineReaders, transcriptPath: string): string[] {
  const dir = `${transcriptPath.replace(/\.jsonl$/, '')}/subagents`;
  const names = readers.listDir(dir) ?? [];

  return names.filter((name) => name.endsWith('.jsonl')).flatMap((name) => readers.readText(`${dir}/${name}`) ?? []);
}

export function makeClaudeDebrief(run: ExecJson, environment: () => NodeJS.ProcessEnv): DebriefSignal {
  return {
    transcriptWrittenAt: (readers, session) => findTranscript(readers.home, session.cwd, session.sessionId, readers, environment())?.writtenAt ?? null,

    readRange(readers, session, fromMessageUuid) {
      const transcript = findTranscript(readers.home, session.cwd, session.sessionId, readers, environment());
      const main = transcript && readers.readText(transcript.path);

      return transcript && main ? debriefRange(main, subagentTexts(readers, transcript.path), session.sessionId, fromMessageUuid) : null;
    },

    async fork(input) {
      const outcome = await run(input.path, debriefArgs(input), {
        env: { ...environment(), [DEBRIEF_ENV]: '1' },
        cwd: input.cwd,
        stdin: input.prompt,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      });

      return outcome.ok ? readDebriefOutput(outcome.value) : { failure: failure(`debrief-${outcome.reason}`, `${CLAUDE_DISPLAY_NAME} could not run the debrief: ${outcome.detail}`) };
    },
  };
}
