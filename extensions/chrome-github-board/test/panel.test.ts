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
  localStorage.clear();
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

  it("hands its controls to the page's sticky header while that is stuck, and takes them back when it is not", async () => {
    painted();
    click(linkPull());

    const inner = framed(
      '<h1>Fix</h1><div class="StickyPullRequestHeader-module__prHeader__P9n8q"><div class="StickyPullRequestHeader-module__prTitleArea__dSHAx"><h2>Fix</h2></div></div>',
    );
    const root = panel()!;
    const bar = root.querySelector('.gc-panel-bar')!;
    const actions = root.querySelector('.gc-panel-actions')!;
    const header = inner.querySelector('[class*="prHeader"]')!;
    const area = inner.querySelector('[class*="prTitleArea"]')!;

    expect(actions.parentElement).toBe(bar);
    expect(root.hasAttribute('data-scrolled')).toBe(false);
    expect(inner.head.querySelector('style')!.textContent).toContain('.gc-panel-actions');

    // GitHub marks the header stuck once the title has scrolled away; the panel follows the class, with no scroll.
    header.classList.add('StickyPullRequestHeader-module__is-stuck__BQKQx');
    await vi.advanceTimersByTimeAsync(20);

    expect(actions.parentElement).toBe(area);
    expect(actions.ownerDocument).toBe(inner);
    expect(root.getAttribute('data-scrolled')).toBe('true');
    expect(Array.from(actions.children).map((el) => el.getAttribute('aria-label'))).toEqual(['Copy link', 'Pin side panel', 'Open in new tab', 'Close panel']);
    // The close control held focus from the open, and keeps it across the move.
    expect(inner.activeElement).toBe(actions.querySelector('[aria-label="Close panel"]'));

    header.classList.remove('StickyPullRequestHeader-module__is-stuck__BQKQx');
    inner.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(20);

    expect(actions.parentElement).toBe(bar);
    expect(root.hasAttribute('data-scrolled')).toBe(false);
    expect(document.activeElement).toBe(actions.querySelector('[aria-label="Close panel"]'));

    // The page redraws its stuck header without the controls; they are put back without a scroll.
    header.classList.add('StickyPullRequestHeader-module__is-stuck__BQKQx');
    await vi.advanceTimersByTimeAsync(20);
    area.replaceChildren(inner.createElement('h2'));
    await vi.advanceTimersByTimeAsync(20);

    expect(actions.parentElement).toBe(area);

    // The close control still closes from wherever it stands.
    (area.querySelector('[aria-label="Close panel"]') as HTMLButtonElement).click();

    expect(root.getAttribute('data-open')).not.toBe('true');
  });

  it('takes its controls back when the page leaves while stuck, before the next document has loaded', async () => {
    painted();
    click(linkPull());

    const root = panel()!;
    const bar = root.querySelector('.gc-panel-bar')!;
    const actions = root.querySelector('.gc-panel-actions')!;
    const inner = framed(
      '<h1>Fix</h1><div class="StickyPullRequestHeader-module__prHeader__P9n8q StickyPullRequestHeader-module__is-stuck__BQKQx"><div class="StickyPullRequestHeader-module__prTitleArea__dSHAx"><h2>Fix</h2></div></div>',
    );

    expect(actions.parentElement).toBe(inner.querySelector('[class*="prTitleArea"]'));
    expect(root.getAttribute('data-scrolled')).toBe('true');

    inner.defaultView!.dispatchEvent(new Event('pagehide'));

    expect(actions.parentElement).toBe(bar);
    expect(root.hasAttribute('data-scrolled')).toBe(false);

    // A new document with no sticky header leaves the controls in the bar.
    framed('<h1>Files</h1>');

    expect(actions.parentElement).toBe(bar);
    expect(root.hasAttribute('data-scrolled')).toBe(false);
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

/** jsdom lays nothing out, so a sheet reports the width it was given, or a default. */
function laidOut(sheet: HTMLElement, fallback: number, read: () => string): void {
  sheet.getBoundingClientRect = () => ({ width: Number.parseFloat(read()) || fallback }) as DOMRect;
}

function gripOf(root: Element): HTMLElement {
  const found = root.querySelector<HTMLElement>('.gc-grip');

  if (!found) {
    throw new Error('No grip.');
  }

  found.setPointerCapture = () => {};

  return found;
}

function drag(handle: HTMLElement, from: number, to: number): void {
  handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: from }));
  handle.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: to }));
  handle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: to }));
}

