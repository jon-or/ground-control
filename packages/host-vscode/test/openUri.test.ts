import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentForLink, agentFromUri, attachFromUri, handOverUri, handedOver, handoverToken, sessionFromUri, uriSchemeOf } from '../src/openUri.js';
import type { Snapshot } from '@ground-control/core';

const SESSION = 'a1b2c3d4-0000-4000-8000-000000000000';

/** Use the browser overlay's literal URI to verify cross-client compatibility (docs/testing.md). */
const LINK = `vscode://groundcontrol.ground-control/open?session=${SESSION}&agent=claude`;

describe('the agent a link names', () => {
  it('reads it without a hop, which is how the browser board writes an ordinary open', () => {
    expect(agentFromUri(new URL(LINK).search.slice(1))).toBe('claude');
    expect(agentFromUri(`session=${SESSION}&agent=codex`)).toBe('codex');
  });

  it('is absent from a link that names none, so the caller falls back to the roster', () => {
    expect(agentFromUri(`session=${SESSION}`)).toBeNull();
  });

  it.each(['Claude', '../claude', 'claude apples', '', '1claude', 'a'.repeat(33)])(
    'refuses %j, because a page writes these too',
    (agent) => {
      expect(agentFromUri(`session=${SESSION}&agent=${encodeURIComponent(agent)}`)).toBeNull();
    },
  );

  /** An agent alone is not a handover: only hop=1 transfers a reservation to the receiving window. */
  it('is not a handover without the hop', () => {
    expect(handedOver(new URL(LINK).search.slice(1))).toBeNull();
    expect(handedOver(`session=${SESSION}&agent=codex&hop=1`)).toBe('codex');
  });
});

describe('which agent a link is for', () => {
  const carrying = (agent: string, sessionId = SESSION): Snapshot =>
    ({
      lanes: [
        {
          id: 'build',
          title: 'Build',
          cards: [{ key: 'k', issue: null, issueNumber: null, sessions: [{ agent, sessionId }], lane: 'build', returned: false, attention: null, reason: '' }],
        },
      ],
    }) as unknown as Snapshot;

  it('takes the snapshot where it carries the session, over anything the link claims', () => {
    expect(agentForLink(`session=${SESSION}&agent=claude`, carrying('codex'), SESSION)).toBe('codex');
  });

  /** The reason the link names the agent at all: a window it activated has no snapshot to read. */
  it('takes the link where no snapshot has arrived yet', () => {
    expect(agentForLink(`session=${SESSION}&agent=codex`, undefined, SESSION)).toBe('codex');
  });

  it('takes the link for a session this snapshot does not carry', () => {
    expect(agentForLink(`session=${SESSION}&agent=codex`, carrying('claude', 'other'), SESSION)).toBe('codex');
  });

  it('falls back to Claude when neither knows, which is what the roster does', () => {
    expect(agentForLink(`session=${SESSION}`, undefined, SESSION)).toBe('claude');
    expect(agentForLink(`session=${SESSION}&agent=..%2Fcodex`, undefined, SESSION)).toBe('claude');
  });
});

it('carries one reservation token and rejects malformed or duplicate tokens', () => {
  const token = '01234567-89ab-4cde-8fab-0123456789ab';
  const uri = new URL(handOverUri(SESSION, 'claude', token));
  expect(uri.searchParams.get('resumeToken')).toBe(token);
  expect(handoverToken(uri.search.slice(1))).toBe(token);
  expect(handoverToken(`${uri.search.slice(1)}&resumeToken=${token}`)).toBeNull();
  expect(handoverToken('resumeToken=../arbitrary')).toBeNull();
  expect(handoverToken(new URL(handOverUri(SESSION, 'claude')).search.slice(1))).toBeNull();
});

