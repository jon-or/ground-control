import { describe, expect, it } from 'vitest';
import type { DebriefForkInput, ExecJson, ExecOptions, ExecOutcome, MachineReaders } from '@ground-control/core';
import { chooseSubagents, debriefArgs, debriefRange, makeClaudeDebrief, readDebriefOutput, subagentLines } from '../src/debrief.js';
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
    expect(readDebriefOutput(output)).toEqual({ friction: [], subagents: [], cache: { read: 27702, created: 26129, costUsd: 0.4357966 } });
  });

  const result = (over: Record<string, unknown>): unknown => ({ type: 'result', subtype: 'success', is_error: false, ...over });
  const entry = { what: 'init-worktree failed', source: 'skill:init-worktree', workaround: 'Removed the binding', cost: '6 tool calls', evidence: 'appcmd error', fix: 'Remove the binding in step 4' };

  it('takes a single result object, a bare array, and JSON in a code fence, and keeps each item as answered', () => {
    const extra = { ...entry, severity: 2 };

    expect(readDebriefOutput(result({ result: JSON.stringify({ friction: [entry] }) }))).toEqual({ friction: [entry], subagents: [], cache: null });
    expect(readDebriefOutput(result({ result: `\`\`\`json\n${JSON.stringify([extra])}\n\`\`\`` }))).toEqual({
      friction: [extra], subagents: [], cache: null,
    });
  });

  // Derived from the recorded result event: a fork waiting on subagents printed three results, an interim note, the
  // answer, and an empty one (DESIGN.md, spike of 2026-09-30); no recording of that run was kept.
  it('takes the last result that is the friction JSON, and the cost of the last result', () => {
    const recorded = output.at(-1) as Record<string, unknown>;
    const interim = { ...recorded, result: 'Still waiting for the report from subagent a1.', total_cost_usd: 0.4, usage: { cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } };
    const answer = { ...recorded, result: JSON.stringify({ friction: [entry] }), total_cost_usd: 0.9, usage: { cache_read_input_tokens: 20, cache_creation_input_tokens: 6 } };
    const trailing = { ...recorded, result: '', total_cost_usd: 1.1, usage: { cache_read_input_tokens: 30, cache_creation_input_tokens: 7 } };

    expect(readDebriefOutput([...output.slice(0, -1), interim, answer, trailing])).toEqual({ friction: [entry], subagents: [], cache: { read: 30, created: 7, costUsd: 1.1 } });
    // An early empty answer, before a subagent reported, gives way to the later one.
    const early = { ...answer, result: JSON.stringify({ friction: [] }) };
    expect(readDebriefOutput([early, interim, answer, trailing])).toMatchObject({ friction: [entry] });
    expect(readDebriefOutput([interim, trailing])).toMatchObject({ failure: { kind: 'debrief-unparsable', message: expect.stringContaining('Still waiting for the report') } });
    expect(readDebriefOutput([answer, { ...trailing, subtype: 'error_during_execution', is_error: true }])).toMatchObject({ friction: [entry] });
  });

  it('accepts an item without fix, and keeps a fix an item still carries, even a blank one', () => {
    const { fix: _fix, ...unfixed } = entry;
    const blank = { ...entry, fix: ' ' };

    expect(readDebriefOutput(result({ result: JSON.stringify({ friction: [unfixed, entry, blank] }) }))).toEqual({ friction: [unfixed, entry, blank], subagents: [], cache: null });
  });

  it('refuses an unfinished turn, prose, an item missing a field or leaving one blank, and output with no result', () => {
    expect(readDebriefOutput(result({ subtype: 'error_max_turns', is_error: true }))).toMatchObject({ failure: { kind: 'debrief-refused' } });
    expect(readDebriefOutput(result({ result: 'I hit no friction.' }))).toMatchObject({ failure: { kind: 'debrief-unparsable' } });
    expect(readDebriefOutput(result({ result: JSON.stringify({ friction: [{ what: 'x' }] }) }))).toMatchObject({ failure: { kind: 'debrief-unparsable' } });
    // The analyzer groups by source and counts cost, so every field it reads must be filled.
    for (const field of ['what', 'source', 'workaround', 'cost', 'evidence']) {
      const partial = { ...entry, [field]: ' ' };
      const { [field]: _dropped, ...missing } = entry as Record<string, string>;

      expect(readDebriefOutput(result({ result: JSON.stringify({ friction: [partial] }) }))).toMatchObject({ failure: { kind: 'debrief-unparsable' } });
      expect(readDebriefOutput(result({ result: JSON.stringify({ friction: [entry, missing] }) }))).toMatchObject({ failure: { kind: 'debrief-unparsable' } });
    }
    expect(readDebriefOutput([{ type: 'system', subtype: 'init' }])).toMatchObject({ failure: { kind: 'debrief-unreadable' } });
  });
});