describe('pinning', () => {
  function pinControl(): HTMLButtonElement {
    return panel()!.querySelector<HTMLButtonElement>('.gc-panel-actions button:nth-child(2)')!;
  }

  it('opens floating, with the pin offered between copy and open as GitHub places it', () => {
    painted();
    click(linkPull());

    const names = [...panel()!.querySelectorAll('.gc-panel-actions > *')].map((control) => control.getAttribute('aria-label'));

    expect(names).toEqual(['Copy link', 'Pin side panel', 'Open in new tab', 'Close panel']);
    expect(panel()!.getAttribute('data-pinned')).toBe('false');
    expect(panel()!.getAttribute('aria-modal')).toBe('true');
  });

  it('docks beside the board when pinned: not modal, nothing inert, the board narrowed by its width', () => {
    painted();
    click(linkPull());
    click(pinControl());

    const root = panel()!;

    expect(root.getAttribute('data-pinned')).toBe('true');
    expect(root.getAttribute('aria-modal')).toBe('false');
    expect(pinControl().getAttribute('aria-label')).toBe('Unpin side panel');
    expect([...document.body.children].some((child) => child.hasAttribute('inert'))).toBe(false);
    // GitHub's own docked pane opens at 320px, and the page gives it that from the right.
    expect(root.style.getPropertyValue('--gc-panel-width')).toBe('320px');
    expect(document.body.style.marginRight).toBe('320px');
    expect(localStorage.getItem('projects.sidePanelPinned')).toBe('true');
  });

  it('narrows the main region rather than the body where the page has one', () => {
    const main = document.createElement('main');

    document.body.appendChild(main);
    painted();
    click(linkPull());
    click(pinControl());
    expect(main.style.marginRight).toBe('320px');

    click(panel()!.querySelector('button[aria-label="Close panel"]')!);
    expect(main.style.marginRight).toBe('');
  });

  it('stays put on Escape and a backdrop click while docked, because it is not in the way', () => {
    painted();
    click(linkPull());
    click(pinControl());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    click(panel()!.querySelector('.gc-panel-backdrop')!);

    expect(panel()!.getAttribute('data-open')).toBe('true');

    click(panel()!.querySelector('button[aria-label="Close panel"]')!);
    expect(panel()!.hasAttribute('data-open')).toBe(false);
    expect(document.body.style.marginRight).toBe('');
  });

  it('floats again when unpinned, modal once more, and remembers the choice for the next panel', () => {
    painted();
    click(linkPull());
    click(pinControl());
    click(pinControl());

    expect(panel()!.getAttribute('data-pinned')).toBe('false');
    expect(panel()!.getAttribute('aria-modal')).toBe('true');
    expect(pinControl().getAttribute('aria-label')).toBe('Pin side panel');
    expect(document.body.style.marginRight).toBe('');
    expect([...document.body.children].filter((child) => child !== panel()).every((child) => child.hasAttribute('inert'))).toBe(true);

    click(pinControl());
    clear(document);
    painted();
    click(linkPull(OTHER_PULL, '[data-board-card-id="24502"]'));
    expect(panel()!.getAttribute('data-pinned')).toBe('true');
  });

  it('keeps a docked width apart from a floating one, and brings each back with its mode', () => {
    localStorage.setItem('ground-control:panel-width', '900');
    localStorage.setItem('projects.sidePanelWidth', '400');
    painted();
    click(linkPull());

    const root = panel()!;

    expect(root.style.getPropertyValue('--gc-panel-width')).toBe('900px');
    click(pinControl());
    expect(root.style.getPropertyValue('--gc-panel-width')).toBe('400px');
    expect(document.body.style.marginRight).toBe('400px');
    click(pinControl());
    expect(root.style.getPropertyValue('--gc-panel-width')).toBe('900px');
    expect(document.body.style.marginRight).toBe('');
  });
});

