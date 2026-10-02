import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';

const ROOT = join(__dirname, '..');
const BOARD = 'https://github.com/orgs/example-org/projects/3';
const ISSUE = 'https://github.com/example-org/example-repo/issues/4501';
let context: BrowserContext;
let worker: Worker;
const directories: string[] = [];
const offsite: string[] = [];

beforeAll(async () => {
  const profile = mkdtempSync(join(tmpdir(), 'gc-watch-profile-'));
  const extension = mkdtempSync(join(tmpdir(), 'gc-watch-extension-'));
  directories.push(profile, extension);
  cpSync(ROOT, extension, { recursive: true, filter: (path) => !/node_modules|coverage/.test(path) });
  const manifestPath = join(extension, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { permissions: string[] };
  manifest.permissions = manifest.permissions.filter((permission) => permission !== 'nativeMessaging');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  expect(JSON.parse(readFileSync(manifestPath, 'utf8')).permissions).not.toContain('nativeMessaging');

  // Replace only the native boundary in the isolated copy. Track real content ports for reconnect tests, what each
  // tab sent and was sent by port index, and let a test answer as the hub.
  const workerPath = join(extension, 'src/worker.js');
  writeFileSync(workerPath, `
globalThis.probe = { messages: [], opens: 0, closes: 0, ports: [], received: [], sent: [], closed: [] };
chrome.runtime.onConnect.addListener(port => {
  const index = probe.ports.push(port) - 1;
  const listeners = [];
  const add = port.onDisconnect.addListener.bind(port.onDisconnect);
  add(() => probe.closed.push(index));
  port.onDisconnect.addListener = listener => { listeners.push(listener); add(listener); };
  probe.dropContent = () => { port.disconnect(); listeners.forEach(listener => listener()); };
  const heard = [];
  const hear = port.onMessage.addListener.bind(port.onMessage);
  port.onMessage.addListener = listener => { heard.push(listener); hear(listener); };
  hear(message => probe.received.push({ port: index, message }));
  port.fromTab = message => heard.forEach(listener => listener(message, port));
  const post = port.postMessage.bind(port);
  port.postMessage = message => { probe.sent.push({ port: index, message }); post(message); };
});
chrome.runtime.connectNative = () => {
  probe.opens++;
  const listeners = [];
  const hub = [];
  probe.drop = () => listeners.forEach(listener => listener());
  probe.hub = message => hub.forEach(listener => listener(message));
  return {
    postMessage: message => probe.messages.push(message),
    disconnect: () => { probe.closes++; },
    onMessage: { addListener: listener => hub.push(listener) },
    onDisconnect: { addListener: listener => listeners.push(listener) }
  };
};
` + readFileSync(workerPath, 'utf8'));

  // Headless Chromium does not consistently hide background tabs. Drive the visibility API in the
  // content script's isolated world; the production event handler and extension messaging remain real.
  const contentPath = join(extension, 'src/content.js');
  writeFileSync(contentPath, `
Object.defineProperty(document, 'visibilityState', {
  get: () => document.documentElement.dataset.testVisibility || 'visible'
});
` + readFileSync(contentPath, 'utf8'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const html = readFileSync(join(ROOT, 'test/fixtures/project-board.html'), 'utf8');
  await context.route((url) => url.protocol.startsWith('http'), (route) => {
    const url = route.request().url();
    if (url === BOARD || url === ISSUE) return route.fulfill({ contentType: 'text/html', body: html });
    offsite.push(url);
    return route.abort();
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
});

afterAll(async () => {
  await context?.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

async function watching(): Promise<boolean | null> {
  return worker.evaluate('probe.messages.filter(m => m.type === "watching").at(-1)?.watching ?? null');
}

async function visibility(page: Page, value: string): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.dataset.testVisibility = value;
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
}

it('aggregates visible project tabs across navigation, disconnects, and reconnects', async () => {
  const first = await context.newPage();
  await first.goto(ISSUE);
  await expect.poll(() => worker.evaluate('probe.ports.length'), { timeout: 20_000 }).toBe(1);
  expect(await worker.evaluate('probe.opens')).toBe(0);
  expect(await watching()).toBeNull();

  await first.evaluate((url) => {
    history.pushState({}, '', url);
    document.dispatchEvent(new Event('turbo:load'));
  }, BOARD);
  await expect.poll(watching).toBe(true);
  await expect.poll(() => first.locator('#gc-menu').count()).toBe(1);

  await visibility(first, 'hidden');
  await expect.poll(watching).toBe(false);
  expect(await worker.evaluate('probe.closes')).toBe(0);

  const second = await context.newPage();
  await second.goto(BOARD);
  await expect.poll(watching).toBe(true);
  await visibility(first, 'visible');
  await visibility(second, 'hidden');
  await expect.poll(watching).toBe(true);

  // A native reconnect must restore the aggregate, including when every project is hidden.
  await visibility(first, 'hidden');
  await expect.poll(watching).toBe(false);
  await worker.evaluate('probe.drop()');
  // A content reconnect also wakes the native connection, without waiting for the alarm interval.
  await worker.evaluate('probe.dropContent()');
  await expect.poll(() => worker.evaluate('probe.opens'), { timeout: 20_000 }).toBe(2);
  // The native port can reopen for the first tab before the second tab's delayed content reconnect.
  await expect.poll(() => worker.evaluate('probe.ports.length'), { timeout: 20_000 }).toBe(3);
  expect(await watching()).toBe(false);
  await visibility(second, 'visible');
  await expect.poll(watching).toBe(true);

  await second.close();
  await expect.poll(watching).toBe(false);
  await first.evaluate((url) => {
    history.pushState({}, '', url);
    document.dispatchEvent(new Event('turbo:load'));
  }, ISSUE);
  await expect.poll(() => worker.evaluate('probe.closes')).toBe(1);
  expect(await watching()).toBe(false);
  await visibility(first, 'visible');
  expect(await worker.evaluate('probe.opens')).toBe(2);
  await expect.poll(() => first.locator('#gc-menu').count()).toBe(0);

  await first.evaluate((url) => {
    history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, BOARD);
  await expect.poll(watching).toBe(true);
  await first.close();
  await expect.poll(() => worker.evaluate('probe.closes')).toBe(2);
  expect(await watching()).toBe(false);
  expect(offsite).toEqual([]);
});

/** One finished run with a report, as the hub lists it (R50, R51). */
const REPORTED_RUN = {
  id: 'issue-4501@1', key: 'issue-4501', issueNumber: 4501, action: 'develop', qualifier: null, trigger: 'browser', agent: 'claude',
  startedAt: Date.now() - 300_000, endedAt: Date.now() - 60_000, outcome: 'completed', detail: '', title: 'Issue 4501', url: null, reportId: 'issue-4501@1',
};

/** A 1×1 PNG, decodable, as the hub inlines a report's image. */
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

type Routed = { port: number; message: { type: string; id?: string; request?: unknown; html?: string } };

/** The readReport messages the hub was sent, in order. */
async function hubReads(): Promise<{ id: string; request: number }[]> {
  return worker.evaluate('probe.messages.filter(m => m.type === "readReport")');
}

/** Open a board tab's action history, which the hub then fills with one reported run. */
async function historyTab(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(BOARD);
  await expect.poll(() => page.locator('#gc-menu').count(), { timeout: 20_000 }).toBe(1);
  await page.locator('#gc-menu button').first().click();
  await page.getByRole('menuitem', { name: 'Action history' }).click();
  await expect.poll(() => page.locator('#gc-history').count()).toBe(1);

  return page;
}

async function answerAsHub(message: object): Promise<void> {
  await worker.evaluate((message) => (globalThis as unknown as { probe: { hub: (message: object) => void } }).probe.hub(message), message);
}

function answer(id: string, request: number, html: string) {
  return { type: 'report', id, request, title: 'Round 1', name: 'round-1.md', modifiedAt: Date.now() - 60_000, html, failure: null };
}

/** Open the report from the history row and wait for the hub to be asked; returns the number the hub was given. */
async function openRowReport(page: Page): Promise<number> {
  const before = (await hubReads()).length;
  await page.locator('#gc-history .gc-history-report').click();
  await expect.poll(async () => (await hubReads()).length).toBe(before + 1);

  return (await hubReads()).at(-1)!.request;
}

/** The report's header, which stays above the scrolling report, then the report. */
const reportText = async (page: Page) => `${await page.locator('#gc-history .gc-report-heading').textContent()}${await page.locator('#gc-history .gc-report').textContent()}`;

it('sends a report only to the tab that asked, under that tab’s own request number (R51)', async () => {
  const first = await historyTab();
  const second = await historyTab();

  await answerAsHub({ type: 'actionHistory', entries: [REPORTED_RUN] });
  await expect.poll(() => first.locator('#gc-history .gc-history-report').count()).toBe(1);
  await expect.poll(() => second.locator('#gc-history .gc-history-report').count()).toBe(1);

  // Each tab numbers its own reads from 1; the worker gives the hub numbers of its own.
  const firstHub = await openRowReport(first);
  const secondHub = await openRowReport(second);
  const reads = (await worker.evaluate('probe.received.filter(r => r.message.type === "readReport")')) as Routed[];
  const [firstPort, secondPort] = reads.map((read) => read.port);

  expect(reads.map((read) => read.message.request)).toEqual([1, 1]);
  expect(firstPort).not.toBe(secondPort);
  expect(secondHub).not.toBe(1);
  expect(secondHub).not.toBe(firstHub);

  await answerAsHub(answer('issue-4501@1', secondHub, '<p>Second.</p>'));
  await expect.poll(() => reportText(second)).toBe('Round 1round-1.md · modified 1m agoSecond.');
  expect(await reportText(first)).toBe('Reading the report…');

  await answerAsHub(answer('issue-4501@1', firstHub, '<p>First.</p>'));
  await expect.poll(() => reportText(first)).toContain('First.');
  expect(await reportText(second)).toContain('Second.');

  const reports = ((await worker.evaluate('probe.sent')) as Routed[]).filter((sent) => sent.message.type === 'report');

  expect(reports.map((sent) => [sent.port, sent.message.request, sent.message.html])).toEqual([
    [secondPort, 1, '<p>Second.</p>'],
    [firstPort, 1, '<p>First.</p>'],
  ]);

  // A read whose tab closed before the answer goes nowhere.
  await second.locator('#gc-history .gc-report-back').click();
  const orphan = await openRowReport(second);
  await second.close();
  await expect.poll(() => worker.evaluate(`probe.closed.includes(${secondPort})`)).toBe(true);
  await answerAsHub(answer('issue-4501@1', orphan, '<p>Late.</p>'));
  await first.locator('#gc-history .gc-report-back').click();
  const latest = await openRowReport(first);
  await answerAsHub(answer('issue-4501@1', latest, '<p>Latest.</p>'));
  await expect.poll(() => reportText(first)).toContain('Latest.');

  const after = ((await worker.evaluate('probe.sent')) as Routed[]).filter((sent) => sent.message.type === 'report');

  expect(after.map((sent) => [sent.port, sent.message.html])).toEqual([
    [secondPort, '<p>Second.</p>'],
    [firstPort, '<p>First.</p>'],
    [firstPort, '<p>Latest.</p>'],
  ]);

  // A request that is not an integer is not forwarded; a valid one after it shows the port still reads.
  const before = (await hubReads()).length;
  await worker.evaluate(`probe.ports[${firstPort}].fromTab({ type: 'readReport', id: 'issue-4501@1', request: 1.5 })`);
  await worker.evaluate(`probe.ports[${firstPort}].fromTab({ type: 'readReport', id: 'issue-4501@1', request: '3' })`);
  await worker.evaluate(`probe.ports[${firstPort}].fromTab({ type: 'readReport', id: 'issue-4501@1', request: 9 })`);
  await expect.poll(async () => (await hubReads()).length).toBe(before + 1);
  expect((await hubReads()).at(-1)).toMatchObject({ id: 'issue-4501@1' });

  await first.close();
  expect(offsite).toEqual([]);
});

it('badges the menu with the friction fixes to review and opens their report by a request number alone (R52)', async () => {
  const page = await context.newPage();
  await page.goto(BOARD);
  await expect.poll(() => page.locator('#gc-menu').count(), { timeout: 20_000 }).toBe(1);

  await answerAsHub({
    type: 'snapshot',
    snapshot: { lanes: [], issues: null, sessions: null, openable: [], startable: [], hooks: null, failures: [], stale: false, needs: null, frictionFixes: 2, fetchedAt: new Date().toISOString() },
  });
  await expect.poll(() => page.locator('#gc-menu .gc-menu-count').textContent()).toBe('2');
  expect(await page.locator('#gc-menu button').first().getAttribute('aria-label')).toBe('Ground Control, 2 friction fixes to review');

  await page.locator('#gc-menu button').first().click();
  await page.getByRole('menuitem', { name: '2 friction fixes to review' }).click();

  const frictionReads = async () => ((await worker.evaluate('probe.messages.filter(m => m.type === "readFrictionReport")')) as Record<string, unknown>[]);

  await expect.poll(async () => (await frictionReads()).length).toBe(1);

  const read = (await frictionReads())[0]!;

  expect(Object.keys(read).sort()).toEqual(['request', 'type']);
  await answerAsHub({ type: 'report', id: 'friction', request: read.request, title: 'Friction review', name: 'report.md', modifiedAt: Date.now() - 60_000, html: '<p>Two fixes.</p>', failure: null });
  await expect.poll(() => reportText(page)).toBe('Friction reviewreport.md · modified 1m agoTwo fixes.');

  await page.close();
  expect(offsite).toEqual([]);
});

it('loads an image the hub inlined into a report', async () => {
  const page = await historyTab();

  await answerAsHub({ type: 'actionHistory', entries: [REPORTED_RUN] });
  await expect.poll(() => page.locator('#gc-history .gc-history-report').count()).toBe(1);

  const request = await openRowReport(page);

  await answerAsHub(answer('issue-4501@1', request, `<p><img src="${PIXEL}" alt="shot"></p>`));

  const image = page.locator('#gc-history .gc-report-body img');

  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth), { timeout: 20_000 }).toBe(1);
  expect(await image.getAttribute('alt')).toBe('shot');

  await page.close();
  expect(offsite).toEqual([]);
});
