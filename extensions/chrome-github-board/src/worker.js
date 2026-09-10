// @ts-check
/**
 * Relay between one native bridge port and board tabs. Recover from worker shutdown through alarms, tab
 * reconnects. Replay snapshots only from the current native connection.
 */
import { makeLogSpool } from './state.js';
import { LOGINS_KEY, allowsProject, watchPreferences } from './preferences.js';

const NATIVE_HOST = 'com.groundcontrol.ground_control';
const KEEPALIVE = 'gc-keepalive';

/** @type {Set<chrome.runtime.Port>} */
const boards = new Set();
/** @type {Set<chrome.runtime.Port>} */
const watchers = new Set();
/** @type {Map<chrome.runtime.Port, { board: boolean, focused: boolean, visible: boolean, pathname: string, token: number }>} */
const reports = new Map();
/** @type {import('./preferences.js').Preferences | null} */
let preferences = null;

/**
 * Keep log subscribers and history in memory through makeLogSpool. Reconnecting tabs restore subscriptions;
 * durable hub logs remain in the hub file.
 */
const spool = makeLogSpool();

/** @type {chrome.runtime.Port | null} */
let native = null;

/** Replay the latest hub snapshot to newly connected tabs. */
let last = null;

/** Recheck browser preferences on every delivery. A permitted tab holds the hub connection open (R36). */
function permitted(port) {
  const report = reports.get(port);
  return report !== undefined && report.board && allowsProject(preferences, report.pathname);
}

/** A permitted tab whose board is also filtered to the developer: the only kind anything is delivered to (R36). */
function served(port) {
  return permitted(port) && reports.get(port)?.focused === true;
}

function send(port, message, token = reports.get(port)?.token) {
  if (!boards.has(port) || !served(port) || token !== reports.get(port)?.token) return;
  try { port.postMessage({ ...message, pageToken: token }); } catch { /* The tab closed. */ }
}

/** Where every tab starts, and where the worker returns when the last board closes and it drops the native port. */
const UNANSWERED = 'Waiting for the Ground Control hub.';

/** Keep one connection-status value so new tabs receive the current state during native-port startup. */
let trouble = UNANSWERED;

function troubled(message) {
  trouble = message;
  say(message === null ? 'info' : 'warn', message ?? 'hub connection restored', 'native');
  broadcast({ type: 'trouble', message });
}

/** The overlay's own narration, kept whether or not anybody is looking, and sent on to whoever is (R40). */
function say(level, message, scope) {
  const entry = { at: new Date().toISOString(), level, source: 'browser', message, ...(scope ? { scope } : {}) };

  spool.hold([entry]);
  toWatchers({ type: 'log', entries: [entry] });
}

function toWatchers(message) {
  for (const watcher of /** @type {Iterable<chrome.runtime.Port>} */ (spool.viewers())) {
    send(watcher, message);
  }
}

/** Hold the hub's assignee logins so the filter gate can name the developer before any snapshot arrives (R36). */
let cachedLogins = '';

/** @param {unknown} owners */
function cacheLogins(owners) {
  const logins = Array.isArray(owners) ? owners.filter((login) => typeof login === 'string' && login.length > 0) : [];
  const signature = logins.join(',');

  if (signature === cachedLogins) return;
  cachedLogins = signature;
  void chrome.storage.local.set({ [LOGINS_KEY]: logins }).catch(() => {
    // A refused write leaves the gate on the viewer's own login; it is a cache, not the source.
    cachedLogins = '';
  });
}

function broadcast(message) {
  for (const board of boards) {
    send(board, message);
  }
}

function toNative(message) {
  // Log successful sends accurately; a missing port must not be reported as a delivered message.
  if (native === null) {
    say('warn', `cannot send ${message?.type}: hub port disconnected`, 'native');

    return;
  }

  say('debug', `sent ${message?.type} to the hub`, 'native');

  try {
    native.postMessage(message);
  } catch {
    // The bridge went away. `onDisconnect` is what tells the tabs; a throw here would take the worker down.
  }
}

