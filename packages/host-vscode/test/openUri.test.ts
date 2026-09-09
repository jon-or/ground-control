import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attachFromUri, handOverUri, handedOver, sessionFromUri } from '../src/openUri.js';

const SESSION = 'a1b2c3d4-0000-4000-8000-000000000000';

/**
 * The one link the browser board writes, spelled out. The overlay hard-codes this string — it is plain JavaScript
 * Chrome loads as it stands — so the literal here is what holds the two halves together (`docs/testing.md`).
 */
const LINK = `vscode://groundcontrol.ground-control/open?session=${SESSION}`;

describe('the link the browser board writes', () => {
  it('is addressed to this extension, by the id VS Code routes on', () => {
    const manifest = JSON.parse(readFileSync('../../extensions/ground-control/package.json', 'utf8')) as {
      publisher: string;
      name: string;
    };

    expect(LINK.startsWith(`vscode://${manifest.publisher}.${manifest.name}/`)).toBe(true);
  });

  /** `Uri.parse` splits the authority off, so the handler sees the path and query the extension is addressed with. */
  it('is taken by the handler, path and query as VS Code hands them over', () => {
    const uri = new URL(LINK);

    expect(sessionFromUri(uri.pathname, uri.search.slice(1))).toBe(SESSION);
  });
});

describe('what the handler takes', () => {
  it('takes a session id from the open path', () => {
    expect(sessionFromUri('/open', `session=${SESSION}`)).toBe(SESSION);
    // The path a detached run's row links to. Its own path, so a link cannot ask for a terminal on a session the
    // board would have revealed instead, and the two are never confused for one another.
    expect(attachFromUri('/attach', `session=${SESSION}`)).toBe(SESSION);
    expect(attachFromUri('/attach', 'session=not-an-id')).toBeNull();
    expect(attachFromUri('/open', `session=${SESSION}`)).toBeNull();
    expect(sessionFromUri('/attach', `session=${SESSION}`)).toBeNull();
  });

  /**
   * Any page in the browser can navigate to this, so everything but one well-formed id is refused. An id that is
   * merely well-formed still buys nothing: the hub resolves it against its own roster and refuses an unknown one.
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

describe('the URI the board hands a raised window', () => {
  it('names the session and marks the hand-over', () => {
    const uri = handOverUri('a1b2c3d4-0000-4000-8000-000000000000', 'codex');

    expect(sessionFromUri('/open', uri.split('?')[1]!)).toBe('a1b2c3d4-0000-4000-8000-000000000000');
    expect(handedOver(uri.split('?')[1]!)).toBe('codex');
  });

  it('reads a browser click as what it is, so it is planned rather than revealed blind', () => {
    // Without this the two are indistinguishable, and a window would reveal a session it may not be holding.
    expect(handedOver('session=a1b2c3d4-0000-4000-8000-000000000000')).toBeNull();
    expect(handedOver('session=a1b2c3d4-0000-4000-8000-000000000000&hop=0&agent=codex')).toBeNull();
    // A hand-over with no agent names nothing to reveal it with, so it is not one.
    expect(handedOver('hop=1')).toBeNull();
    expect(handedOver('hop=1&agent=NOT AN AGENT')).toBeNull();
    expect(handedOver('')).toBeNull();
  });

  it('escapes what it puts in the query, because the id is only ever matched afterwards', () => {
    expect(handOverUri('a b&hop=0', 'codex')).toContain('a+b%26hop%3D0');
  });
});

describe('the address the board answers on', () => {
  it('is the extension id the manifest publishes, which is what VS Code routes on', () => {
    // Two packages write this out: here, and the browser overlay's own copy. A rename that missed one would leave
    // a link nothing answers, and nothing else compares them.
    const manifest = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'extensions', 'ground-control', 'package.json'), 'utf8'),
    ) as { publisher: string; name: string };

    expect(handOverUri('a1b2c3d4-0000-4000-8000-000000000000', 'codex')).toContain(
      `vscode://${manifest.publisher}.${manifest.name}/open?`,
    );
  });
});
