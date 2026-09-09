import { describe, expect, it } from 'vitest';
import type { ClassifyInput, ExecJson, ExecOptions, ExecOutcome } from '@ground-control/core';
import { classifyArgs, makeClaudeClassifier } from '../src/classify.js';

function input(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    path: 'claude',
    sessionId: '367716f5-d069-4e87-a3c2-0fb50222f307',
    model: 'claude-haiku-4-5-20251001',
    systemPrompt: 'Classify the pending action.',
    prompt: 'Issue #17198 …',
    schema: { type: 'object' },
    cwd: '/home/dev/.claude/ground-control',
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    ...over,
  };
}

/** Answers once with what it is given, and records the path, argv and options it was called with. */
function runnerOf(outcome: ExecOutcome): ExecJson & { calls: [string, string[], ExecOptions | undefined][] } {
  const calls: [string, string[], ExecOptions | undefined][] = [];

  const run = (async (path: string, args: string[], options?: ExecOptions): Promise<ExecOutcome> => {
    calls.push([path, args, options]);

    return outcome;
  }) as ExecJson & { calls: [string, string[], ExecOptions | undefined][] };

  run.calls = calls;

  return run;
}

const answer = (over: Record<string, unknown> = {}): ExecOutcome => ({
  ok: true,
  value: { type: 'result', subtype: 'success', is_error: false, structured_output: { action: 'merge-upstream', detail: 'Merge it.' }, ...over },
});

describe('the argv a classification is run with', () => {
  it('is exactly this, because every flag in it keeps the session off the board', () => {
    expect(classifyArgs(input())).toEqual([
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      '{"type":"object"}',
      '--no-session-persistence',
      '--setting-sources',
      '',
      '--tools',
      '',
      '--strict-mcp-config',
      '--session-id',
      '367716f5-d069-4e87-a3c2-0fb50222f307',
      '--system-prompt',
      'Classify the pending action.',
      '--model',
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('writes each variadic flag immediately before another flag, so its empty value is not swallowed', () => {
    const args = classifyArgs(input());

    for (const flag of ['--setting-sources', '--tools']) {
      const at = args.indexOf(flag);

      expect(args[at + 1]).toBe('');
      expect(args[at + 2]?.startsWith('--')).toBe(true);
    }
  });

  it('omits --model when unconfigured', () => {
    expect(classifyArgs(input({ model: null }))).not.toContain('--model');
  });

  it('never puts the prompt in argv, because a conversation outgrows a Windows command line', () => {
    expect(classifyArgs(input({ prompt: 'x'.repeat(40_000) })).join(' ')).not.toContain('xxxx');
  });
});

describe('running a classification', () => {
  it('sends the prompt on stdin, in the given directory, bounded by the given deadline and signal', async () => {
    const run = runnerOf(answer());
    const controller = new AbortController();
    await makeClaudeClassifier(run)(input({ signal: controller.signal }));

    expect(run.calls[0]?.[0]).toBe('claude');
    expect(run.calls[0]?.[2]).toEqual({
      timeoutMs: 60_000,
      cwd: '/home/dev/.claude/ground-control',
      stdin: 'Issue #17198 …',
      signal: controller.signal,
    });
  });

  it('reads the parsed structured output', async () => {
    expect(await makeClaudeClassifier(runnerOf(answer()))(input())).toEqual({
      value: { action: 'merge-upstream', detail: 'Merge it.' },
    });
  });

  it('falls back to parsing the result string when no structured output came back', async () => {
    const outcome = answer({ structured_output: undefined, result: '{"action":"other","detail":"Something else."}' });

    expect(await makeClaudeClassifier(runnerOf(outcome))(input())).toEqual({
      value: { action: 'other', detail: 'Something else.' },
    });
  });
});

describe('refusing a classification it did not get', () => {
  async function failureOf(outcome: ExecOutcome) {
    const result = await makeClaudeClassifier(runnerOf(outcome))(input());

    expect('failure' in result).toBe(true);

    return 'failure' in result ? result.failure : null;
  }

  it('names a CLI that is not there, and points at the setting that would fix it', async () => {
    const failure = await failureOf({ ok: false, reason: 'missing', detail: 'not found' });

    expect(failure).toMatchObject({ subject: 'claude', kind: 'classify-missing' });
    expect(failure?.remedy).toContain('groundControl.agents');
  });

  it('tells a timeout from a run it stood down, and from a CLI that failed', async () => {
    expect((await failureOf({ ok: false, reason: 'failed', detail: 'timed out after 60s' }))?.kind).toBe('classify-failed');
    expect((await failureOf({ ok: false, reason: 'aborted', detail: 'stood down' }))?.kind).toBe('classify-aborted');
    expect((await failureOf({ ok: false, reason: 'unparsable', detail: 'not json' }))?.kind).toBe('classify-unparsable');
  });

  it('refuses an answer the CLI itself called an error, though the process succeeded', async () => {
    expect((await failureOf(answer({ is_error: true })))?.kind).toBe('classify-refused');
  });

  it('refuses a run that stopped for any reason but success — a usage limit exits zero', async () => {
    const failure = await failureOf(answer({ subtype: 'error_max_turns', structured_output: undefined }));

    expect(failure?.kind).toBe('classify-refused');
    expect(failure?.message).toContain('error_max_turns');
  });

  it('refuses output that is not the shape it reads', async () => {
    expect((await failureOf({ ok: true, value: 'a bare string' }))?.kind).toBe('classify-unreadable');
  });

  it('refuses a success carrying no answer at all', async () => {
    expect((await failureOf(answer({ structured_output: undefined, result: undefined })))?.kind).toBe('classify-unparsable');
    expect((await failureOf(answer({ structured_output: undefined, result: 'not json' })))?.kind).toBe('classify-unparsable');
  });
});
