// @ts-check
/**
 * The MV3 worker: one native port to the bridge, one port per board tab, and the relay between them. Chrome stops a
 * worker that has been idle, so nothing here assumes it lives — the alarm reopens the native port, a content script
 * reconnecting registers its tab again, and the last snapshot survives in `chrome.storage.session`.
 */
const NATIVE_HOST = 'com.ownerrez.ground_control';
const KEEPALIVE = 'gc-keepalive';

/** @type {Set<chrome.runtime.Port>} */
const boards = new Set();

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
  broadcast({ type: 'trouble', message });
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
  try {
    native?.postMessage(message);
  } catch {
    // The bridge went away. `onDisconnect` is what tells the tabs; a throw here would take the worker down.
  }
}

function connectNative() {
  if (native !== null) {
    return;
  }

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
  port.onMessage.addListener((message) => toNative(message));
  port.onDisconnect.addListener(() => {
    boards.delete(port);

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
  toNative({ type: 'watching', watching: true });
  replay(port);
});

chrome.alarms.create(KEEPALIVE, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE && boards.size > 0) {
    connectNative();
  }
});
