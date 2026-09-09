import { describe, expect, it } from 'vitest';
import { dispatchArgs, makeCodexDispatcher, sandboxArgs, threadIdFrom } from '../src/dispatch.js';
import type { StartProcess, StartedProcess } from '../src/dispatch.js';
import type { DispatchInput } from '@ground-control/core';

const STARTED = '{"type":"thread.started","thread_id":"01a07d5a-b5bd-7762-8ef8-4202ce964f31"}';

function input(over: Partial<DispatchInput> = {}): DispatchInput {
  return {
    path: 'codex',
    prompt: 'Fix the failing test',
    name: 'gc-triage',
    cwd: '/work/15619-a-branch',
    permissionMode: 'dontAsk',
    model: null,
    timeoutMs: 30_000,
    signal: new AbortController().signal,
    ...over,
  };
}

function starter(over: Partial<StartedProcess> = {}): { start: StartProcess; calls: { args: readonly string[]; cwd: string }[] } {
  const calls: { args: readonly string[]; cwd: string }[] = [];
  const start: StartProcess = (_path, args, options) => {
    calls.push({ args, cwd: options.cwd });

    return Promise.resolve({
      pid: 4242,
      failure: null,
      firstLine: (wanted) => Promise.resolve(wanted(STARTED) ? STARTED : null),
      ...over,
    });
  };

  return { start, calls };
}

describe('what a dispatched run is started with', () => {
  it('asks for JSON, the card checkout, and the prompt last', () => {
    const args = dispatchArgs(input(), ['--sandbox', 'workspace-write']);

    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(args).toContain('--sandbox');
    expect(args.slice(-4)).toEqual(['-C', '/work/15619-a-branch', '--', 'Fix the failing test']);
  });

  it('names the model only when the configuration set one', () => {
    expect(dispatchArgs(input(), [])).not.toContain('-m');
    expect(dispatchArgs(input({ model: 'gpt-6-astra' }), [])).toContain('gpt-6-astra');
  });

  it('sends a prompt that opens with a slash as one argument, not as a path', () => {
    expect(dispatchArgs(input({ prompt: '/review' }), []).at(-1)).toBe('/review');
  });

  /**
   * Delimit prompts from exec subcommands such as review, resume, fork, and help. A lone hyphen requests stdin
   * instead of literal prompt text.
   */
  it('ends the flags before the prompt, so a prompt that opens with a subcommand is still a prompt', () => {
    for (const prompt of ['review this diff', 'resume where you left off', 'fork the thread', 'help me', '-']) {
      const args = dispatchArgs(input({ prompt }), []);

      expect(args.at(-2)).toBe('--');
      expect(args.at(-1)).toBe(prompt);
    }
  });
});

describe('the permission modes Codex can and cannot run under', () => {
  it('translates the three modes that need nobody to answer', () => {
    expect(sandboxArgs('plan')).toEqual(['--sandbox', 'read-only', '-c', 'approval_policy="never"']);
    expect(sandboxArgs('dontAsk')).toEqual([
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_workspace_write.network_access=true',
    ]);
    expect(sandboxArgs('bypassPermissions')).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
  });

  /**
   * Enable network access for workspace-write dispatch so merge actions can push (M46). Read-only plans and
   * unsandboxed dispatch need no override.
   */
  it('gives the network only to the mode that has to push', () => {
    const network = (mode: string) => (sandboxArgs(mode) ?? []).includes('sandbox_workspace_write.network_access=true');

    expect(network('dontAsk')).toBe(true);
    expect(network('plan')).toBe(false);
    expect(network('bypassPermissions')).toBe(false);
  });

  it('refuses every mode that would raise a prompt nobody is there to answer', () => {
    for (const mode of ['manual', 'auto', 'acceptEdits', 'something-new']) {
      expect(sandboxArgs(mode)).toBeNull();
    }
  });
});

