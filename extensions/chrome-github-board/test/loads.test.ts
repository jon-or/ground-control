import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME_EXTENSION_ID } from '@ground-control/core';
import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';

/**
 * What jsdom cannot answer: whether Chrome loads this directory at all, whether the content script's matches fire on
 * a project board, whether the worker starts, and whether the overlay module the content script imports is actually
 * reachable as a web-accessible resource. Every one of those is a manifest mistake that leaves no error anywhere a
 * unit test looks.
 */
const EXTENSION = join(__dirname, '..');
const BOARD = readFileSync(join(__dirname, 'fixtures', 'project-board.html'), 'utf8');

/**
 * The recorded board, served in place of GitHub's. It has to be answered at a `github.com` URL rather than a
 * `file://` one, because a content script's `matches` are the page's URL — off github.com nothing runs at all — and
 * the fulfilment is local, so the no-network rule holds.
 */
const BOARD_URL = 'https://github.com/orgs/example-org/projects/3/views/1';

/** Every other page on the site the content script is injected across, and must leave alone. */
const ISSUE_URL = 'https://github.com/example-org/example-repo/issues/4501';

interface Manifest {
  key: string;
  permissions: string[];
  background: { service_worker: string; type: string };
  content_scripts: { matches: string[]; js: string[] }[];
  web_accessible_resources: { resources: string[]; matches: string[] }[];
}

function manifest(where: string): Manifest {
  return JSON.parse(readFileSync(join(where, 'manifest.json'), 'utf8')) as Manifest;
}

/**
 * The shipped manifest is what Chrome is handed, and nothing below reads it — so it is asserted here, whole. A
 * permission added by hand is the extension asking for more of the developer's browser than it was reviewed for.
 */
describe('what the extension asks Chrome for', () => {
  const shipped = manifest(EXTENSION);

  it('asks for nothing beyond the bridge, the alarm and its own storage', () => {
    expect(shipped.permissions).toEqual(['nativeMessaging', 'alarms', 'storage']);
    expect(shipped).not.toHaveProperty('host_permissions');
  });

  /**
   * The whole site, because a board reached by clicking through it is a soft navigation Chrome injects nothing for
   * (`mechanics.md` §27). `isBoardPath` is what keeps the overlay off every other page, and the test below is what
   * proves it does.
   */
  it('runs its content script on github.com and nowhere else', () => {
    expect(shipped.content_scripts).toHaveLength(1);
    expect(shipped.content_scripts[0]?.matches).toEqual(['https://github.com/*']);
    expect(shipped.content_scripts[0]?.js).toEqual(['src/content.js']);
  });

  /** The content script imports both at runtime. A resource left out of this list resolves to nothing, silently. */
  it('lets the page reach the two modules the content script imports', () => {
    expect(shipped.web_accessible_resources[0]?.resources).toEqual(['src/overlay.js', 'src/state.js']);
  });
});

