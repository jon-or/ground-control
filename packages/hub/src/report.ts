import { open, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Marked, type Token, type Tokens } from 'marked';

/** The largest report file read, in bytes (R51). */
export const REPORT_FILE_LIMIT = 512 * 1024;

/** The largest image read for inlining, in bytes. */
export const REPORT_IMAGE_LIMIT = 2 * 1024 * 1024;

/**
 * The largest answer, as UTF-8 JSON: the browser's native-messaging frame holds one megabyte, and the worker adds
 * its page token and restores the tab's request number, which `REPORT_ROUTING_RESERVE` leaves room for.
 */
export const REPORT_MESSAGE_LIMIT = 900 * 1024;

export const REPORT_ROUTING_RESERVE = 1024;

/** Images considered for one report; the rest show as placeholders unread. */
export const REPORT_IMAGES_CONSIDERED = 100;

/**
 * `path` is the canonical file the board verified. A failure carries it only where the file is readable but cannot be
 * shown on the board, so a refused path never reaches the editor.
 */
export type RenderedReport =
  | { ok: true; name: string; path: string; modifiedAt: number; html: string }
  | { ok: false; name: string | null; path?: string; failure: string };

/** The whole answer for a given HTML, so its size can be counted before the HTML is chosen. */
export type ReportEnvelope = (html: string) => unknown;

