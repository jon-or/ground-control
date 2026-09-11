/** @vitest-environment-options { "url": "https://github.com/orgs/example-org/projects/3/views/1" } */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_ID, pullRefOf } from '../src/panel.js';
import { clear, paint } from '../src/overlay.js';

/**
 * The pull request panel (R43): a card's pull request link opens the pull request in a framed panel drawn as
 * GitHub draws its issue panel, rather than the tab GitHub opens. The frame's own document is jsdom here; what
 * Chrome does with the framed page is the extension suite's.
 */
const BOARD = readFileSync(join(__dirname, 'fixtures', 'project-board.html'), 'utf8');
const PULL = 'https://github.com/example-org/example-repo/pull/4601';
const OTHER_PULL = 'https://github.com/example-org/example-repo/pull/4602';
const actions = { refresh: vi.fn(), move: vi.fn(), repaint: vi.fn(), watchLog: vi.fn(), openCheckout: vi.fn(), createWorktree: vi.fn(), retriage: vi.fn(), runAction: vi.fn(), stopAction: vi.fn(), startSession: vi.fn(), showCardRows: vi.fn() };

/** The recorded board carries no linked pull request; one is written into a card the way GitHub links one, as an anchor. */
function linkPull(url = PULL, card = '[data-board-card-id="24501"]'): HTMLAnchorElement {
  const link = document.createElement('a');

  link.href = url;
  link.target = '_blank';
  link.textContent = '#4601';
  document.querySelector(card)!.appendChild(link);

  return link;
}

function painted(): void {
  paint(document, { snapshot: null, trouble: null, notice: null }, Date.now(), actions);
}

function panel(): HTMLElement | null {
  return document.getElementById(PANEL_ID);
}

function click(target: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });

  target.dispatchEvent(event);

  return event;
}

function frame(): HTMLIFrameElement {
  const found = panel()?.querySelector('iframe');

  if (!found) {
    throw new Error('The panel has no frame.');
  }

  return found;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.innerHTML = BOARD;
});

afterEach(() => {
  clear(document);
  vi.useRealTimers();
});

describe('reading a pull request address', () => {
  it('names the repository and number, keeping the page and fragment the link lands on', () => {
    expect(pullRefOf(PULL)).toEqual({ repo: 'example-org/example-repo', number: 4601, url: PULL });
    expect(pullRefOf(`${PULL}/files#diff-1`)?.number).toBe(4601);
    expect(pullRefOf(`${PULL}#issuecomment-7`)?.url).toBe(`${PULL}#issuecomment-7`);
  });

  it('refuses an issue, another host, and a diff or patch download', () => {
    expect(pullRefOf('https://github.com/example-org/example-repo/issues/4601')).toBeNull();
    expect(pullRefOf('https://example.test/example-org/example-repo/pull/4601')).toBeNull();
    expect(pullRefOf(`${PULL}.diff`)).toBeNull();
    expect(pullRefOf(`${PULL}.patch`)).toBeNull();
  });
});

