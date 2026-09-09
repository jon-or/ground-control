// @ts-check
/**
 * Relay between one native bridge port and board tabs. Recover from worker shutdown through alarms, tab
 * reconnects, and snapshots in chrome.storage.session.
 */
import { makeLogSpool } from './state.js';

const NATIVE_HOST = 'com.groundcontrol.ground_control';
const KEEPALIVE = 'gc-keepalive';

/** @type {Set<chrome.runtime.Port>} */
const boards = new Set();

/**
 * Keep log subscribers and history in memory through makeLogSpool. Reconnecting tabs restore subscriptions;
 * durable hub logs remain in the hub file.
 */
const spool = makeLogSpool();

/** @type {chrome.runtime.Port | null} */
let native = null;

/** Replay the latest hub snapshot to newly connected tabs. */
let last = null;

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
    try {
      watcher.postMessage(message);
    } catch {
      // A tab that closed between the loop and the send. Its disconnect is already on its way.
    }
  }
}

function broadcast(message) {
  for (const board of boards) {
    try {
      board.postMessage(message);
    } catch {
      // A tab that closed between the loop and the send. Its disconnect is already on its way.
    }
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

  native.onMessage.addListener((message) => {
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
      void chrome.storage.session.set({ last: message });
    }

    broadcast(message);
  });

  native.onDisconnect.addListener(() => {
    native = null;
    troubled('Disconnected from Ground Control. Enable the GitHub overlay from VS Code, or open the board there.');
  });

  // Restore watching and log subscriptions whenever the native port reopens, including alarm-driven
  // reconnects without a tab event.
  toNative({ type: 'watching', watching: boards.size > 0 });

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
  const { tell, backlog } = spool.view(port, open);

  // Send backlog before new subscription log lines so each line arrives once.
  if (backlog.length > 0) {
    try {
      port.postMessage({ type: 'log', entries: backlog });
    } catch {
      // A tab that closed in the same turn it asked. Its disconnect takes it back out of the spool.
    }
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

/** What a tab is shown before the hub has answered: the last reading, and the fact that it is only that. */
function replay(port) {
  port.postMessage({ type: 'trouble', message: trouble });

  if (last !== null) {
    port.postMessage(last);

    return;
  }

  void chrome.storage.session.get('last').then((held) => {
    if (held.last) {
      last = held.last;
      port.postMessage(held.last);
    }
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'gc-board') {
    return;
  }

  boards.add(port);
  say('debug', `a board tab connected; ${boards.size} open`, 'tabs');

  port.onMessage.addListener((message) => {
    if (message?.type === 'logView') {
      watchLog(port, message.open === true);

      return;
    }

    toNative(message);
  });
  port.onDisconnect.addListener(() => {
    // Read lastError to acknowledge expected port closure when Chrome caches a page in back/forward history.
    void chrome.runtime.lastError;

    boards.delete(port);
    watchLog(port, false);
    say('debug', `board tab disconnected; ${boards.size} open`, 'tabs');

    // Stop polling after the last board tab closes; the hub remains available during its 30-minute idle
    // timeout (R35).
    if (boards.size === 0) {
      toNative({ type: 'watching', watching: false });
      native?.disconnect();
      native = null;
      troubled(UNANSWERED);
    }
  });

  connectNative();
  // Update watching on the first tab connection if the port was already open; additional tabs do not change
  // it.
  toNative({ type: 'watching', watching: true });
  replay(port);
});

chrome.alarms.create(KEEPALIVE, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE && boards.size > 0) {
    connectNative();
  }
});
