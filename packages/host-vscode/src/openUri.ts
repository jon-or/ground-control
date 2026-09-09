/**
 * Construct editor links for browser navigation. OS routing and foreground behavior depend on the registered
 * handler and launch context (mechanics M26, M29). The URI alone does not guarantee target-window focus.
 */

/** The two paths the handler answers. Anything else is a link the board did not write. */
const OPEN_SESSION_PATH = '/open';
const ATTACH_SESSION_PATH = '/attach';

/**
 * The detached run a handled URI names, or null for anything else. A run's row links here rather than to `/open`
 * because a run is entered by attaching to it, and a row does the same thing on either board — what differs is only
 * that a click in the browser has to raise the editor first, which the navigation itself does.
 */
export function attachFromUri(path: string, query: string): string | null {
  return path === ATTACH_SESSION_PATH ? sessionIdIn(query) : null;
}

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
  return path === OPEN_SESSION_PATH ? sessionIdIn(query) : null;
}

function sessionIdIn(query: string): string | null {
  const session = new URLSearchParams(query).get('session');

  return session !== null && SESSION_ID.test(session) ? session : null;
}

/**
 * Read the handover agent when hop=1. The receiving window must validate the request and either open locally
 * or refuse; it cannot forward again. Carry the agent because the receiver may have no snapshot. Browser-
 * supplied parameters receive the same validation.
 */
export function handedOver(query: string): string | null {
  const params = new URLSearchParams(query);
  const agent = params.get('agent');

  return params.get('hop') === '1' && agent !== null && /^[a-z][a-z0-9-]{0,31}$/.test(agent) ? agent : null;
}

/** The URI the board fires at a window it has raised, so that window reveals the session itself. */
export function handOverUri(sessionId: string, agent: string): string {
  const query = new URLSearchParams({ session: sessionId, agent, hop: '1' });

  return `vscode://groundcontrol.ground-control${OPEN_SESSION_PATH}?${query.toString()}`;
}