describe('resizing the panel', () => {
  function sheet(): HTMLElement {
    return panel()!.querySelector<HTMLElement>('.gc-panel-sheet')!;
  }

  it('sizes from its own edge, which is a separator that says how wide it is', () => {
    painted();
    click(linkPull());

    const root = panel()!;
    const handle = gripOf(root);

    laidOut(sheet(), 600, () => root.style.getPropertyValue('--gc-panel-width'));
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-label')).toBe('Resize conversation');
    expect(handle.getAttribute('aria-valuemin')).toBe('360');

    // Dragging left widens a panel on the right edge, and the frame stops taking the pointer while it happens.
    handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 900 }));
    expect(root.getAttribute('data-dragging')).toBe('true');
    handle.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 800 }));
    expect(root.style.getPropertyValue('--gc-panel-width')).toBe('700px');
    expect(localStorage.getItem('ground-control:panel-width')).toBeNull();
    handle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 800 }));
    expect(root.hasAttribute('data-dragging')).toBe(false);
    expect(handle.getAttribute('aria-valuenow')).toBe('700');
    expect(localStorage.getItem('ground-control:panel-width')).toBe('700');
  });

  it('refuses a width it cannot be read at, or one that covers the whole window', () => {
    painted();
    click(linkPull());

    const root = panel()!;
    const handle = gripOf(root);

    laidOut(sheet(), 600, () => root.style.getPropertyValue('--gc-panel-width'));
    drag(handle, 100, 9000);
    expect(root.style.getPropertyValue('--gc-panel-width')).toBe('360px');
    drag(handle, 9000, 0);
    expect(root.style.getPropertyValue('--gc-panel-width')).toBe(`${Math.round(window.innerWidth * 0.95)}px`);
  });

  it('sizes from the keyboard, saving once the key is let go', () => {
    painted();
    click(linkPull());

    const root = panel()!;
    const handle = gripOf(root);

    laidOut(sheet(), 600, () => root.style.getPropertyValue('--gc-panel-width'));
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(root.style.getPropertyValue('--gc-panel-width')).toBe('640px');
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(root.style.getPropertyValue('--gc-panel-width')).toBe('600px');
    expect(localStorage.getItem('ground-control:panel-width')).toBeNull();
    handle.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    expect(localStorage.getItem('ground-control:panel-width')).toBe('600');
  });

  it('opens at the width it was last dragged to', () => {
    localStorage.setItem('ground-control:panel-width', '800');
    painted();
    click(linkPull());
    expect(panel()!.style.getPropertyValue('--gc-panel-width')).toBe('800px');
  });

  it('keeps no width for a key or a press that sized nothing, so the stylesheet keeps sizing the panel', () => {
    painted();
    click(linkPull());

    const root = panel()!;
    const handle = gripOf(root);

    laidOut(sheet(), 600, () => root.style.getPropertyValue('--gc-panel-width'));
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    handle.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', bubbles: true }));
    drag(handle, 500, 500);
    expect(root.style.getPropertyValue('--gc-panel-width')).toBe('');
    expect(localStorage.getItem('ground-control:panel-width')).toBeNull();
  });

  it('docked, leaves the board its floor and narrows it as it grows', () => {
    painted();
    click(linkPull());
    click(panel()!.querySelector('button[aria-label="Pin side panel"]')!);

    const root = panel()!;
    const handle = gripOf(root);

    laidOut(sheet(), 320, () => root.style.getPropertyValue('--gc-panel-width'));
    expect(handle.getAttribute('aria-valuemin')).toBe('256');
    expect(handle.getAttribute('aria-valuemax')).toBe(String(window.innerWidth - 300));
    drag(handle, 500, 400);
    expect(root.style.getPropertyValue('--gc-panel-width')).toBe('420px');
    expect(document.body.style.marginRight).toBe('420px');
    expect(localStorage.getItem('projects.sidePanelWidth')).toBe('420');
    expect(localStorage.getItem('ground-control:panel-width')).toBeNull();
  });
});

