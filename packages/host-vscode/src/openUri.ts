/**
 * The board's own address in VS Code. A browser tab cannot reach into an editor, but it can navigate, and a
 * navigation is a user gesture in the application the developer is looking at — the one thing Windows honours
 * (`docs/mechanics.md` §26, §29). So a click on a session in the browser overlay becomes this URI, VS Code takes
 * the focus, and the window that handles it runs the same open the editor board's own row runs.
 */

/** The one path the handler answers. Anything else is a link the board did not write. */
const OPEN_SESSION_PATH = '/open';

/**
 * Session ids are v4 UUIDs as every agent CLI reports them. Matched rather than trusted: this URI is reachable from
 * any page in the browser, so the handler resolves an id against the hub's own roster and takes nothing else.
 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The session a handled URI names, or null for anything this board did not write. Pure, so the extension's handler
 * is the registration and nothing else.
 */
export function sessionFromUri(path: string, query: string): string | null {
  if (path !== OPEN_SESSION_PATH) {
    return null;
  }

  const session = new URLSearchParams(query).get('session');

  return session !== null && SESSION_ID.test(session) ? session : null;
}
