import { describe, expect, it } from 'vitest';
import { codexConfigPathOf, installedTrustKeys, trustEditFor, trustFailure, trustKeyEventOf, trustState, trustedKeysFrom } from '../src/trust.js';
import { codexHooksPathOf, hookPathOf } from '../src/hookScript.js';
import { HOME, machine } from './helpers.js';

const HOOK_PATH = hookPathOf(HOME);
const HOOKS_FILE = codexHooksPathOf(HOME);
const CONFIG_FILE = codexConfigPathOf(HOME);

function hooksWith(events: Record<string, unknown[]>): string {
  return JSON.stringify({ hooks: events });
}

function ourGroup(): unknown {
  return { hooks: [{ type: 'command', command: `node "${HOOK_PATH}"`, async: true, timeout: 5 }] };
}

function theirGroup(): unknown {
  return { hooks: [{ type: 'command', command: 'powershell mine.ps1' }] };
}

function trustBlock(key: string): string {
  return `[hooks.state.'${key}']\ntrusted_hash = "sha256:abc"\n`;
}

describe('trustKeyEventOf', () => {
  it('spells an event the way the trust key does, not the way the hooks file does', () => {
    expect(trustKeyEventOf('SessionStart')).toBe('session_start');
    expect(trustKeyEventOf('UserPromptSubmit')).toBe('user_prompt_submit');
    expect(trustKeyEventOf('PreToolUse')).toBe('pre_tool_use');
    expect(trustKeyEventOf('Stop')).toBe('stop');
  });
});

describe('trustedKeysFrom', () => {
  it('takes a literal key as written, backslashes and all', () => {
    expect(trustedKeysFrom(trustBlock('C:\\Users\\Jon\\.codex\\hooks.json:stop:0:0'))).toEqual(
      new Set(['c:/users/jon/.codex/hooks.json:stop:0:0']),
    );
  });

  it('unescapes a basic-string key, which spells the same path with doubled backslashes', () => {
    const text = '[hooks.state."C:\\\\Users\\\\Jon\\\\.codex\\\\hooks.json:stop:0:0"]\ntrusted_hash = "sha256:abc"\n';

    expect(trustedKeysFrom(text)).toEqual(new Set(['c:/users/jon/.codex/hooks.json:stop:0:0']));
  });

  /** A trust table requires trusted_hash to authorize execution. */
  it('refuses a key whose table carries no trusted_hash', () => {
    expect(trustedKeysFrom("[hooks.state.'k:stop:0:0']\n")).toEqual(new Set());
    expect(trustedKeysFrom("[hooks.state.'k:stop:0:0']\n[other]\ntrusted_hash = \"sha256:abc\"\n")).toEqual(new Set());
  });

  it('returns no trusted keys for missing configuration', () => {
    expect(trustedKeysFrom(null)).toEqual(new Set());
  });
});

describe('installedTrustKeys', () => {
  it("keys each entry of the board's own by where it actually sits in the file", () => {
    const text = hooksWith({ Stop: [ourGroup()], SessionEnd: [ourGroup()] });

    expect(installedTrustKeys(text, HOME)).toEqual([`${HOOKS_FILE}:stop:0:0`, `${HOOKS_FILE}:session_end:0:0`]);
  });

  /** Existing user groups shift installed board-hook indices. */
  it("counts past a group of the developer's own for the same event", () => {
    expect(installedTrustKeys(hooksWith({ Stop: [theirGroup(), ourGroup()] }), HOME)).toEqual([`${HOOKS_FILE}:stop:1:0`]);
  });

  it("claims none of a hook that is not the board's, and none of an unreadable file", () => {
    expect(installedTrustKeys(hooksWith({ Stop: [theirGroup()] }), HOME)).toEqual([]);
    expect(installedTrustKeys('{ not json', HOME)).toEqual([]);
    expect(installedTrustKeys(null, HOME)).toEqual([]);
  });
});