describe('taking the click', () => {
  it('opens the panel on a plain click of a pull request link in a card, in place of the tab GitHub opens', () => {
    painted();

    const link = linkPull();
    const event = click(link);

    expect(event.defaultPrevented).toBe(true);

    const root = panel()!;

    expect(root.getAttribute('role')).toBe('dialog');
    expect(root.getAttribute('aria-modal')).toBe('true');
    expect(root.getAttribute('aria-label')).toBe('Side panel: Pull request: example-org/example-repo#4601');
    expect(frame().src).toBe(PULL);
    expect(frame().name).toBe('gc-pull-panel');
    expect(frame().title).toBe('Pull request #4601');
  });

  it('opens a link written relative to the page', () => {
    painted();
    click(linkPull('/example-org/example-repo/pull/4601'));

    expect(frame().src).toBe(PULL);
  });

  it.each([
    ['ctrl', { ctrlKey: true }],
    ['meta', { metaKey: true }],
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
    ['middle button', { button: 1 }],
  ])('leaves a %s click to GitHub, which opens the tab', (_name, init) => {
    painted();

    const event = click(linkPull(), init);

    expect(event.defaultPrevented).toBe(false);
    expect(panel()).toBeNull();
  });

  it('leaves a pull request link outside a card alone', () => {
    painted();

    const link = document.createElement('a');

    link.href = PULL;
    document.body.appendChild(link);

    expect(click(link).defaultPrevented).toBe(false);
    expect(panel()).toBeNull();
  });

  it("leaves a card's issue link to GitHub's own panel", () => {
    painted();

    const issue = document.querySelector('[data-board-card-id="24501"] a[href*="/issues/"]')!;

    expect(click(issue).defaultPrevented).toBe(false);
    expect(panel()).toBeNull();
  });

  it('takes no link until the board is painted, and none after the overlay leaves it', () => {
    const link = linkPull();

    expect(click(link).defaultPrevented).toBe(false);

    painted();
    click(link);
    expect(panel()).not.toBeNull();

    clear(document);
    expect(panel()).toBeNull();
    expect(click(link).defaultPrevented).toBe(false);
  });
});

describe('the open panel', () => {
  it('opens marked open and starts under the site header', () => {
    painted();
    click(linkPull());

    const root = panel()!;

    expect(root.getAttribute('data-open')).toBe('true');
    // jsdom lays nothing out, so the header has no height and GitHub's measured offset stands in.
    expect(root.style.getPropertyValue('--gc-panel-top')).toBe('72px');
  });

  it('makes everything else on the page inert while it is open, and only what it made so', () => {
    const already = document.createElement('div');

    already.setAttribute('inert', '');
    document.body.appendChild(already);
    painted();
    click(linkPull());

    const others = [...document.body.children].filter((child) => child !== panel());

    expect(others.length).toBeGreaterThan(1);
    expect(others.every((child) => child.hasAttribute('inert'))).toBe(true);
    expect(panel()!.hasAttribute('inert')).toBe(false);

    click(panel()!.querySelector('button[aria-label="Close panel"]')!);
    expect(others.filter((child) => child.hasAttribute('inert'))).toEqual([already]);
  });

  it('measures the site header where the page has one', () => {
    const header = document.createElement('header');

    header.getBoundingClientRect = () => ({ bottom: 64 }) as DOMRect;
    document.body.prepend(header);
    painted();
    click(linkPull());

    expect(panel()!.style.getPropertyValue('--gc-panel-top')).toBe('64px');
  });

  it('names the pull request in its bar and offers the same address in a new tab', () => {
    painted();
    click(linkPull());

    const ref = panel()!.querySelector<HTMLAnchorElement>('.gc-panel-ref')!;
    const external = panel()!.querySelector<HTMLAnchorElement>('a[aria-label="Open in new tab"]')!;

    expect(ref.textContent).toBe('example-org/example-repo #4601');
    expect(ref.href).toBe(PULL);
    expect(ref.target).toBe('_blank');
    expect(external.href).toBe(PULL);
    expect(external.target).toBe('_blank');
    expect(external.getAttribute('data-gc-tip')).toBe('Open in new tab');
  });

  it('puts focus on the close control, so Escape closes at once', () => {
    painted();
    click(linkPull());

    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close panel');
  });

  it('copies the address and shows the tick GitHub shows, then puts the copy mark back', async () => {
    const writeText = vi.fn(() => Promise.resolve());

    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    painted();
    click(linkPull());

    const copy = panel()!.querySelector<HTMLButtonElement>('button[aria-label="Copy link"]')!;
    const before = copy.querySelector('path')!.getAttribute('d');

    click(copy);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith(PULL);
    expect(copy.querySelector('path')!.getAttribute('d')).not.toBe(before);
    expect(panel()!.getAttribute('data-open')).toBe('true');

    await vi.advanceTimersByTimeAsync(2000);
    expect(copy.querySelector('path')!.getAttribute('d')).toBe(before);
  });

  it('leaves the copy mark alone when the browser refuses the write', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('not focused')) }, configurable: true });
    painted();
    click(linkPull());

    const copy = panel()!.querySelector<HTMLButtonElement>('button[aria-label="Copy link"]')!;
    const before = copy.querySelector('path')!.getAttribute('d');

    click(copy);
    await vi.advanceTimersByTimeAsync(0);
    expect(copy.querySelector('path')!.getAttribute('d')).toBe(before);
  });

  it('keeps one panel for a second click on the same pull request, and replaces it for another', () => {
    painted();

    const first = linkPull();

    click(first);

    const root = panel()!;

    click(first);
    expect(panel()).toBe(root);

    click(linkPull(OTHER_PULL, '[data-board-card-id="24502"]'));
    expect(panel()).not.toBe(root);
    expect(root.isConnected).toBe(false);
    expect(frame().src).toBe(OTHER_PULL);
  });
});

