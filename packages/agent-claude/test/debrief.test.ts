import { describe, expect, it } from 'vitest';
import type { DebriefForkInput, ExecJson, ExecOptions, ExecOutcome, MachineReaders } from '@ground-control/core';
import { debriefArgs, debriefRange, makeClaudeDebrief, readDebriefOutput } from '../src/debrief.js';
import { fixture } from './helpers.js';

interface Recorded {
  main: unknown[];
  subagents: unknown[][];
}

const recorded = fixture('debrief-transcript') as Recorded;
const output = fixture('debrief-output') as unknown[];
const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001';
const DELEGATED = '0190a000-0000-7000-8000-000000000001';
const LAST = '521d9a6b-dc37-4bcd-85b0-109a91761741';
/** The last main message before a subagent's agent-delegate calls, and the first after them. */
const BEFORE_DELEGATE = 'e5719fe4-5f98-4623-846d-71128e75dc99';
const AFTER_DELEGATE = '42f51437-ede1-4246-897a-79fc326fc9f8';
/** The recorded harness notice that follows both of them. */
const NOTICE = '<task-notification>[redacted]</task-notification>';

const lines = (records: readonly unknown[]): string => records.map((record) => JSON.stringify(record)).join('\n');
const main = lines(recorded.main);
const subagents = recorded.subagents.map(lines);

