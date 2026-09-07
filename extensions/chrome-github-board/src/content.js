// @ts-check
/**
 * The half of the overlay that talks to Chrome. It holds the last thing the worker sent and repaints whenever the
 * board changes under it — a project board is React, and a view switch replaces every card node (`mechanics.md` §27).
 * Every decision it makes is in `state.js`; what is here is the port, the observer, and when to try again.
 */
(() => {
  const url = chrome.runtime.getURL('src/');

  /** @type {any} */
  let overlay = null;
  /** @type {any} */
  let helpers = null;

  /** @type {any} */
  let state = null;
  /** @type {chrome.runtime.Port | null} */
  let port = null;
  let attempt = 0;
  let scheduled = false;
  let reconnecting = false;
  /** What the worker was last told about the sidebar, restated on every connect: a restarted worker holds nothing. */
  let watchingLog = false;

  const observer = new MutationObserver(() => schedule());

  const actions = {
    refresh: () => post({ type: 'refresh' }),
    move: (key, lane) => post({ type: 'move', key, lane }),
    repaint: () => schedule(),
    watchLog: (open) => {
      watchingLog = open;
      post({ type: 'logView', open });
    },
  };

  function post(message) {
    try {
      port?.postMessage(message);
    } catch {
      // The worker went away between the click and the send. `onDisconnect` reconnects; the queue is the hub's job.
    }
  }

  /**
   * Coalesced to one frame, and the observer is off while painting: the badges are DOM changes of our own, and an
   * observer left armed would see them and schedule the next scan forever.
   */
  function schedule() {
    if (scheduled || overlay === null) {
      return;
    }

    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      observer.disconnect();

      try {
        if (helpers.isBoardPath(location.pathname)) {
          overlay.paint(document, state, Date.now(), actions);
        } else {
          overlay.clear(document);

          // The sidebar went with the board, so the hub stops being read: a tab on some other page of github.com is
          // not a viewer, and nothing about the hub's log crosses to one (R40).
          if (watchingLog) {
            actions.watchLog(false);
          }
        }
      } finally {
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
    });
  }

  /**
   * Reconnected, not merely reported. Chrome stops an idle MV3 worker, which drops this port; without this the
   * overlay would sit on "lost its connection" until the tab was reloaded, and the worker's own alarm cannot help —
   * it reconnects the native port only while a board tab is registered, and this is what registers one.
   */
  function connect() {
    port = chrome.runtime.connect({ name: 'gc-board' });
    reconnecting = false;

    port.onMessage.addListener((message) => {
      attempt = 0;

      // Appended rather than repainted, and the observer is off while it happens: a line is a DOM change of our
      // own, and one left armed would schedule a whole board scan per line of a burst.
      if (message.type === 'log') {
        observer.disconnect();

        try {
          overlay.appendLog(document, message.entries ?? []);
        } finally {
          observer.observe(document.documentElement, { childList: true, subtree: true });
        }

        return;
      }

      state = helpers.applyMessage(state, message);
      schedule();
    });

    port.onDisconnect.addListener(() => {
      port = null;
      state = helpers.applyMessage(state, {
        type: 'trouble',
        message: 'The overlay lost its connection to Ground Control.',
      });
      schedule();
      later();
    });

    // Chrome stops an idle worker, which loses every tab it had streaming. A sidebar the developer left open has to
    // say so again, or it sits there showing the lines from before the worker went and no others.
    if (watchingLog) {
      post({ type: 'logView', open: true });
    }
  }

  function later() {
    if (reconnecting) {
      return;
    }

    reconnecting = true;
    attempt += 1;
    setTimeout(connect, helpers.retryDelay(attempt));
  }

  void Promise.all([import(`${url}overlay.js`), import(`${url}state.js`)]).then(([drawing, decisions]) => {
    overlay = drawing;
    helpers = decisions;
    state = helpers.initialState();
    connect();
    schedule();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  // A card that has not changed produces no mutation, so the board is rescanned on its own clock for anything the
  // snapshot moved. Structure only — the durations advance below, and rebuilding a footer every second to move a
  // number would fight the observer that watches for one.
  setInterval(schedule, 10_000);

  // R5: the number advances once a second, in place, so a duration never reads as though it stopped when the last
  // scan did. Nothing else on the page is touched, so this schedules no scan of its own.
  setInterval(() => {
    if (overlay !== null && helpers.isBoardPath(location.pathname)) {
      overlay.tickDurations(document, Date.now());
    }
  }, 1_000);
})();
