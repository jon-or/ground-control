// @ts-check
/**
 * The MV3 worker: one native port to the bridge, one port per board tab, and the relay between them. Chrome stops a
 * worker that has been idle, so nothing here assumes it lives — the alarm reopens the native port, a content script
 * reconnecting registers its tab again, and the last snapshot survives in `chrome.storage.session`.
 */
import { makeLogSpool } from './state.js';

const NATIVE_HOST = 'com.groundcontrol.ground_control';
const KEEPALIVE = 'gc-keepalive';

/** @type {Set<chrome.runtime.Port>} */
const boards = new Set();

/**
 * The board tabs with the log sidebar open, and the lines to hand the next one that opens. Memory only, and never
 * `chrome.storage.session`: the hub's own file is the durable copy, a worker Chrome stopped is answered by the
 * reconnecting tab asking again, and a log is not something to leave lying about in browser storage. What it
 * decides — when the hub is asked for its log and when it is told to stop — is `makeLogSpool` in `state.js`.
 */
const spool = makeLogSpool();

/** @type {chrome.runtime.Port | null} */
let native = null;

/** The last thing the hub said, replayed to a tab that opens while the worker already has it. */
let last = null;

/** Where every tab starts, and where the worker returns when the last board closes and it drops the native port. */
const UNANSWERED = 'Ground Control has not answered yet.';

/**
 * What the overlay's staleness line says now. One string rather than a message sent from each place that changes
 * it: a tab connects while the port is opening, so whichever of the two spoke last would otherwise be what it sees.
 */
let trouble = UNANSWERED;

function troubled(message) {
  trouble = message;
  say(message === null ? 'info' : 'warn', message ?? 'the hub is answering again', 'native');
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
  // Said as what actually happened, not as what was attempted: a developer opens the sidebar because the overlay
  // has gone quiet, and a panel claiming the hub was told something while there was no port is the wrong answer to
  // the one question it exists for.
  if (native === null) {
    say('warn', `nothing to send ${message?.type} to: there is no port to the hub`, 'native');

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
    // Cleared here rather than by the tab that receives the snapshot: what a tab is handed may be a replay from
    // storage, which is a real reading and an old one. Only the port answering says the board is live (R24).
    if (trouble !== null) {
      troubled(null);
    }

    // Only ever the sidebars, and only what they asked for. It never reaches `boards`: a tab with no log open is
    // not sent the hub's lines, and this is the only message the two sets are treated differently for.
    if (message.type === 'log') {
      const entries = message.entries ?? [];

      // The bridge's own lines are this browser's half and are kept whatever happens; the hub's are kept only while
      // somebody is watching, because the unsubscribe is a round trip and what is still in flight when it lands
      // would otherwise sit in the spool and come back beside a fresh tail.
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
    troubled('Ground Control is not running. Enable the GitHub overlay from VS Code, or open the board there.');
  });

  // A reopened port is a new bridge process and so a new client of the hub, which knows nothing about this browser.
  // Restated here rather than where a tab connects, because the alarm reopens the port with no tab involved: what
  // the hub would otherwise have is a client that never said it was watching and never asked for the log.
  toNative({ type: 'watching', watching: boards.size > 0 });

  if (spool.watching()) {
    // Said before the ask, because what comes back is the whole tail of the file and most of it is already on
    // screen: a hundred lines repeating themselves with nothing between them reads as the hub looping.
    say('info', 'asking the hub for its log again; what follows is the file from the top', 'logs');
    toNative({ type: 'watchLog', watching: true });
  }
}

/**
 * One tab's sidebar opening or closing. The hub is told only on the first open and the last close, so it holds one
 * subscription per machine — telling it again would have it backfill, and every other sidebar would show the file's
 * tail a second time. A tab opening the second sidebar is handed what this worker already holds instead.
 *
 * @param {chrome.runtime.Port} port
 * @param {boolean} open
 */
function watchLog(port, open) {
  const { tell, backlog } = spool.view(port, open);

  // The spool hands back what this tab missed, and only on the transition. Sent before the two lines below, which
  // it deliberately does not contain — those reach the tab live, once, rather than here and again a moment later.
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
    tell ? 'a log sidebar opened; the hub has been asked for its log' : 'the last log sidebar closed; the hub is not read',
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
    // Chrome closes the port of a page it moves into the back/forward cache and sets `lastError` on the way; reading
    // it is what marks it read, and an unread one is logged to the worker's console as an unchecked error.
    void chrome.runtime.lastError;

    boards.delete(port);
    watchLog(port, false);
    say('debug', `a board tab went; ${boards.size} open`, 'tabs');

    // No board tab is looking, so nothing on this machine needs polling. The hub keeps its own half-hour before it
    // exits, so a tab reopened a minute later reaches the one that was already up (R35).
    if (boards.size === 0) {
      toNative({ type: 'watching', watching: false });
      native?.disconnect();
      native = null;
      troubled(UNANSWERED);
    }
  });

  connectNative();
  // Only reached when the port was already open, and so was not restated above. A second tab arriving is not a
  // change of state, but the first one after an idle worker woke without one is.
  toNative({ type: 'watching', watching: true });
  replay(port);
});

chrome.alarms.create(KEEPALIVE, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE && boards.size > 0) {
    connectNative();
  }
});