describe('the transcript range a debrief covers', () => {
  it('counts every main-transcript tool call, the skills in first-use order, and the delegated sessions', () => {
    expect(debriefRange(main, subagents, SESSION, null)).toEqual({
      throughMessageUuid: LAST,
      toolCalls: 187,
      skills: ['skill-a', 'skill-b', 'skill-c', 'skill-d', 'skill-e', 'skill-f', 'skill-g'],
      delegated: [DELEGATED],
      fromPrompt: null,
    });
  });

  it('starts after the last debriefed message, and takes subagent calls made after its time', () => {
    expect(debriefRange(main, subagents, SESSION, BEFORE_DELEGATE)).toEqual({
      throughMessageUuid: LAST, toolCalls: 16, skills: ['skill-f', 'skill-g'], delegated: [DELEGATED], fromPrompt: NOTICE,
    });
    expect(debriefRange(main, subagents, SESSION, AFTER_DELEGATE)).toEqual({
      throughMessageUuid: LAST, toolCalls: 16, skills: ['skill-f', 'skill-g'], delegated: [], fromPrompt: NOTICE,
    });
  });

  it('finds no work after the latest message', () => {
    expect(debriefRange(main, subagents, SESSION, LAST)).toEqual({ throughMessageUuid: LAST, toolCalls: 0, skills: [], delegated: [], fromPrompt: null });
  });

  // Derived: the recorded session has no typed prompt after its first command, so one is appended here.
  it('names a repeat debrief by the opening of the first message, past inserted context and tool results', () => {
    const typed = `  ${'Merge the base first. '.repeat(12)}`;
    const after = [
      { type: 'user', uuid: 'meta-1', sessionId: SESSION, isMeta: true, timestamp: '2026-09-30T21:20:00.000Z', message: { content: [{ type: 'text', text: 'Base directory for this skill' }] } },
      { type: 'user', uuid: 'result-1', sessionId: SESSION, timestamp: '2026-09-30T21:20:01.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] } },
      { type: 'user', uuid: 'typed-1', sessionId: SESSION, timestamp: '2026-09-30T21:20:02.000Z', message: { content: typed } },
      { type: 'user', uuid: 'typed-2', sessionId: SESSION, timestamp: '2026-09-30T21:20:03.000Z', message: { content: [{ type: 'text', text: 'Then ship it.' }] } },
    ];

    expect(debriefRange(`${main}\n${lines(after)}`, subagents, SESSION, LAST)?.fromPrompt).toBe(typed.trimStart().slice(0, 200));
    expect(debriefRange(`${main}\n${lines(after.slice(3))}`, subagents, SESSION, LAST)?.fromPrompt).toBe('Then ship it.');
  });

  it('reads the whole transcript when the last debriefed message is gone', () => {
    expect(debriefRange(main, subagents, SESSION, 'ffffffff-0000-4000-8000-000000000000')?.toolCalls).toBe(187);
  });

  it('ignores subagent calls in the main transcript, records of another session, and a line still being written', () => {
    const extra = [
      { type: 'assistant', uuid: 'side-1', sessionId: SESSION, isSidechain: true, timestamp: '2026-09-30T21:18:00.000Z', message: { content: [{ type: 'tool_use', id: 'toolu_side', name: 'Bash', input: {} }] } },
      { type: 'assistant', uuid: 'other-1', sessionId: 'b2c3d4e5-0000-4000-8000-000000000002', timestamp: '2026-09-30T21:18:01.000Z', message: { content: [{ type: 'tool_use', id: 'toolu_other', name: 'Bash', input: {} }] } },
    ];
    const range = debriefRange(`${main}\n${lines(extra)}\n{"type":"assistant","uuid":"cut`, subagents, SESSION, null);

    expect(range?.throughMessageUuid).toBe(LAST);
    expect(range?.toolCalls).toBe(187);
  });

  it('has no range for a transcript with no messages', () => {
    expect(debriefRange('{"type":"ai-title","aiTitle":"x"}\n', [], SESSION, null)).toBeNull();
  });
});

describe('the answer a debrief fork prints', () => {
  it('reads the recorded stream events: the friction and the cache use', () => {
    expect(readDebriefOutput(output)).toEqual({ friction: [], cache: { read: 27702, created: 26129, costUsd: 0.4357966 } });
  });

  const result = (over: Record<string, unknown>): unknown => ({ type: 'result', subtype: 'success', is_error: false, ...over });
  const entry = { what: 'init-worktree failed', source: 'skill:init-worktree', workaround: 'Removed the binding', cost: '6 tool calls', evidence: 'appcmd error', fix: 'Remove the binding in step 4' };

  it('takes a single result object, a bare array, and JSON in a code fence, and keeps each item as answered', () => {
    const extra = { ...entry, severity: 2 };

    expect(readDebriefOutput(result({ result: JSON.stringify({ friction: [entry] }) }))).toEqual({ friction: [entry], cache: null });
    expect(readDebriefOutput(result({ result: `\`\`\`json\n${JSON.stringify([extra])}\n\`\`\`` }))).toEqual({
      friction: [extra], cache: null,
    });
  });

  it('refuses an unfinished turn, prose, an item missing a field or leaving one blank, and output with no result', () => {
    expect(readDebriefOutput(result({ subtype: 'error_max_turns', is_error: true }))).toMatchObject({ failure: { kind: 'debrief-refused' } });
    expect(readDebriefOutput(result({ result: 'I hit no friction.' }))).toMatchObject({ failure: { kind: 'debrief-unparsable' } });
    expect(readDebriefOutput(result({ result: JSON.stringify({ friction: [{ what: 'x' }] }) }))).toMatchObject({ failure: { kind: 'debrief-unparsable' } });
    // The analyzer groups by source and counts cost, so every field must be filled.
    for (const field of ['what', 'source', 'workaround', 'cost', 'evidence', 'fix']) {
      const partial = { ...entry, [field]: ' ' };
      const { [field]: _dropped, ...missing } = entry as Record<string, string>;

      expect(readDebriefOutput(result({ result: JSON.stringify({ friction: [partial] }) }))).toMatchObject({ failure: { kind: 'debrief-unparsable' } });
      expect(readDebriefOutput(result({ result: JSON.stringify({ friction: [entry, missing] }) }))).toMatchObject({ failure: { kind: 'debrief-unparsable' } });
    }
    expect(readDebriefOutput([{ type: 'system', subtype: 'init' }])).toMatchObject({ failure: { kind: 'debrief-unreadable' } });
  });
});

function input(over: Partial<DebriefForkInput> = {}): DebriefForkInput {
  return {
    path: 'claude',
    sessionId: SESSION,
    forkId: '11111111-2222-4333-8444-555555555555',
    cwd: '/work/42-example',
    prompt: 'What slowed you down?',
    timeoutMs: 300_000,
    signal: new AbortController().signal,
    ...over,
  };
}

describe('the debrief fork', () => {
  it('resumes the session as a transient fork with the chosen ID, and passes nothing that changes the prompt prefix', () => {
    expect(debriefArgs(input())).toEqual([
      '-p', '--resume', SESSION, '--fork-session', '--session-id', '11111111-2222-4333-8444-555555555555',
      '--no-session-persistence', '--output-format', 'json',
    ]);
  });

  it('runs in the session directory with the prompt on stdin and the debrief variable set', async () => {
    const calls: [string, string[], ExecOptions | undefined][] = [];
    const run: ExecJson = async (path, args, options) => {
      calls.push([path, args, options]);
      return { ok: true, value: output } satisfies ExecOutcome;
    };
    const debrief = makeClaudeDebrief(run, () => ({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/profiles/work' }));

    expect(await debrief.fork(input())).toEqual({ friction: [], cache: { read: 27702, created: 26129, costUsd: 0.4357966 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('claude');
    expect(calls[0]?.[2]).toMatchObject({
      cwd: '/work/42-example', stdin: 'What slowed you down?', timeoutMs: 300_000,
      env: { PATH: '/bin', CLAUDE_CONFIG_DIR: '/profiles/work', FRICTION_DEBRIEF: '1' },
    });
  });

  it('reports a process failure as a debrief failure', async () => {
    const debrief = makeClaudeDebrief(async () => ({ ok: false, reason: 'failed', detail: 'timed out after 300s' }), () => ({}));

    expect(await debrief.fork(input())).toMatchObject({ failure: { subject: 'claude', kind: 'debrief-failed', message: expect.stringContaining('timed out after 300s') } });
  });
});

describe('reading a session transcript from disk', () => {
  const home = '/home/dev';
  const project = `${home}/.claude/projects/-work-42-example`;
  const files: Record<string, string> = {
    [`${project}/${SESSION}.jsonl`]: main,
    [`${project}/${SESSION}/subagents/agent-a1.jsonl`]: subagents[0] ?? '',
    [`${project}/${SESSION}/subagents/agent-a1.meta.json`]: '{}',
  };
  const readers: MachineReaders = {
    home,
    stateDir: `${home}/.claude/ground-control`,
    readText: (path) => files[path] ?? null,
    mtime: (path) => (path in files ? 1_790_000_000_000 : null),
    listDir: (path) => {
      if (path === `${home}/.claude/projects`) return ['-work-42-example'];
      if (path === `${project}/${SESSION}/subagents`) return ['agent-a1.jsonl', 'agent-a1.meta.json'];
      return null;
    },
    readTail: () => null,
    readHead: () => null,
  };
  const debrief = makeClaudeDebrief(async () => ({ ok: false, reason: 'failed', detail: 'unused' }), () => ({}));
  const session = { sessionId: SESSION, cwd: '/work/42-example' };

  it('finds the transcript by project directory and reads the subagent transcripts beside it', () => {
    expect(debrief.transcriptWrittenAt(readers, session)).toBe(1_790_000_000_000);
    expect(debrief.readRange(readers, session, BEFORE_DELEGATE)).toEqual({
      throughMessageUuid: LAST, toolCalls: 16, skills: ['skill-f', 'skill-g'], delegated: [DELEGATED], fromPrompt: NOTICE,
    });
  });

  it('has nothing for a session with no transcript', () => {
    const elsewhere = { sessionId: SESSION, cwd: '/work/other' };

    expect(debrief.transcriptWrittenAt(readers, elsewhere)).toBeNull();
    expect(debrief.readRange(readers, elsewhere, null)).toBeNull();
  });
});