describe("resizing GitHub's own issue panel", () => {
  /** GitHub's floating issue panel as it stands in the page: a dialog whose sheet carries its width inline. */
  function issuePanel(): { dialog: HTMLElement; sheet: HTMLElement } {
    const dialog = document.createElement('div');
    const sheet = document.createElement('div');

    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'Side panel: Issue: Quote email drops rows past the first page');
    dialog.style.setProperty('--top-offset', '72px');
    sheet.style.setProperty('--side-panel-width', 'min(90%, 1280px)');
    dialog.appendChild(sheet);
    document.body.appendChild(dialog);
    laidOut(sheet, 800, () => sheet.style.getPropertyValue('--side-panel-width'));

    return { dialog, sheet };
  }

  it('gives the panel an edge to size by, once, however often the board is painted', () => {
    const { dialog, sheet } = issuePanel();

    painted();
    painted();

    const handles = dialog.querySelectorAll(':scope > .gc-grip');

    expect(handles).toHaveLength(1);
    expect(handles[0]!.getAttribute('role')).toBe('separator');
    // Beside the sheet, at its edge, since the sheet itself scrolls.
    expect((handles[0] as HTMLElement).style.right).toBe('796px');
    expect(sheet.style.getPropertyValue('--side-panel-width')).toBe('min(90%, 1280px)');
  });

  it("sizes GitHub's sheet through its own width variable and keeps the width for the next issue", () => {
    const { dialog, sheet } = issuePanel();

    painted();

    const handle = gripOf(dialog);

    drag(handle, 500, 400);
    expect(sheet.style.getPropertyValue('--side-panel-width')).toBe('900px');
    expect(handle.style.right).toBe('896px');
    expect(localStorage.getItem('ground-control:panel-width')).toBe('900');

    dialog.remove();

    const next = issuePanel();

    painted();
    expect(next.sheet.style.getPropertyValue('--side-panel-width')).toBe('900px');
  });

  it('puts the width back when GitHub redraws the sheet without it', () => {
    localStorage.setItem('ground-control:panel-width', '700');

    const { sheet } = issuePanel();

    painted();
    expect(sheet.style.getPropertyValue('--side-panel-width')).toBe('700px');

    sheet.style.setProperty('--side-panel-width', 'min(90%, 1280px)');
    painted();
    expect(sheet.style.getPropertyValue('--side-panel-width')).toBe('700px');
  });

  it('shares the floating width with the pull request panel', () => {
    const { dialog } = issuePanel();

    painted();
    drag(gripOf(dialog), 500, 400);
    dialog.remove();
    click(linkPull());
    expect(panel()!.style.getPropertyValue('--gc-panel-width')).toBe('900px');
  });

  it('leaves a page with no issue panel alone', () => {
    painted();
    expect(document.querySelector('.gc-grip')).toBeNull();
  });

  it('takes its grip off the panel and gives the sheet its own width back when the overlay leaves the board', () => {
    localStorage.setItem('ground-control:panel-width', '700');

    const { dialog, sheet } = issuePanel();

    painted();
    expect(dialog.querySelector('.gc-grip')).not.toBeNull();

    clear(document);
    expect(dialog.querySelector('.gc-grip')).toBeNull();
    expect(sheet.style.getPropertyValue('--side-panel-width')).toBe('min(90%, 1280px)');
  });

  it("dresses GitHub's panel with the pull request panel open, which is a side panel too, and gives way to it", () => {
    painted();
    click(linkPull());

    const { dialog } = issuePanel();

    painted();
    expect(dialog.querySelector(':scope > .gc-grip')).not.toBeNull();
    expect(panel()).toBeNull();
  });
});