const SIGNATURES: readonly { type: string; test: (head: Buffer) => boolean }[] = [
  { type: 'png', test: (head) => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'jpeg', test: (head) => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
  { type: 'gif', test: (head) => ['GIF87a', 'GIF89a'].includes(head.subarray(0, 6).toString('latin1')) },
  { type: 'webp', test: (head) => head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP' },
];

/** A file opened for reading, confirmed to be the one its canonical path names. */
type Opened = { handle: FileHandle; path: string; size: number; modifiedAt: number };

type Refused = { refused: 'absent' | 'outside' | 'network' | 'unreadable' };

/**
 * Render one run's Markdown report for a client (R51). Raw HTML shows as text; only `http`/`https` links stay
 * links; an image is inlined only from a verified image file inside the report's directory, while the answer that
 * `envelope` builds stays within `REPORT_MESSAGE_LIMIT` less the routing reserve.
 */
export async function renderReport(auditPath: string, envelope: ReportEnvelope): Promise<RenderedReport> {
  const name = basename(auditPath);

  if (!isAbsolute(auditPath) || networkPath(auditPath)) {
    return { ok: false, name, failure: 'The run named its report by a path the board does not read.' };
  }

  const opened = await openVerified(auditPath, null);

  if ('refused' in opened) {
    return { ok: false, name, failure: opened.refused === 'network' ? 'The run named its report by a path the board does not read.' : 'The report file is missing or cannot be read.' };
  }

  let markdown: string;

  try {
    if (opened.size > REPORT_FILE_LIMIT) {
      return { ok: false, name, path: opened.path, failure: `The report is ${kilobytes(opened.size)}, more than the ${kilobytes(REPORT_FILE_LIMIT)} the board shows.` };
    }

    markdown = (await readBounded(opened.handle, REPORT_FILE_LIMIT)).toString('utf8');
  } catch {
    return { ok: false, name, failure: 'The report file is missing or cannot be read.' };
  } finally {
    await opened.handle.close();
  }

  const directory = dirname(opened.path);

  try {
    const html = await layout(markdown, directory, envelope);

    return 'failure' in html
      ? { ok: false, name, path: opened.path, failure: html.failure }
      : { ok: true, name, path: opened.path, modifiedAt: opened.modifiedAt, html: html.html };
  } catch {
    // A pathological document, such as thousands of nested quotes, can exhaust the parser's stack.
    return { ok: false, name, path: opened.path, failure: 'The report could not be rendered.' };
  }
}

async function layout(markdown: string, directory: string, envelope: ReportEnvelope): Promise<{ html: string } | { failure: string }> {
  const budget = REPORT_MESSAGE_LIMIT - REPORT_ROUTING_RESERVE;
  const size = (html: string): number => Buffer.byteLength(JSON.stringify(envelope(html)), 'utf8');
  const tokens = new Marked({ gfm: true }).lexer(markdown);
  // Each source in document order, with how many times the report shows it: every occurrence carries the image.
  const uses = new Map<string, number>();

  new Marked().walkTokens(tokens, (token) => {
    if (token.type === 'image') uses.set((token as Tokens.Image).href, (uses.get((token as Tokens.Image).href) ?? 0) + 1);
  });

  const sources = [...uses.keys()];
  const images = new Map<string, { dataUri: string } | { missing: string }>();

  for (const source of sources.slice(REPORT_IMAGES_CONSIDERED)) {
    images.set(source, { missing: `not shown: the report names over ${REPORT_IMAGES_CONSIDERED} images` });
  }

  let used = size(render(tokens, images));

  if (used > budget) {
    return { failure: `The report is too large to show on the board (${kilobytes(used)} rendered).` };
  }

  // In document order, read an image only while its encoded size could still fit, so a report naming many large
  // images reads few of them. Each inlined image costs its tag over its placeholder.
  for (const source of sources.slice(0, REPORT_IMAGES_CONSIDERED)) {
    const count = uses.get(source) ?? 1;
    const image = await readImage(source, directory, Math.floor((budget - used) / count));

    images.set(source, image);

    if ('dataUri' in image) {
      const added = cost(image.dataUri, source) * count;

      if (used + added > budget) {
        images.set(source, { missing: 'too large to show here' });
      } else {
        used += added;
      }
    }
  }

  let html = render(tokens, images);

  // The per-image cost omits alt text; drop inlined images from the end until the measured answer fits.
  for (const source of [...sources].reverse()) {
    if (size(html) <= budget) break;

    const image = images.get(source);

    if (image !== undefined && 'dataUri' in image) {
      images.set(source, { missing: 'too large to show here' });
      html = render(tokens, images);
    }
  }

  // Placeholders naming why an image is missing can outgrow the text measured first.
  const final = size(html);

  return final > budget ? { failure: `The report is too large to show on the board (${kilobytes(final)} rendered).` } : { html };
}

/** Bytes an inlined image adds to the JSON answer over its placeholder, alt text aside. */
function cost(dataUri: string, source: string): number {
  return Buffer.byteLength(JSON.stringify(`<img src="${dataUri}" alt="">`), 'utf8') -
    Buffer.byteLength(JSON.stringify(`<em>[Image ${escapeHtml(fileName(source))}: too large to show here]</em>`), 'utf8');
}

function render(tokens: Token[], images: ReadonlyMap<string, { dataUri: string } | { missing: string }>): string {
  const marked = new Marked({
    gfm: true,
    renderer: {
      html: ({ text }) => escapeHtml(text),
      link({ href, tokens: inner }) {
        const text = this.parser.parseInline(inner);

        return /^https?:\/\//i.test(href) ? `<a href="${escapeHtml(href)}">${text}</a>` : text;
      },
      image: ({ href, text }) => {
        const image = images.get(href);

        if (image !== undefined && 'dataUri' in image) {
          return `<img src="${image.dataUri}" alt="${escapeHtml(text)}">`;
        }

        return `<em>[Image ${escapeHtml(fileName(href))}: ${image?.missing ?? 'too large to show here'}]</em>`;
      },
    },
  });

  return marked.parser(structuredClone(tokens));
}

/**
 * Resolve an image against the report's directory, then, for older reports that name it from the worktree root,
 * against that root. Either way the file must lie inside the report's directory. An image whose encoded size could
 * not fit in `room` is not read.
 */
async function readImage(source: string, directory: string, room: number): Promise<{ dataUri: string } | { missing: string }> {
  let decoded: string;

  try {
    decoded = decodeURIComponent(source);
  } catch {
    return { missing: 'not a path the board reads' };
  }

  // A scheme (which includes a drive letter), a rooted path, or a NUL is never a report-relative image.
  if (decoded === '' || /^[a-z][a-z0-9+.-]*:/i.test(decoded) || /^[\\/]/.test(decoded) || decoded.includes('\0')) {
    return { missing: 'not a file beside the report' };
  }

  const root = await worktreeRoot(directory);
  const candidates = [resolve(directory, decoded), ...(root === null ? [] : [resolve(root, decoded)])];

  for (const candidate of candidates) {
    const opened = await openVerified(candidate, directory);

    if ('refused' in opened) {
      if (opened.refused === 'absent') continue;

      return { missing: opened.refused === 'outside' || opened.refused === 'network' ? 'outside the report’s folder' : 'cannot be read' };
    }

    try {
      if (opened.size > REPORT_IMAGE_LIMIT) return { missing: `over ${kilobytes(REPORT_IMAGE_LIMIT)}` };
      if (Math.ceil(opened.size / 3) * 4 > room) return { missing: 'too large to show here' };

      const bytes = await readBounded(opened.handle, REPORT_IMAGE_LIMIT);
      const type = SIGNATURES.find((signature) => signature.test(bytes))?.type;

      return type === undefined ? { missing: 'not a PNG, JPEG, GIF, or WebP image' } : { dataUri: `data:image/${type};base64,${bytes.toString('base64')}` };
    } catch {
      return { missing: 'cannot be read' };
    } finally {
      await opened.handle.close();
    }
  }

  return { missing: 'not found' };
}

/**
 * Open `path` and confirm the opened file is the regular file its canonical path names, and, with `within`, that
 * the canonical path lies inside that directory. The canonical path is read after opening, so a link swapped in
 * between shows as a different file rather than being followed.
 */
async function openVerified(path: string, within: string | null): Promise<Opened | Refused> {
  let handle: FileHandle;

  try {
    handle = await open(path, 'r');
  } catch (error: unknown) {
    return { refused: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable' };
  }

  try {
    const held = await handle.stat({ bigint: true });
    const canonical = await realpath(path);

    if (networkPath(canonical)) return fail(handle, 'network');
    if (within !== null && !inside(within, canonical)) return fail(handle, 'outside');

    const named = await stat(canonical, { bigint: true });

    if (!held.isFile() || named.ino !== held.ino || named.dev !== held.dev) return fail(handle, 'unreadable');

    return { handle, path: canonical, size: Number(held.size), modifiedAt: Number(held.mtimeMs) };
  } catch {
    return fail(handle, 'unreadable');
  }
}

async function fail(handle: FileHandle, refused: Refused['refused']): Promise<Refused> {
  await handle.close();

  return { refused };
}

/** A UNC, device, or other double-separator path, which the board never reads. */
function networkPath(path: string): boolean {
  return /^[\\/]{2}/.test(path);
}

/** Whether `file` is inside `directory`, by path components, so `round-1-extra` is not inside `round-1`. */
function inside(directory: string, file: string): boolean {
  const path = relative(directory, file);

  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

/** The nearest ancestor of `directory`, itself included, that holds `.git`. */
async function worktreeRoot(directory: string): Promise<string | null> {
  let current = directory;

  for (;;) {
    try {
      await stat(join(current, '.git'));

      return current;
    } catch {
      const parent = dirname(current);

      if (parent === current) return null;
      current = parent;
    }
  }
}

async function readBounded(handle: FileHandle, limit: number): Promise<Buffer> {
  const buffer = Buffer.alloc(limit + 1);
  const { bytesRead } = await handle.read(buffer, 0, limit + 1, 0);

  if (bytesRead > limit) throw new Error('grew past its limit while being read');

  return buffer.subarray(0, bytesRead);
}

function fileName(source: string): string {
  return source.split(/[\\/]/).pop() || source;
}

function kilobytes(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} kB`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}
