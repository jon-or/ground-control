import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME_EXTENSION_ID } from '@ground-control/core';
import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';

/**
 * Verify Chrome loads the extension, matches project-board URLs, starts the worker, and exposes the overlay
 * module. These require the real browser runtime.
 */
const EXTENSION = join(__dirname, '..');
const BOARD = readFileSync(join(__dirname, 'fixtures', 'project-board.html'), 'utf8');

/** Serve the fixture at a github.com URL to exercise content-script matches without external requests. */
const BOARD_URL = 'https://github.com/orgs/example-org/projects/3/views/1';

/** Every other page on the site the content script is injected across, and must leave alone. */
const ISSUE_URL = 'https://github.com/example-org/example-repo/issues/4501';

interface Manifest {
  key: string;
  permissions: string[];
  host_permissions: string[];
  background: { service_worker: string; type: string };
  declarative_net_request: { rule_resources: { id: string; enabled: boolean; path: string }[] };
  content_scripts: { matches: string[]; js: string[] }[];
  web_accessible_resources: { resources: string[]; matches: string[] }[];
}

interface HeaderRule {
  action: { type: string; responseHeaders: { header: string; operation: string }[] };
  condition: { regexFilter: string; resourceTypes: string[]; initiatorDomains: string[] };
}

/**
 * A pull request page as the panel frames it, served with the refusal GitHub sends (mechanics M58). It comes off a
 * loopback listener rather than `route.fulfill`: Chrome applies the extension's header rule to a response from the
 * network and not to one Playwright synthesizes, so only a served page can prove the rule lets the frame in.
 */
const PULL_PATH = '/example-org/example-repo/pull/4601';
const PULL_URL = `https://github.com${PULL_PATH}`;
const PULL_PAGE = `<!doctype html><title>Fix the quote email · Pull Request #4601</title>
<div class="js-header-wrapper"><header class="AppHeader">site</header></div>
<div id="repository-container-header">repository</div>
<main><h1>Fix the quote email</h1>
<a id="files" href="${PULL_PATH}/files">Files changed</a>
<a id="author" href="/colleague">colleague</a></main>
<footer class="footer">footer</footer>`;

/** What GitHub sends with a pull request page, header for header (mechanics M58). */
const REFUSAL = { 'x-frame-options': 'deny', 'content-security-policy': "frame-ancestors 'none'" };

/** The listener that stands in for github.com, over TLS with the self-signed pair in `fixtures`. */
function pullRequestServer(): Server {
  return createServer(
    {
      key: readFileSync(join(__dirname, 'fixtures', 'github.com.key.pem')),
      cert: readFileSync(join(__dirname, 'fixtures', 'github.com.crt.pem')),
    },
    (request, response) => {
      if (request.url === PULL_PATH || request.url === `${PULL_PATH}/files`) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...REFUSAL });
        response.end(PULL_PAGE);
      } else {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not served');
      }
    },
  );
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

  it('asks for the bridge, the alarm, its own storage, and the header rule that lets a pull request into its frame', () => {
    expect(shipped.permissions).toEqual(['nativeMessaging', 'alarms', 'storage', 'declarativeNetRequest']);
    // The header rule needs the host; nothing else does, and the worker still makes no request of its own.
    expect(shipped.host_permissions).toEqual(['https://github.com/*']);
    expect(shipped.declarative_net_request.rule_resources).toEqual([{ id: 'pull-frames', enabled: true, path: 'rules.json' }]);
  });

  /**
   * The rule takes GitHub's framing refusal off a response, and with it the page's whole content security policy:
   * Chrome can drop a header, not one directive of it. That is why the rule reaches only a pull request page,
   * only as a frame, and only one a github.com page asked for — never a frame some other site embeds.
   */
  it('strips the framing refusal from pull request frames alone', () => {
    const rules = JSON.parse(readFileSync(join(EXTENSION, 'rules.json'), 'utf8')) as HeaderRule[];

    expect(rules).toHaveLength(1);

    const [rule] = rules;

    expect(rule?.action.type).toBe('modifyHeaders');
    expect(rule?.action.responseHeaders).toEqual([
      { header: 'x-frame-options', operation: 'remove' },
      { header: 'content-security-policy', operation: 'remove' },
    ]);
    expect(rule?.condition.resourceTypes).toEqual(['sub_frame']);
    expect(rule?.condition.initiatorDomains).toEqual(['github.com']);

    const pattern = new RegExp(rule?.condition.regexFilter ?? '');

    expect(pattern.test(PULL_URL)).toBe(true);
    expect(pattern.test(`${PULL_URL}/files`)).toBe(true);
    expect(pattern.test(`${PULL_URL}.diff`)).toBe(false);
    expect(pattern.test('https://github.com/example-org/example-repo/issues/4601')).toBe(false);
    expect(pattern.test('https://github.com/example-org/example-repo')).toBe(false);
    expect(pattern.test('https://github.com.example.test/o/r/pull/1')).toBe(false);
  });

  /**
   * The whole site, because a board reached by clicking through it is a soft navigation Chrome injects nothing for
   * (`mechanics.md` M27). Project preferences keep the overlay off every other page, and the test below is what
   * proves it does.
   */
  it('runs its content script on github.com and nowhere else', () => {
    expect(shipped.content_scripts).toHaveLength(1);
    expect(shipped.content_scripts[0]?.matches).toEqual(['https://github.com/*']);
    expect(shipped.content_scripts[0]?.js).toEqual(['src/content.js']);
  });

  /** The content script imports these at runtime. Missing resources prevent policy or rendering from loading. */
  it('lets the page reach the modules the content script imports', () => {
    expect(shipped.web_accessible_resources[0]?.resources).toEqual(['src/overlay.js', 'src/panel.js', 'src/state.js', 'src/preferences.js']);
  });
});