describe('closing', () => {
  it.each([
    ['the close control', () => click(panel()!.querySelector('button[aria-label="Close panel"]')!)],
    ['the backdrop', () => click(panel()!.querySelector('.gc-panel-backdrop')!)],
    ['Escape', () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))],
  ])('closes on %s, sliding out before it leaves the page, and hands focus back to the link', (_name, close) => {
    painted();

    const link = linkPull();

    click(link);
    vi.advanceTimersToNextFrame();

    const root = panel()!;

    close();
    expect(root.hasAttribute('data-open')).toBe(false);
    expect(root.isConnected).toBe(true);
    expect(document.activeElement).toBe(link);

    vi.advanceTimersByTime(200);
    expect(root.isConnected).toBe(false);
  });

  it('ignores a click inside the sheet', () => {
    painted();
    click(linkPull());
    click(panel()!.querySelector('.gc-panel-bar')!);

    expect(panel()!.getAttribute('data-open')).toBe('true');
  });

  it('lets Escape through to the page once closed', () => {
    painted();
    click(linkPull());
    click(panel()!.querySelector('button[aria-label="Close panel"]')!);
    vi.advanceTimersByTime(200);
    expect(panel()).toBeNull();

    // The panel's handler stops Escape at the document, so one it left behind would never let this run.
    const reached = vi.fn();

    document.body.addEventListener('keydown', reached);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(reached).toHaveBeenCalledOnce();
  });

  it('leaves a panel opened during its slide out alone', () => {
    painted();

    const first = linkPull();

    click(first);

    const stale = panel()!;

    click(stale.querySelector('button[aria-label="Close panel"]')!);
    click(linkPull(OTHER_PULL, '[data-board-card-id="24502"]'));

    const fresh = [...document.querySelectorAll(`#${PANEL_ID}`)].at(-1)!;

    expect(fresh).not.toBe(stale);
    click(stale.querySelector('.gc-panel-backdrop')!);
    click(stale.querySelector('button[aria-label="Close panel"]')!);
    expect(fresh.getAttribute('data-open')).toBe('true');
    expect(fresh.isConnected).toBe(true);

    vi.advanceTimersByTime(200);
    expect(stale.isConnected).toBe(false);
    expect(fresh.isConnected).toBe(true);
  });
});

