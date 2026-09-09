# Ground Control GitHub overlay

Adds local lane, triage, and session information to matching issue cards on GitHub Projects. Uses the same hub snapshot as the VS Code board. Displays phase, duration, attention, failures, and freshness.

Session links open the connected editor in its own URI scheme, so an Insiders developer's links open Insiders; without a connected editor the last reported scheme applies, and `vscode` is the default. Checkout opening requires a connected editor. The overlay can move local lanes and read logs; it cannot start or stop work, request classification, select filesystem paths, or open combined diffs. See [R36](../../docs/prd.md#r36-github-overlay).

## Loading

1. Run **Ground Control: Enable GitHub Overlay** in VS Code to register the native host and launcher for the browsers in `groundControl.overlayBrowsers` (Google Chrome by default, Microsoft Edge optional). **Ground Control: Disable GitHub Overlay** removes every registration Ground Control made; uninstall does too.
2. Enable Developer mode at `chrome://extensions` or `edge://extensions` and load this directory unpacked. The manifest key fixes the extension ID, so one host manifest content serves both browsers.

There is no build step. The manifest's public key fixes the extension ID used by native-host registration. After reloading the extension, reload existing GitHub tabs to replace invalidated content scripts.

## Preferences

Open **Overlay settings** from the overlay menu, or **Extension options** from Chrome's extension details. **Enable overlay** defaults to on. **Allowed project URLs** accepts one HTTPS GitHub project URL per line; an empty list allows all supported projects. Organization and personal projects are distinct, and project numbers match exactly. View URLs and query strings normalize to their project URL.

Preferences use durable extension storage and apply across open tabs immediately. Disabled or disallowed pages remove the overlay, restore GitHub's header and assignee display, stop logs, and do not count as watchers or retain a hub connection. Hidden allowed project tabs can retain requested logs but do not start hub polling or automatic work. Invalid or unreadable preferences pause access until corrected.

**Animate working borders and session names** (default on) and **Replace assignee avatars with the pull request author in review** (default on) are browser-local presentation choices. Turning replacement off restores GitHub's assignee figure on open boards; turning animation off keeps the static dashed working border and accessible names. The system reduced-motion preference applies regardless.

**Open shared settings in VS Code** links to the editor settings used by both clients. This static link uses the `vscode://` scheme, so on a machine with only Insiders it opens nothing; open the settings there directly. The browser options page changes only browser preferences; it cannot configure the hub or dispatch work.

## Implementation

| File | Responsibility | Verification |
|---|---|---|
| `src/overlay.js` | DOM matching, card rendering, menus, tooltips, and log panel | Vitest/jsdom and browser behavior tests |
| `src/state.js` | Snapshot state, retries, and log subscriptions | Vitest |
| `src/preferences.js` | Project eligibility, validation, and preference updates | Vitest and browser tests |
| `options.html`, `src/options.js` | Browser preference editor and shared-settings link | Headless Playwright |
| `src/content.js` | Worker port, observer, and repaint scheduling | Headless Playwright |
| `src/worker.js` | Native port, tab ports, current snapshot, and reconnect alarm | Headless Playwright |

The content script injects across github.com to support soft navigation, but renders only on enabled, allowed project roots and their `/views/<number>` pages. Both content and worker enforce eligibility before rendering or delivering data. JSDoc checks snapshot types against core. Unchanged footers are retained by card node and content signature; GitHub view changes replace nodes and require rebuilding.

The worker connects through native messaging and makes no direct GitHub API requests. Snapshots and log lines remain in memory. After either the bridge or hub disconnects, a fresh hub snapshot must arrive before tabs receive session data; snapshots from prior connections are discarded. An already displayed disconnected board remains marked stale. The first sidebar subscribes to hub logs; the last closing sidebar unsubscribes and discards hub backfill.

**Show log** opens browser and hub diagnostics with source filters. Outside click closes it unless pinned. Refused-request origins are redacted, but other private operational text may remain visible to GitHub page scripts. See [data boundaries](../../docs/architecture.md#data-boundaries).

[Testing](../../docs/testing.md#chrome-integration) describes isolated extension loading, offline fixture routes, and native-host precautions.