describe('the overlay as Chrome loads it', () => {
  let profile = '';
  let loaded = '';
  let context: BrowserContext;
  let served: Server;
  /**
   * What the browser asked for: the addresses the route answered, and the addresses nothing would have. The first
   * is what says the board really loaded; the second is what `docs/testing.md` refuses. `chrome-extension://` is
   * neither — it is the extension reading its own files, and never leaves the machine.
   */
  const answered: string[] = [];
  const offsite: string[] = [];

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

    served = pullRequestServer();
    await new Promise<void>((resolve) => served.listen(0, '127.0.0.1', resolve));

    const address = served.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    // `github.com` resolves to the listener, so a request the routes below let through stays on this machine. The
    // pair is self-signed, hence the ignored certificate errors.
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      ignoreHTTPSErrors: true,
      args: [`--disable-extensions-except=${loaded}`, `--load-extension=${loaded}`, `--host-resolver-rules=MAP github.com 127.0.0.1:${port}`],
    });

    await context.route('https://github.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: BOARD }),
    );

    // Registered after the board route, so Playwright checks it first: the pull request goes to the listener.
    await context.route(`${PULL_URL}**`, (route) => route.continue());

    /*
     * Registered after the route above, which Playwright therefore checks first: this catches everything that one
     * did not answer and refuses it. Enforcement rather than observation — a fixture pointing at a real host would
     * otherwise fetch it, pass every assertion, and leave only the network wrong. Predicated on the protocol so the
     * content script's own `chrome-extension://` module imports are none of its business.
     */
    await context.route(
      (url) => url.protocol.startsWith('http') && url.hostname !== 'github.com',
      (route) => route.abort(),
    );

    context.on('request', (request) => {
      const url = request.url();

      if (url.startsWith('https://github.com/')) {
        answered.push(url);
      } else if (!url.startsWith('chrome-extension:')) {
        offsite.push(url);
      }
    });
  });

  afterAll(async () => {
    await context?.close();
    served?.close();

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
    await expect.poll(() => toast.textContent(), { timeout: 20_000 }).toMatch(/Ground Control is not registered with this browser/);

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
    await page.getByRole('menuitemcheckbox', { name: 'Show log' }).click();

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
   * The other half of the repaint contract, and the half jsdom cannot reach: that a scan the observer really
   * scheduled leaves the item under the pointer where it was. The page is mutated to provoke one, because that is
   * what the observer exists to answer — a board GitHub re-renders, which it does constantly.
   */
  it('keeps the menu item under the pointer across a scan the page provoked', async () => {
    const page = await context.newPage();

    await page.goto(BOARD_URL);
    await expect.poll(() => page.locator('#gc-menu').count(), { timeout: 20_000 }).toBe(1);

    await page.locator('#gc-menu button').first().click();

    const item = page.getByRole('menuitemcheckbox', { name: 'Show log' });

    await expect.poll(() => item.count(), { timeout: 20_000 }).toBe(1);

    // Marked from the page's own world: what this asks is whether the node survived, and a fresh one carries no mark.
    await item.evaluate((element) => element.setAttribute('data-held', 'true'));

    // A witness the scan has to put back, so this cannot pass by no scan running at all — which is the wiring it
    // is here to prove. The overlay marks every card it scanned, whether or not the hub knew one.
    await page.evaluate(() => document.querySelector('[data-gc-issue]')?.removeAttribute('data-gc-issue'));

    // GitHub's own kind of change — a node appearing inside the board — which is what wakes the scan observer.
    await page.evaluate(() => document.querySelector('#project-items-region')?.appendChild(document.createElement('div')));

    await expect.poll(() => page.locator('[data-gc-issue]').count(), { timeout: 20_000 }).toBe(3);

    expect(await item.count()).toBe(1);
    expect(await item.getAttribute('data-held')).toBe('true');
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
      await page.getByRole('menuitemcheckbox', { name: 'Show log' }).click();
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
   * The fixture is real GitHub markup, and real markup points at real hosts — an assignee's avatar most of all. A
   * recording that keeps one turns every browser test that loads the fixture into a request off the machine, which
   * nothing else here would notice: the page renders, the assertions pass, and only the network is wrong.
   */
  it('asks nothing of any host but the one the route answers', () => {
    // The board's own request first, or an empty offsite list would only mean nothing was ever loaded.
    expect(answered).toContain(BOARD_URL);
    expect(offsite).toEqual([]);
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

  /**
   * The pull request panel end to end, which jsdom cannot frame: the header rule lets a page GitHub refuses to
   * frame into the panel, the panel reads that page's title and hides its site chrome, Escape inside the page
   * closes the panel, and a link off the pull request opens a tab rather than a refused frame.
   */
  it('frames a pull request the site refuses to frame, and reads it as GitHub reads an issue', async () => {
    const page = await context.newPage();

    await page.goto(BOARD_URL);
    await expect.poll(() => page.locator('#gc-menu').count(), { timeout: 20_000 }).toBe(1);

    // The recorded board links no pull request; one is written into a card as GitHub links one, as an anchor.
    await page.evaluate((url) => {
      const link = document.createElement('a');

      link.href = url;
      link.target = '_blank';
      link.textContent = '#4601';
      document.querySelector('[data-board-card-id]')?.appendChild(link);
    }, PULL_URL);

    const before = context.pages().length;

    // Forced past the card's `aria-disabled`, which GitHub sets on every card of a board the viewer cannot edit.
    await page.locator('[data-board-card-id] a[href*="/pull/"]').click({ force: true });
    await expect.poll(() => page.locator('#gc-panel iframe').count(), { timeout: 20_000 }).toBe(1);

    await expect.poll(() => page.frame({ name: 'gc-pull-panel' })?.url(), { timeout: 20_000 }).toBe(PULL_URL);

    const framed = page.frame({ name: 'gc-pull-panel' })!;

    await expect.poll(() => framed.locator('h1').count(), { timeout: 20_000 }).toBe(1);
    expect(context.pages().length).toBe(before);
    expect(await page.locator('#gc-panel').getAttribute('aria-label')).toBe('Side panel: Pull request: Fix the quote email');

    // Hidden by computed style: the site chrome the framed page carries, which the panel is there to lose.
    for (const chrome of ['header.AppHeader', '#repository-container-header', 'footer.footer']) {
      expect(await framed.locator(chrome).evaluate((element) => getComputedStyle(element).display)).toBe('none');
    }

    // A page of the same pull request stays in the frame, under the same rule.
    await framed.locator('#files').click({ force: true });
    await expect.poll(() => page.frame({ name: 'gc-pull-panel' })?.url(), { timeout: 20_000 }).toBe(`${PULL_URL}/files`);
    expect(await page.locator('#gc-panel iframe').count()).toBe(1);

    // A page off it would be refused in the frame, so it goes to a tab of its own.
    const opened = context.waitForEvent('page');

    await page.frame({ name: 'gc-pull-panel' })!.locator('#author').click({ force: true });
    expect((await opened).url()).toBe('https://github.com/colleague');
    expect(await page.locator('#gc-panel').count()).toBe(1);

    await page.frame({ name: 'gc-pull-panel' })!.locator('body').press('Escape');
    await expect.poll(() => page.locator('#gc-panel').count(), { timeout: 20_000 }).toBe(0);
    expect(await page.locator('[data-gc-issue]').count()).toBe(3);
  });

  /**
   * Reloading the unpacked extension is what the developer does all day, and Chrome leaves the old content script
   * running in every board tab it was already in. `chrome.runtime.connect` from that orphan throws
   * `Extension context invalidated`, so the reconnect has to end in the one line that fixes it — a reload of the tab.
   *
   * Last in the file: it takes the extension every test above is loaded against away with it.
   */
  it('requests page reload after extension context invalidation', async () => {
    const page = await context.newPage();

    await page.goto(BOARD_URL);
    await expect.poll(() => page.locator('#gc-menu').count(), { timeout: 20_000 }).toBe(1);

    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

    // Scheduled rather than called: the reload tears down the context this `evaluate` is waiting on.
    await worker.evaluate('setTimeout(() => chrome.runtime.reload(), 0)');

    await expect
      .poll(() => page.locator('#gc-toasts .gc-toast').last().textContent(), { timeout: 20_000 })
      .toMatch(/Reload this tab/);

    // And then nothing: the menu taken out of the page stays out. Longer than the 10s scan interval, because
    // clearing the observer alone leaves that timer repainting the frozen snapshot and re-arming the observer with it.
    await page.locator('#gc-menu').evaluate((menu) => menu.remove());
    await page.waitForTimeout(12_000);

    expect(await page.locator('#gc-menu').count()).toBe(0);
  });
});