const home = '/home/dev';
const project = `${home}/.claude/projects/-work-42-example`;
const agents = `${project}/${SESSION}/subagents`;
const FORK = '11111111-2222-4333-8444-555555555555';
/** The recorded delegating subagent's last record is at 21:01:38; the other's is before 20:00. */
const NOW = Date.parse('2026-09-30T21:30:00.000Z');
// Derived: the recorded skeleton keeps no meta files, so each subagent's type and description are set here.
const meta = (agentType: string | null, description: string): string => JSON.stringify({ ...(agentType === null ? {} : { agentType }), description });
const files: Record<string, string> = {
  [`${project}/${SESSION}.jsonl`]: main,
  [`${agents}/agent-a1.jsonl`]: subagents[0] ?? '',
  [`${agents}/agent-a1.meta.json`]: meta('general-purpose', 'Finder: tests'),
  [`${agents}/agent-b2.jsonl`]: subagents[0] ?? '',
  [`${agents}/agent-b2.meta.json`]: meta('Explore', 'Find the callers'),
  [`${agents}/agent-c3.jsonl`]: subagents[0] ?? '',
  [`${agents}/agent-c3.meta.json`]: meta('codex', 'Finder: correctness'),
  [`${agents}/agent-d4.jsonl`]: subagents[1] ?? '',
  [`${agents}/agent-d4.meta.json`]: meta('general-purpose', 'Early research'),
  [`${agents}/agent-e5.jsonl`]: subagents[0] ?? '',
  [`${agents}/agent-e5.meta.json`]: meta(null, 'No type'),
};
const readers: MachineReaders = {
  home,
  stateDir: `${home}/.claude/ground-control`,
  readText: (path) => files[path] ?? null,
  mtime: (path) => (path in files ? 1_790_000_000_000 : null),
  listDir: (path) => {
    if (path === `${home}/.claude/projects`) return ['-work-42-example'];
    if (path === agents) return Object.keys(files).filter((file) => file.startsWith(`${agents}/`)).map((file) => file.slice(agents.length + 1));
    return null;
  },
  readTail: () => null,
  readHead: () => null,
};

/** Readers that find no transcript, for forks whose subagent handling is not under test. */
const nowhere: MachineReaders = { ...readers, listDir: () => null };

function input(over: Partial<DebriefForkInput> = {}): DebriefForkInput {
  return {
    path: 'claude',
    sessionId: SESSION,
    forkId: FORK,
    cwd: '/work/42-example',
    prompt: 'What slowed you down?',
    timeoutMs: 600_000,
    signal: new AbortController().signal,
    readers: nowhere,
    subagentsDebriefed: {},
    now: NOW,
    ...over,
  };
}

