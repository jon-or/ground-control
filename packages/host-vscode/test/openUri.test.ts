import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sessionFromUri } from '../src/openUri.js';

const SESSION = 'a1b2c3d4-0000-4000-8000-000000000000';

/**
 * The one link the browser board writes, spelled out. The overlay hard-codes this string — it is plain JavaScript
 * Chrome loads as it stands — so the literal here is what holds the two halves together (`docs/testing.md`).
 */
const LINK = `vscode://ownerrez.ground-control/open?session=${SESSION}`;

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