describe('trustState', () => {
  const hooks = hooksWith({ Stop: [ourGroup()], SessionEnd: [ourGroup()] });

  it('finds nothing installed where the board has written no hooks', () => {
    expect(trustState(machine({}))).toEqual({ installed: [], untrusted: [] });
  });

  it('requires configuration evidence for hook trust', () => {
    expect(trustState(machine({ files: { [HOOKS_FILE]: hooks } })).untrusted).toHaveLength(2);
  });

  it('drops the entries the config has a trusted_hash for', () => {
    const files = { [HOOKS_FILE]: hooks, [CONFIG_FILE]: trustBlock(`${HOOKS_FILE}:stop:0:0`) };

    expect(trustState(machine({ files })).untrusted).toEqual([`${HOOKS_FILE}:session_end:0:0`]);
  });

  it('reads trust configuration under CODEX_HOME', () => {
    const home = 'D:/elsewhere/codex';

    expect(trustState(machine({ files: { [`${home}/hooks.json`]: hooks } }), { CODEX_HOME: home }).installed).toHaveLength(2);
    expect(trustState(machine({ files: { [HOOKS_FILE]: hooks } }), { CODEX_HOME: home }).installed).toEqual([]);
  });
});

describe('trustEditFor', () => {
  function listed(command: string, trustStatus: string, currentHash: string | null = 'sha256:abc'): unknown {
    return { data: [{ hooks: [{ key: `${HOOKS_FILE}:stop:0:0`, command, currentHash, trustStatus }] }] };
  }

  const ours = `node "${HOOK_PATH}"`;

  it('upserts the hash Codex reported, so the board never computes one', () => {
    expect(trustEditFor(listed(ours, 'untrusted'), HOME)).toEqual({
      ours: 1,
      edit: {
        keyPath: 'hooks.state',
        mergeStrategy: 'upsert',
        value: { [`${HOOKS_FILE}:stop:0:0`]: { trusted_hash: 'sha256:abc' } },
      },
    });
  });

  /** Only trust hooks installed by the board; preserve user and plugin trust decisions. */
  it('claims no hook that is not the writer the board installed', () => {
    expect(trustEditFor(listed('powershell mine.ps1', 'untrusted'), HOME)).toEqual({ ours: 0, edit: null });
  });

  /** Count trusted hooks to distinguish successful prior trust from a wrong hooks file. */
  it('counts an entry Codex already trusts and writes nothing for it', () => {
    expect(trustEditFor(listed(ours, 'trusted'), HOME)).toEqual({ ours: 1, edit: null });
  });

  it('skips hooks without a reported hash', () => {
    expect(trustEditFor(listed(ours, 'untrusted', null), HOME)).toEqual({ ours: 1, edit: null });
  });

  it('claims nothing from a response it cannot parse', () => {
    expect(trustEditFor({ data: 'not a list' }, HOME)).toEqual({ ours: 0, edit: null });
    expect(trustEditFor(null, HOME)).toEqual({ ours: 0, edit: null });
  });

  it('reads every working directory Codex answered for, not just the first', () => {
    const raw = {
      data: [
        { hooks: [{ key: `${HOOKS_FILE}:stop:0:0`, command: ours, currentHash: 'sha256:a', trustStatus: 'untrusted' }] },
        { hooks: [{ key: `${HOOKS_FILE}:session_end:0:0`, command: ours, currentHash: 'sha256:b', trustStatus: 'untrusted' }] },
      ],
    };

    expect(Object.keys(trustEditFor(raw, HOME).edit?.value ?? {})).toHaveLength(2);
  });
});

describe('trustFailure', () => {
  const two = { installed: ['a', 'b'], untrusted: ['a', 'b'] };

  it('reports no failure when every hook is trusted', () => {
    expect(trustFailure({ installed: ['a'], untrusted: [] }, 'anything')).toBeNull();
  });

  /** Suppress pending trust failures to avoid transient poll notifications. */
  it('suppresses failures before the trust attempt completes', () => {
    expect(trustFailure(two, null)).toBeNull();
  });

  it('reports the failed trust attempt for all installed hooks', () => {
    const failure = trustFailure(two, 'Codex stopped before it answered');

    expect(failure?.subject).toBe('codex');
    expect(failure?.message).toContain("the board's session hooks");
    expect(failure?.message).toContain('Codex stopped before it answered');
    expect(failure?.remedy).toContain('approve the Ground Control hooks');
  });

  /** Trust is per entry; SessionEnd must be trusted to remove completed sessions. */
  it('counts the ones still untrusted when only some have been accepted', () => {
    expect(trustFailure({ installed: ['a', 'b'], untrusted: ['b'] }, 'refused')?.message).toContain(
      "1 of the board's 2 session hooks",
    );
  });
});