describe('the framed page', () => {
  /**
   * A pull request page as the frame would hold it: GitHub's own document, at GitHub's address. jsdom fetches
   * nothing for the frame but gives its document the frame's address, so the page is written into it.
   */
  function framed(html: string, url = PULL): Document {
    const host = url === PULL ? frame() : document.createElement('iframe');

    if (host !== frame()) {
      host.src = url;
      document.body.appendChild(host);
    }

    const inner = host.contentDocument!;

    inner.open();
    inner.write(html);
    inner.close();
    Object.defineProperty(frame(), 'contentDocument', { value: inner, configurable: true });
    frame().dispatchEvent(new Event('load'));

    return inner;
  }

  it('says the pull request refused the frame, and offers a tab, when Chrome hands back its own page', () => {
    painted();
    click(linkPull());
    Object.defineProperty(frame(), 'contentDocument', { value: null, configurable: true });
    frame().dispatchEvent(new Event('load'));

    const refused = panel()!.querySelector('.gc-panel-refused')!;

    expect(panel()!.querySelector('iframe')).toBeNull();
    expect(refused.textContent).toBe('GitHub refused to load this pull request in the panel; open it in a new tab.');
    expect(refused.querySelector('a')!.href).toBe(PULL);
  });

  it('waits through the blank document the frame starts with', () => {
    painted();
    click(linkPull());

    const inner = framed('<h1>Untitled</h1>', 'about:blank');

    expect(panel()!.getAttribute('aria-label')).toBe('Side panel: Pull request: example-org/example-repo#4601');
    expect(inner.head.querySelector('style')).toBeNull();
  });

  it('takes its name from the page title and hides the site chrome around the pull request', () => {
    painted();
    click(linkPull());

    const inner = framed('<header class="AppHeader"></header><div id="repository-container-header"></div><h1>Fix the quote email</h1><footer class="footer"></footer>');
    const style = inner.head.querySelector('style')!;

    expect(panel()!.getAttribute('aria-label')).toBe('Side panel: Pull request: Fix the quote email');
    expect(style.textContent).toContain('header.AppHeader');
    expect(style.textContent).toContain('#repository-container-header');
    expect(style.textContent).toContain('footer.footer');
  });

  it('puts the style back when the page replaces its head', async () => {
    painted();
    click(linkPull());

    const inner = framed('<h1>Fix</h1>');
    const style = inner.head.querySelector('style')!;

    style.remove();
    await vi.advanceTimersByTimeAsync(0);
    expect(inner.head.querySelector('style')).toBe(style);
  });

  it('closes on Escape pressed inside the page, unless the page took it for a menu of its own', () => {
    painted();
    click(linkPull());

    const inner = framed('<h1>Fix</h1><button id="menu">menu</button>');
    const escape = () => new inner.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });

    inner.getElementById('menu')!.addEventListener('keydown', (event) => event.preventDefault());
    inner.getElementById('menu')!.dispatchEvent(escape());
    expect(panel()!.getAttribute('data-open')).toBe('true');

    inner.body.dispatchEvent(escape());
    expect(panel()!.hasAttribute('data-open')).toBe(false);
  });

  it("keeps this pull request's own pages in the frame and sends every other link to a new tab", () => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);

    painted();
    click(linkPull());

    const inner = framed('<h1>Fix</h1><a id="files" href="/example-org/example-repo/pull/4601/files">Files</a><a id="comment" href="#issuecomment-1">c</a><a id="author" href="/colleague">colleague</a><a id="other" href="https://github.com/example-org/example-repo/pull/4602">#4602</a><a id="mail" href="mailto:x@example.test">m</a>');
    const press = (id: string) => {
      const event = new inner.defaultView!.MouseEvent('click', { bubbles: true, cancelable: true });

      inner.getElementById(id)!.dispatchEvent(event);

      return event.defaultPrevented;
    };

    expect(press('files')).toBe(false);
    expect(press('comment')).toBe(false);
    expect(press('mail')).toBe(false);
    expect(opened).not.toHaveBeenCalled();

    expect(press('author')).toBe(true);
    expect(opened).toHaveBeenLastCalledWith('https://github.com/colleague', '_blank', 'noreferrer');
    expect(press('other')).toBe(true);
    expect(opened).toHaveBeenLastCalledWith(OTHER_PULL, '_blank', 'noreferrer');
    expect(panel()!.getAttribute('data-open')).toBe('true');
  });
});
