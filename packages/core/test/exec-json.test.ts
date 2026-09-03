import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { runJsonCli } from '../src/execJson.js';

const scratch = mkdtempSync(join(tmpdir(), 'gc-exec-'));
const windows = process.platform === 'win32';

function file(name: string, body: string): string {
  const path = join(scratch, name);
  writeFileSync(path, body);

  return path;
}

async function onPath<T>(directory: string, run: () => Promise<T>): Promise<T> {
  const restore = process.env['PATH'];
  process.env['PATH'] = `${directory}${delimiter}${restore ?? ''}`;

  try {
    return await run();
  } finally {
    process.env['PATH'] = restore;
  }
}

describe('runJsonCli', () => {
  it('parses a JSON document', async () => {
    expect(await runJsonCli(process.execPath, ['-e', 'process.stdout.write("[]")'])).toEqual({ ok: true, value: [] });
  });

  it('reads a document far larger than the default one-megabyte buffer', async () => {
    const generate = 'const a=[];for(let i=0;i<80000;i++)a.push("session-"+i);process.stdout.write(JSON.stringify(a))';
    const outcome = await runJsonCli(process.execPath, ['-e', generate]);
    const value = outcome.ok ? (outcome.value as string[]) : [];

    expect(JSON.stringify(value).length).toBeGreaterThan(1024 * 1024);
    expect(value).toHaveLength(80_000);
  });

  it('resolves a bare name against PATH and runs it', async () => {
    const outcome = await onPath(dirname(process.execPath), () =>
      runJsonCli('node', ['-e', 'process.stdout.write("[]")']),
    );

    expect(outcome).toEqual({ ok: true, value: [] });
  });

  it('reports a name nothing on PATH answers to', async () => {
    expect(await runJsonCli('no-such-cli-anywhere-on-this-machine', ['agents', '--json'])).toMatchObject({
      ok: false,
      reason: 'missing',
    });
  });

  it('reports a full path that names no file', async () => {
    expect(await runJsonCli(join(scratch, 'absent.exe'), [])).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('reports a path that exists but cannot be run, rather than calling it absent', async () => {
    const outcome = await runJsonCli(file('plain-data', 'not an executable\n'), []);

    expect(outcome).toMatchObject({ ok: false, reason: windows ? 'not-executable' : 'failed' });
  });

  it('reports output that is not JSON, carrying what was printed', async () => {
    expect(await runJsonCli(process.execPath, ['-e', 'process.stdout.write("not json")'])).toEqual({
      ok: false,
      reason: 'unparsable',
      detail: 'not json',
    });
  });

  it('caps how much of a CLI own output it carries', async () => {
    const outcome = await runJsonCli(process.execPath, ['-e', 'process.stdout.write("x".repeat(500))']);

    expect(!outcome.ok && outcome.detail.length).toBe(200);
  });

  it('reports a nonzero exit, carrying what the CLI printed to stderr', async () => {
    const outcome = await runJsonCli(process.execPath, [
      '-e',
      'process.stderr.write("unknown command"); process.exit(1)',
    ]);

    expect(outcome).toMatchObject({ ok: false, reason: 'failed' });
    // Node's own error text embeds stderr, so a detail built from it alone would pass a `toContain` check.
    expect(!outcome.ok && outcome.detail).toContain('unknown command');
    expect(!outcome.ok && outcome.detail).not.toContain('Command failed');
  });

  it('falls back to the spawn error when the CLI printed nothing', async () => {
    const outcome = await runJsonCli(process.execPath, ['-e', 'process.exit(3)']);

    expect(outcome).toMatchObject({ ok: false, reason: 'failed' });
    expect(!outcome.ok && outcome.detail).toContain('Command failed');
  });

  it('says how long it waited when a CLI hangs', async () => {
    const outcome = await runJsonCli(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], 200);

    expect(outcome).toEqual({ ok: false, reason: 'failed', detail: 'timed out after 0.2s' });
  });

  it('survives a path the platform will not accept at all', async () => {
    const outcome = await runJsonCli('bad\u0000path', []);

    expect(outcome).toMatchObject({ ok: false, reason: 'failed' });
  });

  it('refuses a batch shim instead of running it through a shell', async () => {
    const outcome = await runJsonCli(file('agent.cmd', '@echo off\r\necho []\r\n'), ['agents', '--json']);

    expect(outcome).toMatchObject({ ok: false, reason: 'not-executable' });
    expect(!outcome.ok && outcome.detail).toContain('batch shim');
  });

  it('refuses a .bat shim too', async () => {
    expect(await runJsonCli(file('agent.bat', '@echo off\r\necho []\r\n'), [])).toMatchObject({
      ok: false,
      reason: 'not-executable',
    });
  });

  it.runIf(windows)('refuses a batch shim a full path resolves to, rather than calling it absent', async () => {
    file('path-shim.cmd', '@echo off\r\necho []\r\n');

    expect(await runJsonCli(join(scratch, 'path-shim'), [])).toMatchObject({ ok: false, reason: 'not-executable' });
  });

  it.runIf(windows)('tries the executable extensions before the batch shims', async () => {
    // `.com` first means a real-executable extension wins; a `.cmd`-first order would refuse instead of failing.
    file('order.com', 'garbage, not a program\n');
    file('order.cmd', '@echo off\r\necho []\r\n');

    expect(await runJsonCli(join(scratch, 'order'), [])).toMatchObject({ ok: false, reason: 'failed' });
  });

  it.runIf(windows)('still resolves a name whose only match has no extension at all', async () => {
    file('only-bare', '#!/bin/sh\necho "[]"\n');

    // Dropping the extensionless candidate would make this `missing` — an installed CLI reported as absent.
    expect(await runJsonCli(join(scratch, 'only-bare'), [])).toMatchObject({ ok: false, reason: 'not-executable' });
  });

  it.runIf(windows)('names the file it resolved, not the name it was handed', async () => {
    // A developer whose PATH holds a shim needs to know which file was blamed, not just that "claude" failed.
    file('gc-named-probe', '#!/bin/sh\necho "[]"\n');
    const outcome = await onPath(scratch, () => runJsonCli('gc-named-probe', []));

    expect(outcome).toMatchObject({ ok: false, reason: 'not-executable' });
    expect(!outcome.ok && outcome.detail).toContain(scratch.split('\\').join('/'));
  });

  it('does not let an unrelated file in the working directory decide the verdict', async () => {
    file('gc-cwd-probe.cmd', '@echo off\r\necho []\r\n');
    const restore = process.cwd();
    process.chdir(scratch);

    try {
      expect(await runJsonCli('gc-cwd-probe', [])).toMatchObject({ ok: false, reason: 'missing' });
    } finally {
      process.chdir(restore);
    }
  });

  it('does not let a crafted path reach a shell', async () => {
    // The path is developer configuration. Through a shell this wrote PWNED.cmd and PWNED.bat; the only thing
    // that matters is that nothing runs and nothing is created.
    const outcome = await runJsonCli(`nosuch" & echo owned> "${join(scratch, 'PWNED')}`, []);

    expect(outcome.ok).toBe(false);
    expect(existsSync(join(scratch, 'PWNED.cmd'))).toBe(false);
    expect(existsSync(join(scratch, 'PWNED.bat'))).toBe(false);
  });
});