describe('reading the thread id back', () => {
  it('reads the ID from thread.started output', () => {
    expect(threadIdFrom(STARTED)).toBe('01a07d5a-b5bd-7762-8ef8-4202ce964f31');
  });

  it('claims nothing from any other line the run prints', () => {
    expect(threadIdFrom('{"type":"turn.started"}')).toBeNull();
    expect(threadIdFrom('{"type":"item.completed","item":{"id":"item_0"}}')).toBeNull();
    expect(threadIdFrom('')).toBeNull();
  });

  it('claims nothing from a started line with no id in it', () => {
    expect(threadIdFrom('{"type":"thread.started"}')).toBeNull();
  });
});

describe('dispatching work to Codex', () => {
  it('answers with the thread the run opened', async () => {
    const { start, calls } = starter();

    expect(await makeCodexDispatcher(start)(input())).toEqual({ shortId: '01a07d5a-b5bd-7762-8ef8-4202ce964f31' });
    expect(calls[0]?.cwd).toBe('/work/15619-a-branch');
  });

  it('remembers the process it started, before any marker exists for it', async () => {
    // Without trusted hooks, no marker supplies a PID. Retain the spawn PID for stopping this action (R39, M41).
    const remembered: [string, number | null][] = [];
    const { start } = starter();

    await makeCodexDispatcher(start, (id, pid) => remembered.push([id, pid]))(input());

    expect(remembered).toEqual([['01a07d5a-b5bd-7762-8ef8-4202ce964f31', 4242]]);
  });

  it('remembers nothing for a run that never named its thread', async () => {
    const remembered: [string, number | null][] = [];
    const { start } = starter({ firstLine: () => Promise.resolve(null) });

    await makeCodexDispatcher(start, (id, pid) => remembered.push([id, pid]))(input());

    expect(remembered).toEqual([]);
  });

  it('names the failure a run that could not be started reports, whatever went wrong', async () => {
    for (const [reason, kind, remedy] of [
      ['missing', 'dispatch-missing', 'groundControl.agents'],
      ['not-executable', 'dispatch-not-executable', 'groundControl.agents'],
      ['failed', 'dispatch-failed', 'Run the action again to retry'],
    ] as const) {
      const start = () =>
        Promise.resolve({ pid: null, failure: { reason, detail: 'why' }, firstLine: () => Promise.resolve(null) });
      const outcome = await makeCodexDispatcher(start)(input());

      expect(outcome).toMatchObject({ failure: { kind } });
      expect('failure' in outcome && outcome.failure.remedy).toContain(remedy);
    }
  });

  it('refuses approval modes requiring user input', async () => {
    const { start, calls } = starter();
    const outcome = await makeCodexDispatcher(start)(input({ permissionMode: 'manual' }));

    expect(calls).toEqual([]);
    expect(outcome).toMatchObject({ failure: { kind: 'dispatch-refused' } });
    expect('failure' in outcome && outcome.failure.remedy).toContain('permissionMode');
  });

  it('reports unavailable CLI paths with setting recovery steps', async () => {
    const start: StartProcess = () =>
      Promise.resolve({
        pid: null,
        failure: { reason: 'missing', detail: 'no executable at "codex"' },
        firstLine: () => Promise.resolve(null),
      });
    const outcome = await makeCodexDispatcher(start)(input());

    expect(outcome).toMatchObject({ failure: { kind: 'dispatch-missing' } });
    expect('failure' in outcome && outcome.failure.remedy).toContain('groundControl.agents');
  });

  it('reports possibly running work without a thread ID', async () => {
    const { start } = starter({ firstLine: () => Promise.resolve(null) });
    const outcome = await makeCodexDispatcher(start)(input());

    // A run may be editing without a trackable ID; report uncertainty rather than definite startup failure.
    expect(outcome).toMatchObject({ failure: { kind: 'dispatch-unreadable' } });
    expect('failure' in outcome && outcome.failure.message).toContain('without returning a thread ID');
  });
});