function connectNative() {
  if (native !== null) {
    return;
  }

  say('info', 'opening the native port', 'native');

  try {
    native = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (error) {
    troubled(`Ground Control is not registered with this browser: ${String(error)}`);

    return;
  }

  const connected = native;
  connected.onMessage.addListener((message) => {
    if (native !== connected) return;
    if (message.type === 'trouble') {
      if (message.message !== null) last = null;
      troubled(message.message);
      return;
    }
    // Clear trouble only on a native-port response; a cached snapshot does not establish liveness (R24).
    if (trouble !== null) {
      troubled(null);
    }

    // Send hub log lines only to tabs with open log sidebars.
    if (message.type === 'log') {
      const entries = message.entries ?? [];

      // Always retain bridge logs. Retain hub logs only while subscribed, discarding lines still in transit
      // after unsubscribe.
      spool.hold(spool.watching() ? entries : entries.filter((entry) => entry.source !== 'hub'));
      toWatchers(message);

      return;
    }

    if (message.type === 'snapshot' || message.type === 'changed') {
      last = message;
      cacheLogins(message.snapshot?.owners);
    }

    broadcast(message);
  });

  connected.onDisconnect.addListener(() => {
    if (native !== connected) return;
    native = null;
    last = null;
    troubled('Disconnected from Ground Control. Enable the GitHub overlay from VS Code, or open the board there.');
  });

  // Restore watching and log subscriptions whenever the native port reopens, including alarm-driven
  // reconnects without a tab event.
  toNative({ type: 'watching', watching: watchers.size > 0 });

  if (spool.watching()) {
    // Announce repeated backfill before requesting the tail, which may duplicate displayed lines.
    say('info', 'resubscribing to hub logs; replaying recent entries', 'logs');
    toNative({ type: 'watchLog', watching: true });
  }
}

/**
 * Subscribe on the first sidebar open and unsubscribe on the last close. Additional sidebars receive the
 * buffered history without another hub backfill.
 *
 * @param {chrome.runtime.Port} port
 * @param {boolean} open
 */
function watchLog(port, open) {
  const { tell, backlog } = spool.view(port, open && permitted(port));

  // Send backlog before new subscription log lines so each line arrives once.
  if (backlog.length > 0) {
    send(port, { type: 'log', entries: backlog });
  }

  if (tell === null) {
    return;
  }

  toNative({ type: 'watchLog', watching: tell });
  say(
    'info',
    tell ? 'log sidebar opened' : 'last log sidebar closed',
    'logs',
  );
}

/** Prior connections may have used a different session scope. Wait for a fresh hub snapshot. */
function replay(port) {
  const token = reports.get(port)?.token;
  send(port, { type: 'trouble', message: trouble }, token);
  if (last !== null) send(port, last, token);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'gc-board') {
    return;
  }

  // Only this extension's GitHub content scripts may register project state.
  try {
    if (new URL(port.sender?.url ?? '').origin !== 'https://github.com') return;
  } catch { return; }
  reports.set(port, { board: false, focused: false, visible: false, pathname: '', token: 0 });

  port.onMessage.addListener((message) => {
    if (message?.type === 'boardState') {
      const previous = reports.get(port);
      if (!previous || typeof message.pathname !== 'string' || !Number.isSafeInteger(message.token) || message.token < 0) return;
      reports.set(port, { board: message.board === true, focused: message.focused === true, visible: message.visible === true, pathname: message.pathname, token: message.token });
      applyBoard(port, previous.token !== message.token || previous.pathname !== message.pathname);
      return;
    }

    if (!boards.has(port) || !permitted(port)) return;

    if (message?.type === 'openOptions') {
      void chrome.runtime.openOptionsPage();
      return;
    }

    if (message?.type === 'logView') {
      watchLog(port, message.open === true);

      return;
    }

    // Only aggregate visibility may reach the hub.
    if (message?.type !== 'watching') toNative(message);
  });
  port.onDisconnect.addListener(() => {
    // Read lastError to acknowledge expected port closure when Chrome caches a page in back/forward history.
    void chrome.runtime.lastError;

    boards.delete(port);
    reports.delete(port);
    servedPorts.delete(port);
    watchers.delete(port);
    watchLog(port, false);
    say('debug', `board tab disconnected; ${boards.size} open`, 'tabs');

    reconcile();
  });
});

function reconcile() {
  if (boards.size === 0) {
    if (native !== null) {
      toNative({ type: 'watching', watching: false });
      const disconnected = native;
      native = null;
      last = null;
      disconnected.disconnect();
    }
    troubled(UNANSWERED);
  } else if (native === null) connectNative();
  else toNative({ type: 'watching', watching: watchers.size > 0 });
}

/** Tabs already sent a snapshot for their current filter state, so one that becomes served is replayed once. */
const servedPorts = new Set();

function applyBoard(port, changed = false, immediately = true) {
  const joined = (permitted(port) && !boards.has(port)) || (served(port) && !servedPorts.has(port));
  if (served(port)) servedPorts.add(port);
  else servedPorts.delete(port);
  if (permitted(port)) boards.add(port);
  else {
    boards.delete(port);
    watchLog(port, false);
  }
  if (boards.has(port) && served(port) && reports.get(port)?.visible) watchers.add(port);
  else watchers.delete(port);
  if (immediately) {
    reconcile();
    if (joined || (changed && boards.has(port))) replay(port);
  }
}

watchPreferences(chrome.storage, (next) => {
  preferences = next.value;
  for (const port of reports.keys()) applyBoard(port, false, false);
  reconcile();
  for (const port of boards) replay(port);
});

chrome.alarms.create(KEEPALIVE, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE && boards.size > 0) {
    connectNative();
  }
});