describe('the overlay as Chrome loads it', () => {
  let profile = '';
  let loaded = '';
  let context: BrowserContext;

  beforeAll(async () => {
    profile = mkdtempSync(join(tmpdir(), 'gc-chrome-'));

    /**
     * A copy with `nativeMessaging` taken out. A native host is registered per user rather than per profile, so on
     * a machine where the developer has enabled the overlay the worker would reach their real bridge, start a hub
     * against their real home, and this test would assert against their board. Without the permission the connect
     * throws, the worker says so, and every machine behaves the same way.
     */
    loaded = mkdtempSync(join(tmpdir(), 'gc-ext-'));
    cpSync(EXTENSION, loaded, {
      recursive: true,
      filter: (from) => !from.includes('node_modules') && !from.includes('coverage'),
    });

    const stripped = manifest(loaded);

    stripped.permissions = stripped.permissions.filter((name) => name !== 'nativeMessaging');
    writeFileSync(join(loaded, 'manifest.json'), JSON.stringify(stripped, null, 2));

    // Read back rather than assumed: a filter that stopped matching would leave this suite reaching the developer's
    // own bridge, and passing everywhere else.
    if (manifest(loaded).permissions.includes('nativeMessaging')) {
      throw new Error('The copy under test can still reach a native host.');
    }

    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${loaded}`, `--load-extension=${loaded}`],
    });

    await context.route('https://github.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: BOARD }),
    );
  });

  afterAll(async () => {
    await context?.close();

    // Named only once each is minted: a `beforeAll` that threw before then would otherwise take this down with it
    // and lose whatever went wrong.
    for (const made of [profile, loaded]) {
      if (made !== '') {
        rmSync(made, { recursive: true, force: true });
      }
    }
  });

  /**
   * Chrome derives the id from the public `key` in the manifest, and the native host lets in exactly one origin
   * built from `CHROME_EXTENSION_ID`. Nowhere else can see the real id, so asserting it against the constant the
   * source already uses would prove nothing — this is the only place the two are compared.
   */
  it('starts its background worker, at the id the native host lets in', async () => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

    expect(worker.url()).toBe(`chrome-extension://${CHROME_EXTENSION_ID}/src/worker.js`);
  });

  it('paints itself onto a project board and says it cannot reach the hub', async () => {
    const page = await context.newPage();

    await page.goto(BOARD_URL);

    const toast = page.locator('#gc-toasts .gc-toast');

    await expect.poll(() => page.locator('#gc-menu').count(), { timeout: 20_000 }).toBe(1);

    // The worker cannot open its port to the bridge here. What the developer must see is that the badges are
    // missing because nothing answered — never a board that looks empty (R24, R25).
    await expect.poll(() => toast.textContent(), { timeout: 20_000 }).toMatch(/Ground Control is not/);

    expect(await page.locator('.gc-badge').count()).toBe(0);
    expect(await page.locator('[data-gc-issue]').count()).toBe(3);
  });

  /**
   * The whole browser half of R40 in one page: the menu item, the port to the worker, the spool, and the lines
   * coming back into a panel the scan does not rebuild. jsdom covers each piece and can cover none of the wiring.
   */
  it('opens its log from the menu and shows what the overlay itself has been through', async () => {
    const page = await context.newPage();

    await page.goto(BOARD_URL);
    await expect.poll(() => page.locator('#gc-menu').count(), { timeout: 20_000 }).toBe(1);

    expect(await page.locator('#gc-log').count()).toBe(0);

    await page.locator('#gc-menu button').first().click();
    await page.getByRole('menuitem', { name: 'Show log' }).click();

    const lines = page.locator('#gc-log-lines .gc-line');

    await expect.poll(() => lines.count(), { timeout: 20_000 }).toBeGreaterThan(0);

    // What the worker has been through, held before anybody asked and handed over on the way in: here that is the
    // native port it could not open, which is the failure a developer opens this panel to find.
    expect(await lines.first().textContent()).toContain('browser');

    // The board is still there behind it, and the sidebar is not rebuilt out from under the developer by a scan.
    expect(await page.locator('[data-gc-issue]').count()).toBe(3);

    await page.locator('#gc-log .gc-close').click();
    await expect.poll(() => page.locator('#gc-log').count()).toBe(0);
  });

  /**
   * That a real click in a real browser reaches the dismissal at all, and that ticking the pin from the panel's own
   * header stops it. Which of the two guards behind that is doing the work is jsdom's to pin down, not this test's:
   * a stale handler from a menu that was open a frame earlier will close the sidebar just as well.
   */
  it('closes the log when the developer clicks back onto the board, unless it is pinned', async () => {
    const page = await context.newPage();

    await page.goto(BOARD_URL);
    await expect.poll(() => page.locator('#gc-menu').count(), { timeout: 20_000 }).toBe(1);

    // Dispatched rather than clicked: every visible part of a card is a link, and following one would take the
    // board off the page along with the panel under test. The event still crosses into the content script's world.
    const clickTheBoard = () =>
      page.evaluate(() =>
        document
          .querySelector('#project-items-region')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
      );

    const openTheLog = async () => {
      await page.locator('#gc-menu button').first().click();
      await page.getByRole('menuitem', { name: 'Show log' }).click();
      await expect.poll(() => page.locator('#gc-log').count(), { timeout: 20_000 }).toBe(1);
    };

    await openTheLog();
    await clickTheBoard();

    await expect.poll(() => page.locator('#gc-log').count(), { timeout: 20_000 }).toBe(0);

    await openTheLog();
    await page.locator('#gc-log input[data-pin]').check();
    await clickTheBoard();
    await page.waitForTimeout(500);

    expect(await page.locator('#gc-log').count()).toBe(1);
    expect(await page.locator('#gc-log').getAttribute('data-pinned')).toBe('true');
  });

  /**
   * This route serves the same board markup at an issue URL, so only the path check can be what keeps the page
   * clean — an over-broad `matches` alone would leave this test green.
   */
  it('leaves every other page on the site alone', async () => {
    const page = await context.newPage();

    await page.goto(ISSUE_URL);
    await page.waitForTimeout(2000);

    expect(await page.locator('#gc-menu').count()).toBe(0);
    expect(await page.locator('#gc-toasts').count()).toBe(0);
    expect(await page.locator('[data-gc-issue]').count()).toBe(0);
  });
});
