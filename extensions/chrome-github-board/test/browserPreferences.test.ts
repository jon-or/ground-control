import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Snapshot } from '@ground-control/core';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';

const ROOT = join(__dirname, '..');
const BOARD = 'https://github.com/orgs/example-org/projects/3';
const OTHER = 'https://github.com/orgs/example-org/projects/30';
const USER = 'https://github.com/users/example-org/projects/3';
const OWNER = 'https://github.com/orgs/another-org/projects/3';
const ISSUE = 'https://github.com/example-org/example-repo/issues/4501';
const ROUTES = new Set([BOARD, OTHER, USER, OWNER, ISSUE]);
let context: BrowserContext;
let worker: Worker;
let extension = '';
let profile = '';
const offsite: string[] = [];

const reading: Snapshot = {
  lanes: [{ id: 'build', title: 'Build', cards: [{
    key: 'issue-4501', issueNumber: 4501, sessions: [], lane: 'build', returned: false,
    attention: null, reason: '',
    issue: {
      number: 4501, title: 'Quote email drops rows past the first page', type: null, typeColor: null,
      url: 'https://github.com/example-org/example-repo/issues/4501', status: null, statusColor: null,
      statusChangedAt: null, assignees: [], pullRequest: null, updatedAt: '2026-09-09T12:00:00Z',
      avatar: { login: 'reviewer', source: 'pull-request', url: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==' },
    },
  }] }],
  issues: { count: 1, matched: 1, totalAssigned: 1, notOnProject: 0, fieldProblem: null, truncated: false, fetchedAt: '' },
  sessions: { count: 0, patternError: null, fetchedAt: '' }, openable: [], startable: [], hooks: null,
  failures: [], stale: false, needs: null, fetchedAt: '2026-09-09T12:00:00Z',
};

async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  // Retain the recorded markup; a role variation verifies restoring an existing accessible role.
  const fixture = readFileSync(join(ROOT, 'test/fixtures/project-board.html'), 'utf8')
    .replace('<figure ', '<figure role="group" ');
  await context.route((url) => url.protocol.startsWith('http'), (route) => {
    if (ROUTES.has(route.request().url())) return route.fulfill({ contentType: 'text/html', body: fixture });
    offsite.push(route.request().url());
    return route.abort();
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
}

beforeEach(async () => {
  offsite.length = 0;
  profile = mkdtempSync(join(tmpdir(), 'gc-preferences-profile-'));
  extension = mkdtempSync(join(tmpdir(), 'gc-preferences-extension-'));
  cpSync(ROOT, extension, { recursive: true, filter: (path) => !/node_modules|coverage/.test(path) });
  const path = join(extension, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { permissions: string[] };
  manifest.permissions = manifest.permissions.filter((permission) => permission !== 'nativeMessaging');
  writeFileSync(path, JSON.stringify(manifest));
  expect(JSON.parse(readFileSync(path, 'utf8')).permissions).not.toContain('nativeMessaging');

  const workerPath = join(extension, 'src/worker.js');
  writeFileSync(workerPath, `
globalThis.probe = { ports: [], messages: [], deliveries: [], reports: [], opens: 0, closes: 0 };
chrome.runtime.onConnect.addListener(port => {
  const id = probe.ports.length;
  probe.ports.push(port);
  const post = port.postMessage.bind(port);
  port.postMessage = message => { probe.deliveries.push({ id, message }); post(message); };
  port.onMessage.addListener(message => probe.reports.push({ id, message }));
  const disconnected = [];
  const add = port.onDisconnect.addListener.bind(port.onDisconnect);
  port.onDisconnect.addListener = listener => { disconnected.push(listener); add(listener); };
  probe.dropContent = index => {
    if (index !== id) return;
    port.disconnect();
    disconnected.forEach(listener => listener());
  };
});
chrome.runtime.connectNative = () => {
  probe.opens++;
  const messages = [], disconnected = [];
  probe.emit = message => messages.forEach(listener => listener(message));
  probe.dropNative = () => disconnected.forEach(listener => listener());
  return {
    postMessage: message => probe.messages.push(message),
    disconnect: () => { probe.closes++; },
    onMessage: { addListener: listener => messages.push(listener) },
    onDisconnect: { addListener: listener => disconnected.push(listener) }
  };
};
` + readFileSync(workerPath, 'utf8'));
  const contentPath = join(extension, 'src/content.js');
  // Headless tabs have inconsistent visibility. Exercise real handlers with deterministic visibility
  // and suspended frames; preferences must clear a hidden page without waiting for a frame.
  writeFileSync(contentPath, `
Object.defineProperty(document, 'visibilityState', {
  get: () => document.documentElement.dataset.testVisibility || 'visible'
});
const originalFrame = requestAnimationFrame.bind(globalThis);
const heldFrames = [];
globalThis.requestAnimationFrame = callback => document.documentElement.dataset.testVisibility === 'hidden'
  ? (heldFrames.push(callback), 0) : originalFrame(callback);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') heldFrames.splice(0).forEach(callback => originalFrame(callback));
});
const heldPreferences = [];
const addStorageListener = chrome.storage.onChanged.addListener.bind(chrome.storage.onChanged);
chrome.storage.onChanged.addListener = listener => addStorageListener((changes, area) => {
  if (area === 'local' && document.documentElement.dataset.holdPreferences === 'true') {
    heldPreferences.push(() => listener(changes, area));
  } else listener(changes, area);
});
document.addEventListener('releasePreferences', () => heldPreferences.splice(0).forEach(deliver => deliver()));
` + readFileSync(contentPath, 'utf8'));
  await launch();
});

afterEach(async () => {
  await context?.close();
  for (const path of [profile, extension]) if (path) rmSync(path, { recursive: true, force: true });
  expect(offsite).toEqual([]);
});

async function preferences(enabled: boolean, projects: string[] = []) {
  await worker.evaluate(async (value) => {
    await (globalThis as any).chrome.storage.local.set({ preferences: value });
  }, { enabled, projects });
}

async function pageAt(url = BOARD) {
  const page = await context.newPage();
  await page.goto(url);
  await expect.poll(() => worker.evaluate('probe.reports.length')).toBeGreaterThan(0);
  return page;
}

async function shown(page: Page, enabled: boolean) {
  await expect.poll(() => page.locator('#gc-menu').count(), { timeout: 20_000 }).toBe(enabled ? 1 : 0);
}

async function options() {
  const page = await context.newPage();
  await page.goto(worker.url().replace('src/worker.js', 'options.html'));
  await expect.poll(() => page.getByRole('status').textContent()).not.toBe('Loading preferences…');
  return page;
}

async function emit() {
  await worker.evaluate((snapshot) => {
    (globalThis as any).probe.emit({ type: 'snapshot', snapshot });
  }, reading);
}

async function storeOldSnapshot() {
  await worker.evaluate(async (snapshot) => {
    snapshot.lanes[0]!.cards[0]!.issue!.avatar!.login = 'cached-reviewer';
    await (globalThis as any).chrome.storage.session.set({ last: { type: 'snapshot', snapshot } });
  }, reading);
}

async function navigate(page: Page, url: string) {
  await page.evaluate((url) => {
    history.pushState({}, '', url);
    document.dispatchEvent(new Event('turbo:load'));
  }, url);
}

/** Replace the board's filter and provoke the scan a GitHub navigation would. */
async function filterBy(page: Page, filter: string) {
  await page.evaluate((value) => {
    const input = document.querySelector('[role="region"][aria-label="View filters"] input') as HTMLInputElement;
    input.value = value;
    document.dispatchEvent(new Event('turbo:load'));
  }, filter);
}

it('runs only where the board filter names the developer, and hands GitHub its assignees back where it does not', async () => {
  const board = await pageAt();

  // The fixture board is filtered to its own viewer, whose login GitHub states on the page.
  await shown(board, true);
  await emit();
  await expect.poll(() => board.locator('[data-gc-actor]').count()).toBe(1);

  await filterBy(board, 'label:example');
  await shown(board, false);
  await expect.poll(() => board.locator('[data-gc-actor]').count()).toBe(0);
  expect(await board.locator('figure').first().getAttribute('role')).toBe('group');

  // `@me` needs no identity at all, so the gate works before the hub has ever answered.
  await filterBy(board, 'assignee:@me');
  await shown(board, true);

  // A second login belongs to the developer only because the hub said so.
  await filterBy(board, 'assignee:teammate-bot');
  await shown(board, false);
  await worker.evaluate(async () => {
    await (globalThis as any).chrome.storage.local.set({ logins: ['teammate-bot'] });
  });
  await shown(board, true);

  // A board naming someone else stays GitHub's, and turning the preference off gives every board back.
  await filterBy(board, 'assignee:teammate-bot,someone-else');
  await shown(board, false);
  await worker.evaluate(async () => {
    await (globalThis as any).chrome.storage.local.set({ preferences: { enabled: true, projects: [], filteredToMe: false } });
  });
  await shown(board, true);
});

it('holds the hub connection on a board it is not serving, so a login it does not know can still arrive', async () => {
  const board = await pageAt();

  // A login the page cannot resolve on its own: not `@me`, not the signed-in user. Only the hub knows it is mine.
  await filterBy(board, 'assignee:teammate-bot');
  await shown(board, false);
  await expect.poll(() => worker.evaluate('probe.opens')).toBeGreaterThan(0);
  expect(await worker.evaluate('probe.closes')).toBe(0);

  await worker.evaluate((snapshot) => {
    (globalThis as any).probe.emit({ type: 'snapshot', snapshot: { ...snapshot, owners: ['teammate-bot'] } });
  }, reading);

  await expect.poll(() => worker.evaluate('chrome.storage.local.get("logins").then(held => held.logins)'))
    .toEqual(['teammate-bot']);
  await shown(board, true);
  await expect.poll(() => board.locator('[data-gc-actor]').count()).toBe(1);
});


/** The menu writes durable storage, so the choice survives a reload and reaches every tab, not just this one. */
it('stores the card-row choice from its menu, keeping the rest of the preferences', async () => {
  const board = await pageAt();
  await shown(board, true);
  await emit();
  await expect.poll(() => board.locator('.gc-badge').count()).toBe(1);

  await board.locator('#gc-menu button').first().click();

  const overlay = board.getByRole('menuitemcheckbox', { name: 'Enable overlay', exact: true });

  await expect.poll(() => overlay.textContent()).toBe('✓Enable overlay');
  await overlay.click();

  await expect.poll(() => board.locator('.gc-badge').count()).toBe(0);
  expect(await worker.evaluate('chrome.storage.local.get("preferences").then(held => held.preferences)'))
    .toEqual({ enabled: true, projects: [], animations: true, replaceAvatars: true, filteredToMe: true, cardRows: false, pairConversations: false });

  // The menu stands while the rows are gone, which is what makes the choice reversible from the page.
  await shown(board, true);
  await expect.poll(() => overlay.textContent()).toBe('Enable overlay');
  await overlay.click();
  await expect.poll(() => board.locator('.gc-badge').count()).toBe(1);
});

it('saves accessible options, rejects invalid URLs, and preserves disabled startup after browser restart', async () => {
  const board = await pageAt();
  await shown(board, true);
  await board.locator('#gc-menu button').first().click();
  const opened = context.waitForEvent('page');
  await board.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const settings = await opened;
  await settings.waitForURL(worker.url().replace('src/worker.js', 'options.html'));
  await expect.poll(() => settings.getByRole('status').textContent()).not.toBe('Loading preferences…');
  expect(await worker.evaluate('probe.messages.filter(m => m.type === "openOptions" || m.type === "configure")')).toEqual([]);
  expect(await settings.getByLabel('Enable overlay', { exact: true }).isChecked()).toBe(true);
  expect(await settings.locator('a[href^="vscode:"]').getAttribute('href')).toBe('vscode://settings/groundControl.github.repo');
  await settings.getByLabel('Allowed project URLs', { exact: true }).fill('https://example.test/orgs/example-org/projects/3');
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => settings.getByRole('alert').textContent()).toMatch(/GitHub|github|project|URL/);
  expect(await worker.evaluate('chrome.storage.local.get("preferences").then(held => held.preferences)')).toBeUndefined();
  await settings.getByLabel('Allowed project URLs', { exact: true }).fill('https://github.com/orgs/EXAMPLE-ORG/projects/3/views/2?filter=test');
  expect(await settings.getByLabel(/Animate working borders/).isChecked()).toBe(true);
  expect(await settings.getByLabel(/Replace assignee avatars/).isChecked()).toBe(true);
  expect(await settings.getByLabel(/Run only on boards filtered to my issues/).isChecked()).toBe(true);
  expect(await settings.getByLabel(/Add triage and session rows to issue cards/).isChecked()).toBe(true);
  expect(await settings.getByLabel(/Show the issue on the left and the pull request on the right/).isChecked()).toBe(false);
  await settings.getByLabel(/Replace assignee avatars/).uncheck();
  await settings.getByLabel(/Run only on boards filtered to my issues/).uncheck();
  await settings.getByLabel(/Show the issue on the left and the pull request on the right/).check();
  await settings.getByLabel('Enable overlay', { exact: true }).uncheck();
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await shown(board, false);
  expect(await worker.evaluate('chrome.storage.local.get("preferences").then(held => held.preferences)'))
    .toEqual({ enabled: false, projects: [BOARD], animations: true, replaceAvatars: false, filteredToMe: false, cardRows: true, pairConversations: true });

  await context.close();
  await launch();
  const restarted = await pageAt();
  await expect.poll(() => worker.evaluate('probe.ports.length')).toBeGreaterThan(0);
  await shown(restarted, false);
  expect(await worker.evaluate('probe.opens')).toBe(0);
  const restored = await options();
  expect(await restored.getByLabel('Enable overlay', { exact: true }).isChecked()).toBe(false);
  expect(await restored.getByLabel('Allowed project URLs', { exact: true }).inputValue()).toBe(BOARD);
  expect(await restored.getByLabel(/Replace assignee avatars/).isChecked()).toBe(false);
});

it('matches exact projects across open tabs and soft navigation without delivering private data to other projects', async () => {
  await preferences(true, [BOARD]);
  const allowed = await pageAt();
  await shown(allowed, true);
  const others: Page[] = [];
  for (const url of [OTHER, USER, OWNER]) {
    const page = await pageAt(url);
    others.push(page);
    await shown(page, false);
  }
  await expect.poll(() => worker.evaluate('probe.ports.length')).toBe(4);
  await emit();
  await expect.poll(() => allowed.locator('.gc-badge').count()).toBe(1);
  expect(await worker.evaluate('probe.deliveries.filter(d => d.id !== 0 && ["snapshot", "changed", "log"].includes(d.message.type))')).toEqual([]);
  await navigate(others[0]!, BOARD);
  await shown(others[0]!, true);
  await expect.poll(() => others[0]!.locator('.gc-badge').count()).toBe(1);
  await navigate(allowed, ISSUE);
  await shown(allowed, false);
  await preferences(true, [USER]);
  await shown(others[0]!, false);
  await shown(others[1]!, true);
  await shown(others[2]!, false);
});

it('clears hidden tabs immediately, restores GitHub markup, unsubscribes logs, and rejects stale deliveries', async () => {
  const board = await pageAt();
  await shown(board, true);
  await emit();
  await expect.poll(() => board.locator('.gc-actor').count()).toBe(1);
  await worker.evaluate('probe.stale = structuredClone(probe.deliveries.find(d => d.message.type === "snapshot").message)');
  const figure = board.locator('[data-board-card-id="24501"] figure');
  expect(await figure.getAttribute('role')).toBe('presentation');
  expect(await figure.locator('[data-component="AvatarStack"]').isVisible()).toBe(false);
  await board.locator('#gc-collapse').click();
  await expect.poll(() => board.locator('[data-gc-hidden]').count()).toBeGreaterThan(0);
  await board.locator('#gc-menu button').first().click();
  await board.getByRole('menuitemcheckbox', { name: 'Show log', exact: true }).click();
  await expect.poll(() => worker.evaluate('probe.messages.filter(m => m.type === "watchLog").at(-1)?.watching')).toBe(true);
  await board.evaluate(() => {
    document.documentElement.dataset.testVisibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await preferences(false);
  await shown(board, false);
  expect(await board.locator('#gc-style, #gc-log, .gc-badge, .gc-actor, [data-gc-hidden], [data-gc-actor], [data-gc-issue]').count()).toBe(0);
  expect(await figure.getAttribute('role')).toBe('group');
  expect(await figure.locator('[data-component="AvatarStack"]').isVisible()).toBe(true);
  await expect.poll(() => worker.evaluate('probe.messages.filter(m => m.type === "watchLog").at(-1)?.watching')).toBe(false);
  await worker.evaluate('probe.deliveries = []');
  await emit();
  await worker.evaluate('probe.emit({ type: "log", entries: [{ at: "2026-09-09T12:00:00Z", source: "hub", level: "info", message: "private late log" }] })');
  expect(await worker.evaluate('probe.deliveries.filter(d => ["snapshot", "changed", "log"].includes(d.message.type))')).toEqual([]);
  // Simulate an already queued worker message. Content policy must independently refuse it.
  await worker.evaluate((snapshot) => {
    (globalThis as any).probe.ports[0].postMessage({ type: 'snapshot', snapshot });
  }, reading);
  await board.evaluate(() => {
    document.documentElement.dataset.testVisibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await shown(board, false);
  expect(await board.locator('.gc-badge').count()).toBe(0);
  await preferences(true);
  await shown(board, true);
  await emit();
  await expect.poll(() => board.locator('.gc-badge').count()).toBe(1);
  await worker.evaluate(`
    probe.stale.snapshot.lanes[0].cards[0].issue.avatar.login = 'stale-reviewer';
    probe.ports[0].postMessage(probe.stale);
  `);
  // Wait for a real content event after the queued message, without arbitrary timer delays.
  await navigate(board, BOARD + '/views/1');
  await expect.poll(() => worker.evaluate('probe.reports.at(-1)?.message.pathname')).toBe('/orgs/example-org/projects/3/views/1');
  expect(await board.locator('.gc-actor').getAttribute('aria-label')).toBe('reviewer, pull request author');
});

it('keeps disallowed ports ineligible through content and native reconnects', async () => {
  await preferences(true, [BOARD]);
  const allowed = await pageAt();
  await shown(allowed, true);
  const blocked = await pageAt(OTHER);
  await expect.poll(() => worker.evaluate('probe.ports.length')).toBe(2);
  await worker.evaluate('probe.oldDrop = probe.dropNative; probe.oldEmit = probe.emit; probe.dropNative(); probe.dropContent(1)');
  await expect.poll(() => worker.evaluate('probe.ports.length'), { timeout: 20_000 }).toBe(3);
  await expect.poll(() => worker.evaluate('probe.opens')).toBe(2);
  // Late callbacks from the previous native port must not clear or replace the new connection.
  await worker.evaluate('probe.oldDrop(); probe.oldEmit({ type: "notice", message: "stale native message" })');
  await emit();
  await allowed.locator('#gc-menu button').first().click();
  await allowed.getByRole('menuitem', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => worker.evaluate('probe.messages.filter(m => m.type === "refresh").length')).toBe(1);
  expect(await worker.evaluate('probe.deliveries.filter(d => d.message.message === "stale native message")')).toEqual([]);
  await shown(blocked, false);
  expect(await worker.evaluate('probe.deliveries.filter(d => d.id > 0 && ["snapshot", "changed", "log"].includes(d.message.type))')).toEqual([]);
  await navigate(blocked, BOARD);
  await shown(blocked, true);
  await expect.poll(() => blocked.locator('.gc-badge').count()).toBe(1);
});

it('fails closed for invalid stored preferences and can recover through the options page', async () => {
  await worker.evaluate('chrome.storage.local.set({ preferences: { enabled: true, projects: ["https://example.test/"] } })');
  const board = await pageAt();
  await expect.poll(() => worker.evaluate('probe.ports.length')).toBe(1);
  await shown(board, false);
  expect(await worker.evaluate('probe.opens')).toBe(0);
  const settings = await options();
  await expect.poll(() => settings.getByRole('alert').textContent()).toMatch(/invalid|could not|cannot|settings|preferences/i);
  await settings.getByLabel('Enable overlay', { exact: true }).check();
  await settings.getByLabel('Allowed project URLs', { exact: true }).fill(BOARD);
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await shown(board, true);
});

it('waits for current hub scope instead of replaying snapshots saved by an older worker', async () => {
  await storeOldSnapshot();
  const board = await pageAt();
  await shown(board, true);
  expect(await worker.evaluate('probe.deliveries.filter(d => ["snapshot", "changed"].includes(d.message.type))')).toEqual([]);
  expect(await board.locator('.gc-badge').count()).toBe(0);
  // A log response establishes liveness but cannot authorize a prior snapshot.
  await worker.evaluate('probe.emit({ type: "log", entries: [] })');
  const second = await pageAt();
  await shown(second, true);
  expect(await worker.evaluate('probe.deliveries.filter(d => d.message.type === "snapshot")')).toEqual([]);
  await emit();
  await expect.poll(() => second.locator('.gc-actor').getAttribute('aria-label')).toBe('reviewer, pull request author');
  expect(await worker.evaluate('probe.deliveries.filter(d => d.message.type === "snapshot").map(d => d.message.snapshot.lanes[0].cards[0].issue.avatar.login)'))
    .not.toContain('cached-reviewer');
});

it('clears prior native snapshots before reconnecting tabs can replay them', async () => {
  const board = await pageAt();
  await shown(board, true);
  await emit();
  await expect.poll(() => board.locator('.gc-badge').count()).toBe(1);
  await worker.evaluate('probe.dropNative(); probe.deliveries = []');
  const second = await pageAt();
  await shown(second, true);
  await expect.poll(() => worker.evaluate('probe.opens')).toBe(2);
  expect(await worker.evaluate('probe.deliveries.filter(d => d.message.type === "snapshot")')).toEqual([]);
  expect(await second.locator('.gc-badge').count()).toBe(0);
  // A changed response from the new hub replaces the old scope for every connected tab.
  await worker.evaluate((snapshot) => {
    snapshot.lanes = [];
    (globalThis as any).probe.emit({ type: 'changed', snapshot });
  }, reading);
  await expect.poll(() => board.locator('.gc-badge').count()).toBe(0);
  const third = await pageAt();
  await shown(third, true);
  await expect.poll(() => worker.evaluate('probe.deliveries.filter(d => d.id === 2 && d.message.type === "changed").length')).toBe(1);
  expect(await third.locator('.gc-badge').count()).toBe(0);
});

it('waits for a fresh snapshot after disabling and re-enabling the overlay', async () => {
  const board = await pageAt();
  await shown(board, true);
  await emit();
  await expect.poll(() => board.locator('.gc-badge').count()).toBe(1);
  await preferences(false);
  await shown(board, false);
  await expect.poll(() => worker.evaluate('probe.closes')).toBe(1);
  await worker.evaluate('probe.deliveries = []');
  await preferences(true);
  await shown(board, true);
  await expect.poll(() => worker.evaluate('probe.opens')).toBe(2);
  expect(await worker.evaluate('probe.deliveries.filter(d => d.message.type === "snapshot")')).toEqual([]);
  expect(await board.locator('.gc-badge').count()).toBe(0);
  await emit();
  await expect.poll(() => board.locator('.gc-badge').count()).toBe(1);
});

it('does not replay a prior scope while the same native bridge reconnects to the hub', async () => {
  const board = await pageAt();
  await shown(board, true);
  await emit();
  await expect.poll(() => board.locator('.gc-badge').count()).toBe(1);
  await worker.evaluate('probe.emit({ type: "trouble", message: "Hub disconnected" }); probe.deliveries = []');
  const second = await pageAt();
  await shown(second, true);
  expect(await worker.evaluate('probe.opens')).toBe(1);
  expect(await worker.evaluate('probe.deliveries.filter(d => d.message.type === "snapshot")')).toEqual([]);
  expect(await worker.evaluate('probe.deliveries.filter(d => d.id === 1 && d.message.type === "trouble").map(d => d.message.message)')).toContain('Hub disconnected');
  expect(await second.locator('.gc-badge').count()).toBe(0);
  await emit();
  await expect.poll(() => second.locator('.gc-badge').count()).toBe(1);
});

it('removes all disabled tabs before reporting the new aggregate watching state', async () => {
  const first = await pageAt();
  await shown(first, true);
  const second = await pageAt(OTHER);
  await shown(second, true);
  await expect.poll(() => worker.evaluate('probe.reports.filter(r => r.message.type === "boardState" && r.message.board).length')).toBe(2);
  await worker.evaluate('probe.messages = []');
  await preferences(false);
  await shown(first, false);
  await shown(second, false);
  await expect.poll(() => worker.evaluate('probe.closes')).toBe(1);
  const watching = await worker.evaluate('probe.messages.filter(m => m.type === "watching").map(m => m.watching)');
  expect(watching).toEqual([false]);
});
