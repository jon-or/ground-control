// @ts-check
/**
 * Connect to Chrome, observe board mutations, and schedule rendering. State decisions remain in state.js;
 * GitHub view switches replace card nodes (mechanics M27).
 */
(() => {
  const url = chrome.runtime.getURL('src/');

  /** @type {any} */
  let overlay = null;
  /** @type {any} */
  let helpers = null;
  /** @type {any} */
  let policy = null;
  /** @type {import('./preferences.js').Preferences | null} */
  let preferences = null;
  let identity = null;
  /** @type {string[]} Assignee logins from the hub, cached by the worker; the viewer's own login is read per page. */
  let logins = [];
  /** The last filter decision, held while the developer is still typing in the filter box. */
  let focused = false;
  let pageToken = 0;
  let replayed = false;

  /** @type {any} */
  let state = null;
  /** @type {chrome.runtime.Port | null} */
  let port = null;
  let attempt = 0;
  let scheduled = false;
  let reconnecting = false;
  /** Set once the extension this script belongs to is gone: nothing in this tab can reach the new one. */
  let stopped = false;
  /** The scan and the duration tick, held so an orphaned script can stop them: both re-arm the observer. */
  const timers = [];
  /** What the worker was last told about the sidebar, restated on every connect: a restarted worker holds nothing. */
  let watchingLog = false;
  let reported = '';

  /** A project the preferences allow. The hub connection follows this, so the gate below can learn the logins. */
  function onProject() {
    return policy !== null && policy.allowsProject(preferences, location.pathname);
  }

  function eligible() {
    return onProject() && filteredToMe();
  }

  /**
   * R36: with the preference on, the overlay runs only where the board's filter restricts it to the developer.
   * The filter box holds unapplied keystrokes, so a focused box keeps the last decision rather than judging each one.
   */
  function filteredToMe() {
    if (preferences?.filteredToMe !== true) return true;
    if (document.activeElement === overlay.filterBox(document)) return focused;

    focused = policy.filtersToMe(overlay.filterText(document), [overlay.viewerLogin(document), ...logins].filter(Boolean));

    return focused;
  }

  // Policy changes must clear hidden tabs without waiting for a suspended animation frame.
  function syncPage() {
    const next = eligible() ? policy.projectPath(location.pathname) : null;
    if (next === identity) return;
    identity = next;
    pageToken++;
    replayed = false;
    observer.disconnect();
    if (watchingLog) {
      watchingLog = false;
      post({ type: 'logView', open: false });
    }
    overlay.clear(document);
    state = helpers.initialState();
    if (!stopped) observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Visibility reporting cannot wait for a frame: Chrome suspends frames in hidden tabs.
  function report() {
    if (helpers === null || stopped) return;
    syncPage();
    const board = onProject();
    const watched = eligible();
    const visible = document.visibilityState === 'visible';
    const next = `${location.pathname}:${board}:${watched}:${visible}:${pageToken}`;
    if (next === reported || port === null) return;
    reported = next;
    post({ type: 'boardState', board, focused: watched, visible, pathname: location.pathname, token: pageToken });
  }

  const observer = new MutationObserver(() => schedule());

  const actions = {
    refresh: () => post({ type: 'refresh' }),
    move: (key, lane) => post({ type: 'move', key, lane }),
    openCheckout: (key) => post({ type: 'openCheckout', key }),
    retriage: (key) => post({ type: 'retriage', key }),
    openOptions: () => post({ type: 'openOptions' }),
    repaint: () => schedule(),
    watchLog: (open) => {
      if (open && !eligible()) return;
      watchingLog = open;
      post({ type: 'logView', open });
    },
  };

  function post(message) {
    if (message.type !== 'boardState' && !(message.type === 'logView' && message.open === false) && !eligible()) return;
    try {
      port?.postMessage(message);
    } catch {
      // The worker went away between the click and the send. `onDisconnect` reconnects; the queue is the hub's job.
    }
  }

  /** Coalesce renders to one frame and pause the observer during writes to prevent mutation loops. */
  function schedule() {
    report();
    if (scheduled || overlay === null || !eligible() || !replayed) {
      return;
    }

    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      observer.disconnect();

      try {
        syncPage();
        if (eligible() && replayed) {
          overlay.paint(document, state, Date.now(), actions, policy.presentationOf(preferences));
        } else {
          overlay.clear(document);

          // Unsubscribe from hub logs when leaving the board (R40).
          if (watchingLog) {
            actions.watchLog(false);
          }
        }
      } finally {
        if (!stopped) {
          observer.observe(document.documentElement, { childList: true, subtree: true });
        }
      }
    });
  }

  /**
   * The port is gone, and `state.js` says whether that is worth answering. An orphaned script paints the line once
   * more and then holds still: an observer or a scan timer left running repaints a snapshot frozen at the reload.
   */
  function lost() {
    const { retry, trouble } = helpers.disconnection(chrome.runtime);

    port = null;
    stopped = !retry;
    state = helpers.applyMessage(state, { type: 'trouble', message: trouble });
    schedule();

    if (retry) {
      later();

      return;
    }

    observer.disconnect();

    for (const timer of timers) {
      clearInterval(timer);
    }
  }

  /**
   * Reconnected, not merely reported. Chrome stops an idle MV3 worker, which drops this port; without this the
   * overlay would sit on "lost its connection" until the tab was reloaded, and the worker's own alarm cannot help —
   * it reconnects the native port only while a board tab is registered, and this is what registers one.
   */
  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'gc-board' });
    } catch {
      // Reloaded between the disconnect and this retry: `chrome.runtime` is still an object, and calls on it throw.
      reconnecting = false;
      lost();

      return;
    }

    reconnecting = false;
    reported = '';
    report();

    port.onMessage.addListener((message) => {
      report();
      if (!eligible() || message.pageToken !== pageToken) return;
      replayed = true;
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

    port.onDisconnect.addListener(() => lost());

    // Chrome stops an idle worker, which loses every tab it had streaming. A sidebar the developer left open has to
    // say so again, or it sits there showing the lines from before the worker went and no others.
    if (watchingLog && eligible()) {
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

  void Promise.all([import(`${url}overlay.js`), import(`${url}state.js`), import(`${url}preferences.js`)]).then(([drawing, decisions, preferencesModule]) => {
    overlay = drawing;
    helpers = decisions;
    policy = preferencesModule;
    state = helpers.initialState();
    connect();
    policy.watchPreferences(chrome.storage, (next) => {
      preferences = next.value;
      schedule();
    });
    policy.watchLogins(chrome.storage, (next) => {
      logins = next;
      schedule();
    });
    schedule();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener('visibilitychange', schedule);
  document.addEventListener('turbo:load', schedule);
  window.addEventListener('popstate', schedule);

  // A card that has not changed produces no mutation, so the board is rescanned on its own clock for anything the
  // snapshot moved. Structure only — the durations advance below, and rebuilding a footer every second to move a
  // number would fight the observer that watches for one.
  timers.push(setInterval(schedule, 10_000));

  // R5: the number advances once a second, in place, so a duration never reads as though it stopped when the last
  // scan did. Disarmed while it writes, the same way painting and appending a log line are: the value goes into a
  // text node it already had, but an observer armed over a write of its own is what schedules a scan per second.
  timers.push(
    setInterval(() => {
      if (overlay === null || !eligible()) {
        return;
      }

      observer.disconnect();

      try {
        overlay.tickDurations(document, Date.now());
      } finally {
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
    }, 1_000),
  );
})();