describe('the subagents a fork may message', () => {
  it('offers a resumable subagent written within the cache window, and leaves out codex, Explore, Plan, untyped and older ones', () => {
    expect(chooseSubagents(readers, agents, {}, NOW).map((choice) => [choice.agentId, choice.description, choice.scope])).toEqual([
      ['a1', 'Finder: tests', 'all of your work in this conversation'],
    ]);
    expect(chooseSubagents(readers, agents, {}, Date.parse('2026-09-30T21:56:38.906Z'))).toEqual([]);
  });

  // Derived: the recorded subagent has no message after its tool results, so the later work is appended here.
  it('asks a subagent debriefed before only about the work after the first message it received since, and skips one with none', () => {
    const later = [
      { type: 'user', uuid: 'later-1', timestamp: '2026-09-30T21:10:00.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] } },
      { type: 'user', uuid: 'later-2', timestamp: '2026-09-30T21:11:00.000Z', message: { content: `Recheck the fix. ${'Look again. '.repeat(20)}` } },
    ];
    const resumed: MachineReaders = { ...readers, readText: (path) => (path === `${agents}/agent-a1.jsonl` ? `${files[path]}\n${lines(later)}` : readers.readText(path)) };

    expect(chooseSubagents(resumed, agents, { a1: '2026-09-30T21:05:00.000Z' }, NOW)[0]?.scope).toBe(`the work after the message that begins "${`Recheck the fix. ${'Look again. '.repeat(20)}`.slice(0, 200)}"`);
    expect(chooseSubagents(readers, agents, { a1: '2026-09-30T21:05:00.000Z' }, NOW)).toEqual([]);

    // Records since the last debrief with no new message, such as a late tool result, hold nothing new.
    const quiet: MachineReaders = { ...readers, readText: (path) => (path === `${agents}/agent-a1.jsonl` ? `${files[path]}\n${lines(later.slice(0, 1))}` : readers.readText(path)) };
    expect(chooseSubagents(quiet, agents, { a1: '2026-09-30T21:05:00.000Z' }, NOW)).toEqual([]);
  });

  it('fills the prompt with a line per subagent, or none', () => {
    expect(subagentLines(chooseSubagents(readers, agents, {}, NOW))).toBe('- `a1` (Finder: tests): all of your work in this conversation');
    expect(subagentLines([])).toBe('none');
  });

  it('keeps replacement patterns in a subagent line literal when filling the prompt', async () => {
    const tricky: MachineReaders = { ...readers, readText: (path) => (path === `${agents}/agent-a1.meta.json` ? meta('general-purpose', 'Check $& and $` handling') : readers.readText(path)) };
    const prompts: (string | undefined)[] = [];

    await makeClaudeDebrief(async (_path, _args, options) => {
      prompts.push(options?.stdin);
      return { ok: true, value: output };
    }, () => ({}), { copyFile: () => undefined, remove: () => undefined }).fork(input({ readers: tricky, prompt: 'Ask: {{subagents}}' }));

    expect(prompts).toEqual(['Ask: - `a1` (Check $& and $` handling): all of your work in this conversation']);
  });
});

describe('the debrief fork', () => {
  it('resumes the session as a transient fork with the chosen ID, and passes nothing that changes the prompt prefix', () => {
    expect(debriefArgs(input())).toEqual([
      '-p', '--resume', SESSION, '--fork-session', '--session-id', FORK,
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

    expect(await debrief.fork(input({ prompt: 'Subagents:\n{{subagents}}' }))).toEqual({ friction: [], subagents: [], cache: { read: 27702, created: 26129, costUsd: 0.4357966 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('claude');
    expect(calls[0]?.[2]).toMatchObject({
      cwd: '/work/42-example', stdin: 'Subagents:\nnone', timeoutMs: 600_000,
      env: { PATH: '/bin', CLAUDE_CONFIG_DIR: '/profiles/work', FRICTION_DEBRIEF: '1' },
    });
  });

  /** Copies and removals the fork asked for, in order, failing a copy when told to. */
  function recordingFiles(failCopy = false) {
    const done: string[] = [];
    return {
      done,
      files: {
        copyFile: (from: string, to: string) => {
          done.push(`copy ${from} -> ${to}`);
          if (failCopy) throw new Error('EBUSY: resource busy or locked');
        },
        remove: (path: string) => { done.push(`remove ${path}`); },
      },
    };
  }

  const copied = [
    `copy ${agents}/agent-a1.jsonl -> ${project}/${FORK}/subagents/agent-a1.jsonl`,
    `copy ${agents}/agent-a1.meta.json -> ${project}/${FORK}/subagents/agent-a1.meta.json`,
  ];
  const removed = `remove ${project}/${FORK}`;

  it('copies only the offered subagents under the fork, names them in the prompt, and removes the copy however the run ends', async () => {
    const outcomes: (() => Promise<ExecOutcome>)[] = [
      async () => ({ ok: true, value: output }),
      async () => ({ ok: false, reason: 'failed', detail: 'timed out after 600s' }),
      async () => { throw new Error('spawn crashed'); },
    ];
    const results: unknown[] = [];

    for (const outcome of outcomes) {
      const log = recordingFiles();
      const prompts: (string | undefined)[] = [];
      const debrief = makeClaudeDebrief(async (_path, _args, options) => {
        log.done.push('run');
        prompts.push(options?.stdin);
        return outcome();
      }, () => ({}), log.files);

      results.push(await debrief.fork(input({ readers, prompt: '{{subagents}}' })).catch(() => 'threw'));

      expect(log.done).toEqual([...copied, 'run', removed]);
      expect(prompts).toEqual(['- `a1` (Finder: tests): all of your work in this conversation']);
    }

    expect(results[0]).toMatchObject({ subagents: ['a1'] });
  });

  it('keeps a finished debrief whose copy cannot be removed, and never copies over the session itself', async () => {
    const stuck = { copyFile: () => undefined, remove: () => { throw new Error('EBUSY'); } };

    expect(await makeClaudeDebrief(async () => ({ ok: true, value: output }), () => ({}), stuck).fork(input({ readers }))).toMatchObject({ friction: [], subagents: ['a1'] });

    const log = recordingFiles();
    await makeClaudeDebrief(async () => ({ ok: true, value: output }), () => ({}), log.files).fork(input({ readers, forkId: SESSION }));
    expect(log.done).toEqual([]);
  });

  it('copies nothing when no subagent is offered, and does not run when the copy fails', async () => {
    const bare = recordingFiles();
    const runs: string[] = [];
    const run: ExecJson = async () => {
      runs.push('run');
      return { ok: true, value: output };
    };

    await makeClaudeDebrief(run, () => ({}), bare.files).fork(input({ readers, now: Date.parse('2026-10-01T00:00:00.000Z') }));
    expect(bare.done).toEqual([]);
    expect(runs).toEqual(['run']);

    const broken = recordingFiles(true);

    expect(await makeClaudeDebrief(run, () => ({}), broken.files).fork(input({ readers }))).toMatchObject({
      failure: { kind: 'debrief-subagents', message: expect.stringContaining('EBUSY') },
    });
    expect(runs).toEqual(['run']);
    expect(broken.done.at(-1)).toBe(removed);
  });

  it('reports a process failure as a debrief failure', async () => {
    const debrief = makeClaudeDebrief(async () => ({ ok: false, reason: 'failed', detail: 'timed out after 300s' }), () => ({}));

    expect(await debrief.fork(input())).toMatchObject({ failure: { subject: 'claude', kind: 'debrief-failed', message: expect.stringContaining('timed out after 300s') } });
  });
});

describe('reading a session transcript from disk', () => {
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
