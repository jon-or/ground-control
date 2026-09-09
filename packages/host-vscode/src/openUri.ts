/**
 * Construct editor links for browser navigation. OS routing and foreground behavior depend on the registered
 * handler and launch context (mechanics M26, M29). The URI alone does not guarantee target-window focus.
 */

/** Supported session URI paths. */
const OPEN_SESSION_PATH = '/open';
const ATTACH_SESSION_PATH = '/attach';

/** The scheme VS Code stable registers; Insiders and forks report their own through vscode.env.uriScheme. */
export const DEFAULT_URI_SCHEME = 'vscode';

/** URI schemes are lowercase letters, digits, and `+ - .`; anything else could not have been registered by an editor. */
const URI_SCHEME = /^[a-z][a-z0-9+.-]*$/;

/** Accept an editor-reported scheme, or fall back to stable's when it is absent or malformed. */
export function uriSchemeOf(raw: unknown): string {
  return typeof raw === 'string' && URI_SCHEME.test(raw) ? raw : DEFAULT_URI_SCHEME;
}

/**
 * Read a background session ID from `/attach`. Both clients attach to background runs; browser links open VS
 * Code first.
 */
export function attachFromUri(path: string, query: string): string | null {
  return path === ATTACH_SESSION_PATH ? sessionIdIn(query) : null;
}

/**
 * Accept UUID-shaped session IDs only. Browser pages can invoke this handler; the hub must also verify the ID
 * against its roster.
 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read a session ID from `/open`, or null for an unsupported path or invalid ID. */
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

/** Build the URI for the target window to reveal a session, in the running distribution's own scheme. */
export function handOverUri(sessionId: string, agent: string, resumeToken?: string, scheme: string = DEFAULT_URI_SCHEME): string {
  const query = new URLSearchParams({ session: sessionId, agent, hop: '1' });
  if (resumeToken !== undefined) query.set('resumeToken', resumeToken);

  return `${uriSchemeOf(scheme)}://groundcontrol.ground-control${OPEN_SESSION_PATH}?${query.toString()}`;
}

/** A handover token only transfers a hub reservation; the hub verifies its target and expiry. */
export function handoverToken(query: string): string | null {
  const params = new URLSearchParams(query);
  const token = params.get('resumeToken');
  return params.getAll('resumeToken').length === 1 && token !== null && SESSION_ID.test(token) ? token : null;
}
