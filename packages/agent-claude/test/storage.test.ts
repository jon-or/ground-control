import { describe, expect, it } from 'vitest';
import type { ExecJson, ExecOptions, ExecOutcome, ExecText, MachineDeps } from '@ground-control/core';
import { makeClaudeAdapter } from '../src/claude.js';
import { fixture, recordedReaders, transcripts } from './helpers.js';

describe('Claude storage profiles', () => {
  it.each([
    ['/profiles/user\\one', '/profiles/user\\one/settings.json'],
    ['C:/', 'C:/settings.json'],
    ['/', '/settings.json'],
  ])('keeps launch and settings paths consistent for %s', async (root, settings) => {
    let env: NodeJS.ProcessEnv | undefined;
    const adapter = makeClaudeAdapter(async (_path, _args, options) => { env = options?.env; return { ok: true, value: [] }; }, undefined, {});
    adapter.storage!.configure(root);
    await adapter.listSessions('claude', { ...recordedReaders(), pattern: null });
    expect(env?.['CLAUDE_CONFIG_DIR']).toBe(root);
    expect(adapter.activity!.settingsPath('/legacy')).toBe(settings);
  });
  it('uses the selected profile for classification and dispatch and remembers it for stop', async () => {
    const calls: { args: string[]; options: ExecOptions | undefined }[] = [];
    const run: ExecJson = async (_path, args, options) => {
      calls.push({ args, options });
      return { ok: true, value: { structured_output: { action: 'develop' } } };
    };
    const runText: ExecText = async (_path, args, options) => {
      calls.push({ args, options });
      return { ok: true, text: 'backgrounded · abcdef12 · Test' };
    };
    const ambient = { CLAUDE_CONFIG_DIR: '/ambient', TOKEN: 'test-only' };
    const adapter = makeClaudeAdapter(run, runText, ambient);
    adapter.storage!.configure('/profiles/first');
    const common = { path: 'claude', cwd: '/work/repo', model: null, prompt: 'Test', timeoutMs: 5_000, signal: new AbortController().signal };
    expect(await adapter.classify!({ ...common, sessionId: 'test', systemPrompt: '', schema: {} })).toEqual({ value: { action: 'develop' } });
    expect(await adapter.dispatch!({ ...common, name: 'Test', permissionMode: 'plan' })).toEqual({ shortId: 'abcdef12' });
    adapter.storage!.configure('/profiles/second');
    expect(await adapter.stopDispatch!('claude', 'abcdef12')).toBeNull();
    expect(calls.map((call) => call.options?.env)).toEqual([
      { CLAUDE_CONFIG_DIR: '/profiles/first', TOKEN: 'test-only' },
      { CLAUDE_CONFIG_DIR: '/profiles/first', TOKEN: 'test-only' },
      { CLAUDE_CONFIG_DIR: '/profiles/first', TOKEN: 'test-only' },
    ]);
    expect(calls[2]!.args).toEqual(['stop', 'abcdef12']);
    expect(ambient.CLAUDE_CONFIG_DIR).toBe('/ambient');
    expect(adapter.activity!.settingsPath('/legacy')).toBe('/profiles/second/settings.json');
    expect(adapter.activity!.writer!.path('/legacy')).toBe('/legacy/.claude/ground-control/hook.mjs');
  });

  it('keeps a delayed roster and transcript lookup on the profile where the request began', async () => {
    let finish!: (result: ExecOutcome) => void;
    let used: ExecOptions | undefined;
    const run: ExecJson = (_path, _args, options) => { used = options; return new Promise((resolve) => { finish = resolve; }); };
    const adapter = makeClaudeAdapter(run, undefined, {});
    const old = recordedReaders();
    const profile = '/profiles/first';
    const map = (path: string) => path.startsWith(profile) ? path.replace(profile, `${transcripts.home}/.claude`) : path;
    const paths: string[] = [];
    const deps: MachineDeps = {
      ...old, pattern: /^(\d+)-/,
      listDir: (path) => { paths.push(path); return old.listDir(map(path)); },
      mtime: (path) => old.mtime(map(path)), readTail: (path, bytes) => old.readTail(map(path), bytes),
    };
    adapter.storage!.configure(profile);
    const pending = adapter.listSessions('claude', deps);
    adapter.storage!.configure('/profiles/second');
    finish({ ok: true, value: fixture('agents-active') });
    const result = await pending;
    expect(result.sessions.length).toBeGreaterThan(0);
    expect(result.sessions.some((session) => session.title !== null)).toBe(true);
    expect(used?.env?.['CLAUDE_CONFIG_DIR']).toBe(profile);
    expect(paths).toContain(`${profile}/projects`);
    expect(paths.some((path) => path.startsWith('/profiles/second'))).toBe(false);
  });
});
