import { describe, expect, it } from 'vitest';
import type { DispatchInput, ExecOptions, TextOutcome } from '@ground-control/core';
import { dispatchArgs, makeClaudeDispatcher, makeClaudeStopper, shortIdFrom } from '../src/dispatch.js';

/** What `--bg` actually prints, measured in `docs/mechanics.md` M33. The help lines are part of it. */
const BACKGROUNDED = [
  'backgrounded · 46af2ac8 · ground-control · merge-upstream · #17198',
  '  claude agents             list sessions',
  '  claude attach 46af2ac8    open in this terminal',
  '  claude logs 46af2ac8      show recent output',
  '  claude stop 46af2ac8      stop this session',
  '',
].join('\n');

function input(over: Partial<DispatchInput> = {}): DispatchInput {
  return {
    path: 'claude',
    prompt: '/or-merge master 17198-channel-mapping 17198 --single',
    name: 'ground-control · merge-upstream · #17198',
    cwd: 'd:/work/repo.worktrees/17198-channel-mapping',
    permissionMode: 'manual',
    model: null,
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    ...over,
  };
}

function runner(outcome: TextOutcome) {
  const calls: { path: string; args: string[]; options: ExecOptions | undefined }[] = [];

  return {
    calls,
    run: async (path: string, args: string[], options?: ExecOptions): Promise<TextOutcome> => {
      calls.push({ path, args, options });

      return outcome;
    },
  };
}

describe('the flags a dispatched session runs under', () => {
  /**
   * Asserted whole rather than sampled. Dropping `--permission-mode` leaves a working dispatch running under `auto`,
   * which no behavioural test would notice and which is not the conservative default R31 asks for.
   */
  it('is the measured invocation, with the prompt last', () => {
    expect(dispatchArgs(input())).toEqual([
      '--bg',
      '--permission-mode',
      'manual',
      '--settings',
      '{"worktree":{"bgIsolation":"none"}}',
      '-n',
      'ground-control · merge-upstream · #17198',
      '/or-merge master 17198-channel-mapping 17198 --single',
    ]);
  });

  it('names a model where one is configured, and passes none where it is not', () => {
    expect(dispatchArgs(input({ model: 'claude-sonnet-5' }))).toEqual([
      '--bg',
      '--permission-mode',
      'manual',
      '--settings',
      '{"worktree":{"bgIsolation":"none"}}',
      '-n',
      'ground-control · merge-upstream · #17198',
      '--model',
      'claude-sonnet-5',
      '/or-merge master 17198-channel-mapping 17198 --single',
    ]);
    expect(dispatchArgs(input())).not.toContain('--model');
  });

  /** `--bg` warns and ignores one, minting its own (M33), so passing it would be a flag that reads as a promise. */
  it('never asks for a session id, because the CLI will not take one', () => {
    expect(dispatchArgs(input())).not.toContain('--session-id');
  });

  it('carries whatever permission mode it was configured with', () => {
    expect(dispatchArgs(input({ permissionMode: 'bypassPermissions' }))[2]).toBe('bypassPermissions');
  });

  /** Without it every Edit and Write a run makes in a main checkout is refused, and a conflicted merge is edits (M33). */
  it('turns off the background-isolation guard, whatever else it was given', () => {
    const args = dispatchArgs(input({ permissionMode: 'bypassPermissions', model: 'claude-sonnet-5' }));

    expect(args[args.indexOf('--settings') + 1]).toBe('{"worktree":{"bgIsolation":"none"}}');
  });
});

describe('reading CLI-assigned session IDs', () => {
  it('takes the short id off the backgrounded line and not off the help lines', () => {
    expect(shortIdFrom(BACKGROUNDED)).toBe('46af2ac8');
  });

  it('reads it whatever the line endings are', () => {
    expect(shortIdFrom(BACKGROUNDED.replace(/\n/g, '\r\n'))).toBe('46af2ac8');
  });

  it('reads nothing from output that does not carry one', () => {
    expect(shortIdFrom('')).toBe(null);
    expect(shortIdFrom('Starting background service…')).toBe(null);
    expect(shortIdFrom('backgrounded · notahexid · name')).toBe(null);
  });
});

describe('dispatching', () => {
  it('runs in the card checkout and answers with the id', async () => {
    const { calls, run } = runner({ ok: true, text: BACKGROUNDED });
    const outcome = await makeClaudeDispatcher(run)(input());

    expect(outcome).toEqual({ shortId: '46af2ac8' });
    expect(calls[0]?.path).toBe('claude');
    expect(calls[0]?.options?.cwd).toBe('d:/work/repo.worktrees/17198-channel-mapping');
  });

  it('names a missing CLI as something the settings fix, not as a run to retry', async () => {
    const { run } = runner({ ok: false, reason: 'missing', detail: 'not on PATH' });
    const outcome = await makeClaudeDispatcher(run)(input());

    expect(outcome).toMatchObject({ failure: { kind: 'dispatch-missing' } });
    expect('failure' in outcome && outcome.failure.remedy).toContain('groundControl.agents');
  });

  /** A batch shim is refused by the runner itself, and the wording has to point at the executable it wraps. */
  it('names a shim it cannot spawn as something the settings fix', async () => {
    const { run } = runner({ ok: false, reason: 'not-executable', detail: 'claude.cmd is a batch shim' });

    expect(await makeClaudeDispatcher(run)(input())).toMatchObject({ failure: { kind: 'dispatch-not-executable' } });
  });

  it('reports startup without a session ID', async () => {
    const { run } = runner({ ok: true, text: 'Starting background service…\n' });
    const outcome = await makeClaudeDispatcher(run)(input());

    expect(outcome).toMatchObject({ failure: { kind: 'dispatch-unreadable' } });
    // The board cannot follow or stop it, and saying nothing would leave a session running that nobody knows about.
    expect('failure' in outcome && outcome.failure.remedy).toContain('agents');
  });

  it('recommends retrying ordinary dispatch failures', async () => {
    const { run } = runner({ ok: false, reason: 'failed', detail: 'timed out after 60s' });
    const outcome = await makeClaudeDispatcher(run)(input());

    expect(outcome).toMatchObject({ failure: { kind: 'dispatch-failed' } });
    expect('failure' in outcome && outcome.failure.remedy).toContain('again');
  });
});

describe('stopping a dispatched session', () => {
  /** `claude rm` deletes the session "and its worktree when that is safe", and the checkout holds real work (M33). */
  it('stops it by short id, and never removes it', async () => {
    const { calls, run } = runner({ ok: true, text: 'stopped 46af2ac8\n' });

    expect(await makeClaudeStopper(run)('claude', '46af2ac8')).toBe(null);
    expect(calls[0]?.args).toEqual(['stop', '46af2ac8']);
    expect(calls[0]?.args).not.toContain('rm');
  });

  it('names a stop that did not happen, with the command the developer can run themselves', async () => {
    const { run } = runner({ ok: false, reason: 'failed', detail: 'no job matching' });
    const failure = await makeClaudeStopper(run)('claude', '46af2ac8');

    expect(failure?.kind).toBe('stop-failed');
    expect(failure?.remedy).toContain('claude stop 46af2ac8');
  });
});