describe('the scheme a link is written in', () => {
  /** Insiders registers vscode-insiders://; a handover written as vscode:// would open a different editor. */
  it('uses the scheme the running editor reports, and stable\'s for none', () => {
    expect(handOverUri(SESSION, 'claude', undefined, 'vscode-insiders')).toMatch(/^vscode-insiders:\/\//);
    expect(handOverUri(SESSION, 'claude')).toMatch(/^vscode:\/\//);
  });

  it('refuses anything that could not be a registered scheme', () => {
    expect(uriSchemeOf('vscode-insiders')).toBe('vscode-insiders');
    expect(uriSchemeOf('VSCode')).toBe('vscode');
    expect(uriSchemeOf('java script:')).toBe('vscode');
    expect(uriSchemeOf(undefined)).toBe('vscode');
  });
});

describe('the link the browser board writes', () => {
  it('is addressed to this extension, by the id VS Code routes on', () => {
    const manifest = JSON.parse(readFileSync('../../extensions/ground-control/package.json', 'utf8')) as {
      publisher: string;
      name: string;
    };

    expect(LINK.startsWith(`vscode://${manifest.publisher}.${manifest.name}/`)).toBe(true);
  });

  /** `Uri.parse` splits the authority off, so the handler sees the path and query the extension is addressed with. */
  it('parses the path and query supplied by VS Code', () => {
    const uri = new URL(LINK);

    expect(sessionFromUri(uri.pathname, uri.search.slice(1))).toBe(SESSION);
  });
});

describe('what the handler takes', () => {
  it('takes a session id from the open path', () => {
    expect(sessionFromUri('/open', `session=${SESSION}`)).toBe(SESSION);
    // Keep attach and open paths distinct to prevent invoking the wrong operation.
    expect(attachFromUri('/attach', `session=${SESSION}`)).toBe(SESSION);
    expect(attachFromUri('/attach', 'session=not-an-id')).toBeNull();
    expect(attachFromUri('/open', `session=${SESSION}`)).toBeNull();
    expect(sessionFromUri('/attach', `session=${SESSION}`)).toBeNull();
  });

  /**
   * Browser pages can invoke this handler. Validate UUID syntax here; the hub separately rejects IDs absent
   * from its roster.
   */
  it.each([
    ['a path the board never writes', '/seize', `session=${SESSION}`],
    ['the bare scheme', '/', `session=${SESSION}`],
    ['a path that only starts the same way', '/open-session', `session=${SESSION}`],
    ['a path with the open one inside it', '/board/open', `session=${SESSION}`],
    ['no session at all', '/open', ''],
    ['an empty session', '/open', 'session='],
    ['something that is not an id', '/open', 'session=../../etc/passwd'],
    ['a command dressed as an id', '/open', 'session=workbench.action.terminal.sendSequence'],
    ['an id with a character too many', '/open', `session=${SESSION}0`],
    ['an id with a segment too short', '/open', 'session=a1b2c3d4-0000-4000-8000-00000000000'],
    ['an id with a space in it', '/open', `session=${SESSION.slice(0, 8)} ${SESSION.slice(9)}`],
  ])('refuses %s', (_case, path, query) => {
    expect(sessionFromUri(path, query)).toBeNull();
  });

  it('takes the id however the CLI cased it', () => {
    expect(sessionFromUri('/open', `session=${SESSION.toUpperCase()}`)).toBe(SESSION.toUpperCase());
  });

  it('ignores anything else riding along in the query', () => {
    expect(sessionFromUri('/open', `column=2&session=${SESSION}&folder=d:/git/orez`)).toBe(SESSION);
  });
});

describe('window handover URI', () => {
  it('names the session and marks the hand-over', () => {
    const uri = handOverUri('a1b2c3d4-0000-4000-8000-000000000000', 'codex');

    expect(sessionFromUri('/open', uri.split('?')[1]!)).toBe('a1b2c3d4-0000-4000-8000-000000000000');
    expect(handedOver(uri.split('?')[1]!)).toBe('codex');
  });

  it('plans browser opens without treating them as handovers', () => {
    // Browser opens must be planned; only handovers can request local reveal.
    expect(handedOver('session=a1b2c3d4-0000-4000-8000-000000000000')).toBeNull();
    expect(handedOver('session=a1b2c3d4-0000-4000-8000-000000000000&hop=0&agent=codex')).toBeNull();
    // A handover requires an agent to select its reveal command.
    expect(handedOver('hop=1')).toBeNull();
    expect(handedOver('hop=1&agent=NOT AN AGENT')).toBeNull();
    expect(handedOver('')).toBeNull();
  });

  it('escapes what it puts in the query, because the id is only ever matched afterwards', () => {
    expect(handOverUri('a b&hop=0', 'codex')).toContain('a+b%26hop%3D0');
  });
});

describe('the address the board answers on', () => {
  it('uses the extension ID declared in the manifest', () => {
    // Check the literal against the manifest to catch extension-ID drift.
    const manifest = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'extensions', 'ground-control', 'package.json'), 'utf8'),
    ) as { publisher: string; name: string };

    expect(handOverUri('a1b2c3d4-0000-4000-8000-000000000000', 'codex')).toContain(
      `vscode://${manifest.publisher}.${manifest.name}/open?`,
    );
  });
});