describe('one docked panel for issues and pull requests', () => {
  /** GitHub's pinned issue pane as it stands in the page: a page pane named for the issue, closed by a labelled control. */
  function issuePane(width = 480): { pane: HTMLElement; closed: () => number } {
    const pane = document.createElement('div');
    const close = document.createElement('button');
    const tip = document.createElement('span');
    let closes = 0;

    pane.setAttribute('data-component', 'PageLayout.Pane');
    pane.setAttribute('aria-label', 'Side panel: Issue: Quote email drops rows past the first page');
    pane.style.setProperty('--pane-width', `${width}px`);
    pane.style.setProperty('--pane-max-width', '563px');
    tip.id = 'close-tip';
    tip.textContent = 'Close panel';
    close.setAttribute('aria-labelledby', tip.id);
    close.addEventListener('click', () => {
      closes += 1;
    });
    pane.append(close, tip);
    document.body.appendChild(pane);
    laidOut(pane, width, () => pane.style.getPropertyValue('--pane-width'));

    return { pane, closed: () => closes };
  }

  it("opens docked where GitHub's pinned pane stood, at its width, after closing the pane by its own control", () => {
    localStorage.setItem('projects.sidePanelPinned', 'true');

    const { pane, closed } = issuePane(480);

    painted();
    click(linkPull());

    const root = panel()!;

    expect(closed()).toBe(1);
    expect(root.getAttribute('data-pinned')).toBe('true');
    expect(root.style.getPropertyValue('--gc-panel-width')).toBe('480px');
    expect(localStorage.getItem('projects.sidePanelWidth')).toBe('480');

    // The pane it closed is still leaving; only a paint that finds it gone, then a pane again, closes this panel.
    painted();
    expect(panel()).toBe(root);
    pane.setAttribute('aria-label', 'Side panel');
    pane.querySelector('button')!.focus();
    painted();
    expect(panel()).toBe(root);
    // GitHub sent focus back to the board as its pane went; the panel in its place takes it.
    expect(document.activeElement).toBe(root.querySelector('[aria-label="Close panel"]'));
    pane.setAttribute('aria-label', 'Side panel: Issue: Quote email drops rows past the first page');
    painted();
    expect(panel()).toBeNull();
  });

  it("lets GitHub's pinned pane grow to the docked width, with no pull request panel open", () => {
    const { pane, closed } = issuePane(640);

    painted();

    expect(pane.style.getPropertyValue('--pane-max-width')).toBe(`${window.innerWidth - 300}px`);
    expect(closed()).toBe(0);
    expect(pane.getAttribute('aria-label')).toBe('Side panel: Issue: Quote email drops rows past the first page');
  });

  it("gives way to GitHub's pane while docked, lifting the pane's width cap to its own and leaving focus with the pane", () => {
    painted();
    click(linkPull());
    click(panel()!.querySelector('button[aria-label="Pin side panel"]')!);

    const root = panel()!;
    const handle = gripOf(root);

    laidOut(root.querySelector<HTMLElement>('.gc-panel-sheet')!, 320, () => root.style.getPropertyValue('--gc-panel-width'));
    drag(handle, 500, 400);
    expect(localStorage.getItem('projects.sidePanelWidth')).toBe('420');
    expect(localStorage.getItem('projects.sidePanelPinned')).toBe('true');

    const { pane } = issuePane(420);
    const inPane = pane.querySelector('button')!;

    inPane.focus();
    painted();

    expect(panel()).toBeNull();
    expect(document.body.style.marginRight).toBe('');
    expect(pane.style.getPropertyValue('--pane-max-width')).toBe(`${window.innerWidth - 300}px`);
    expect(document.activeElement).toBe(inPane);
  });
});

