import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPORT_FILE_LIMIT, REPORT_IMAGES_CONSIDERED, REPORT_MESSAGE_LIMIT, REPORT_ROUTING_RESERVE, renderReport } from '../src/report.js';

const BUDGET = REPORT_MESSAGE_LIMIT - REPORT_ROUTING_RESERVE;

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);

let worktree: string;
let round: string;

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), 'gc-report-'));
  mkdirSync(join(worktree, '.git'));
  round = join(worktree, '.wip', 'review-pr', 'round-1');
  mkdirSync(join(round, 'screenshots'), { recursive: true });
  writeFileSync(join(round, 'screenshots', 'one.png'), PNG);
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

const envelope = (html: string) => ({ type: 'report', id: 'issue:1@1', request: 1, title: 'Answer review · #1', name: 'review.md', html, failure: null });

async function render(markdown: string, file = 'review.md') {
  writeFileSync(join(round, file), markdown);

  return renderReport(join(round, file), envelope);
}

async function html(markdown: string): Promise<string> {
  const rendered = await render(markdown);

  if (!rendered.ok) throw new Error(rendered.failure);

  return rendered.html;
}

describe('rendering a run report (R51)', () => {
  it('renders GitHub Markdown: headings, tables, task lists, and code', async () => {
    const out = await html('# Round 1\n\n| Finding | Verdict |\n|---|---|\n| B1 | Verified |\n\n- [x] fixed\n- [ ] open\n\n`a < b`');

    expect(out).toContain('<h1>Round 1</h1>');
    expect(out).toContain('<td>Verified</td>');
    expect(out).toMatch(/<input checked="" disabled="" type="checkbox">/);
    expect(out).toContain('<code>a &lt; b</code>');
  });

  it('shows raw HTML as text rather than markup', async () => {
    const out = await html('<img src=x onerror=alert(1)>\n\nhello <script>alert(1)</script>');

    expect(out).not.toMatch(/<img|<script/);
    expect(out).toContain('&#60;script&#62;');
  });

  it('keeps collapsible sections and inline formatting tags as GitHub renders them, with Markdown inside', async () => {
    const out = await html('<details open>\n<summary><b>Evidence</b> (2)</summary>\n\n| a |\n|---|\n| 1 |\n\n</details>\n\n<DETAILS><Summary>Raw</Summary>x<br/>y</DETAILS>\n\n<details open=""><summary>a</summary></details>\n\n<details OPEN=\'open\'><summary>b</summary></details>');

    expect(out).toContain('<details open>\n<summary><b>Evidence</b> (2)</summary>');
    expect(out).toContain('<td>1</td>');
    expect(out).toContain('</details>');
    expect(out).toContain('<details><summary>Raw</summary>x<br>y</details>');
    expect(out).toContain('<details open><summary>a</summary></details>');
    expect(out).toContain('<details open><summary>b</summary></details>');
  });

  it('escapes a kept tag that carries an attribute, or a form GitHub does not render', async () => {
    const out = await html('<details ontoggle=alert(1)><summary class="x">s</summary></details>\n\n<b open>b</b> </br> <summary/> <details open=1>');

    expect(out).toContain('&#60;details ontoggle=alert(1)&#62;&#60;summary class=&#34;x&#34;&#62;s</summary></details>');
    expect(out).toContain('&#60;b open&#62;b</b> &#60;/br&#62; &#60;summary/&#62; &#60;details open=1&#62;');
  });

  it('keeps web links and turns every other link into its text', async () => {
    const out = await html('[pr](https://github.com/o/r/pull/1) [local](../../secrets.md) [js](javascript:alert(1)) [file](file:///C:/x)');

    expect(out).toContain('<a href="https://github.com/o/r/pull/1">pr</a>');
    expect(out).not.toMatch(/href="(?!https:)/);
    expect(out).toContain('local');
  });

  it('inlines an image beside the report, and one an older report names from the worktree root', async () => {
    const out = await html('![beside](screenshots/one.png)\n\n![rooted](.wip/review-pr/round-1/screenshots/one.png)');

    expect(out.match(/<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="(beside|rooted)">/g)).toHaveLength(2);
  });

  it.each([
    ['a parent path', '../outside.png', 'outside the report’s folder'],
    ['a percent-encoded parent path', '..%2Foutside.png', 'outside the report’s folder'],
    ['a rooted path', '/etc/passwd', 'not a file beside the report'],
    ['a drive path', 'C:/Windows/win.ini', 'not a file beside the report'],
    ['a file URL', 'file:///C:/Windows/win.ini', 'not a file beside the report'],
    ['a web image', 'https://example.com/track.png', 'not a file beside the report'],
    ['a data URI', 'data:image/svg+xml;base64,PHN2Zz4=', 'not a file beside the report'],
    ['a missing file', 'screenshots/none.png', 'not found'],
  ])('refuses %s', async (_, source, why) => {
    writeFileSync(join(round, '..', 'outside.png'), PNG);

    const out = await html(`![x](${source})`);

    expect(out).not.toContain('<img');
    expect(out).toContain(`: ${why}]`);
  });

  it('refuses a sibling folder whose name starts with the report folder’s', async () => {
    const sibling = join(round, '..', 'round-1-extra');
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'one.png'), PNG);

    expect(await html('![x](../round-1-extra/one.png)')).toContain('outside the report’s folder');
  });

  it('refuses an image that a link inside the folder points outside it', async () => {
    const elsewhere = join(worktree, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'one.png'), PNG);
    symlinkSync(elsewhere, join(round, 'linked'), 'junction');

    expect(await html('![x](linked/one.png)')).toContain('outside the report’s folder');
  });

  it('refuses a file named as an image that is not one, and an SVG', async () => {
    writeFileSync(join(round, 'screenshots', 'fake.png'), '<svg onload="alert(1)"></svg>');
    writeFileSync(join(round, 'screenshots', 'real.svg'), '<svg></svg>');

    const out = await html('![a](screenshots/fake.png) ![b](screenshots/real.svg)');

    expect(out).not.toContain('<img');
    expect(out.match(/not a PNG, JPEG, GIF, or WebP image/g)).toHaveLength(2);
  });

  it('shows images past the answer budget as placeholders, in document order', async () => {
    // Incompressible bytes behind a PNG signature, so each inlined image costs its full base64 size.
    const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(400 * 1024, 7)]);
    writeFileSync(join(round, 'screenshots', 'a.png'), big);
    writeFileSync(join(round, 'screenshots', 'b.png'), big);

    const out = await html('![a](screenshots/a.png)\n\n![b](screenshots/b.png)');

    expect(out.match(/<img /g)).toHaveLength(1);
    expect(out).toContain('alt="a"');
    expect(out).toContain('[Image b.png: too large to show here]');
    expect(Buffer.byteLength(JSON.stringify(envelope(out)), 'utf8')).toBeLessThanOrEqual(BUDGET);
  });

  it('refuses a report whose rendered text alone is over the answer budget', async () => {
    // 300 kB of `<`, each escaped to four bytes: within the file bound, over the answer budget once rendered.
    const rendered = await render('<'.repeat(300 * 1024));

    expect(rendered).toMatchObject({ ok: false, failure: expect.stringMatching(/^The report is too large to show on the board \(\d+ kB rendered\)\.$/) });
  });

  it('counts the answer in UTF-8 bytes, not characters', async () => {
    // Three-byte characters with one image left to fit: counted in characters, the image would be inlined past the budget.
    writeFileSync(join(round, 'screenshots', 'a.png'), Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(350 * 1024, 7)]));

    const out = await html(`${'€'.repeat(170_000)}

![a](screenshots/a.png)`);

    expect(out).not.toContain('<img');
    expect(Buffer.byteLength(JSON.stringify(envelope(out)), 'utf8')).toBeLessThanOrEqual(BUDGET);
  });

  it('refuses a report file over its size bound before reading it', async () => {
    const rendered = await render('x'.repeat(REPORT_FILE_LIMIT + 1));

    expect(rendered).toMatchObject({ ok: false, name: 'review.md', failure: expect.stringMatching(/^The report is \d+ kB, more than/) });
  });

  it('does not read an image whose encoded size could no longer fit', async () => {
    writeFileSync(join(round, 'screenshots', 'a.png'), Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(600 * 1024, 7)]));
    // Read, this would show as not an image; unread, it shows as too large.
    writeFileSync(join(round, 'screenshots', 'b.png'), Buffer.alloc(400 * 1024, 7));

    const out = await html('![a](screenshots/a.png)\n\n![b](screenshots/b.png)');

    expect(out).toContain('alt="a"');
    expect(out).toContain('[Image b.png: too large to show here]');
  });

  it('considers only the first images a report names', async () => {
    const names = Array.from({ length: REPORT_IMAGES_CONSIDERED + 1 }, (_, index) => `![i${index}](screenshots/one.png?${index})`);

    const out = await html(names.join('\n\n'));

    expect(out).toContain(`: not shown: the report names over ${REPORT_IMAGES_CONSIDERED} images]`);
  });

  it('counts every place a report shows an image, not just the first', async () => {
    writeFileSync(join(round, 'screenshots', 'a.png'), Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(300 * 1024, 7)]));

    // Counted once, `a` would be inlined and then trimmed from the end along with `one` after it, leaving neither.
    const out = await html([...Array.from({ length: 20 }, () => '![a](screenshots/a.png)'), '![one](screenshots/one.png)'].join('\n\n'));

    expect(out).not.toContain('alt="a"');
    expect(out).toContain('[Image a.png: too large to show here]');
    expect(out).toContain('alt="one"');
  });

  it('refuses a report whose placeholders alone outgrow the answer', async () => {
    const missing = Array.from({ length: REPORT_IMAGES_CONSIDERED }, (_, index) => `![m](m${index}.png)`);
    const repeated = Array.from({ length: 15_000 }, () => '![x](x.png)');

    expect(await render([...missing, ...repeated].join(' '))).toMatchObject({ ok: false, failure: expect.stringMatching(/^The report is too large to show on the board/) });
  }, 30_000);

  it('says a report too deeply nested to parse could not be rendered', async () => {
    expect(await render(`${'> '.repeat(10_000)}text`)).toEqual({ ok: false, name: 'review.md', path: join(round, 'review.md'), failure: 'The report could not be rendered.' });
  });

  it('says so where the report is gone', async () => {
    expect(await renderReport(join(round, 'gone.md'), envelope)).toEqual({ ok: false, name: 'gone.md', failure: 'The report file is missing or cannot be read.' });
  });

  it('refuses a path that is not absolute, or a device or network path', async () => {
    for (const path of ['review.md', '\\\\?\\C:\\x\\review.md', '\\\\server\\share\\review.md']) {
      const refused = await renderReport(path, envelope);

      expect(refused).toMatchObject({ ok: false, failure: 'The report is named by a path the board does not read.' });
      expect(refused).not.toHaveProperty('path');
    }
  });

  it('reads the file afresh each time, so an edit shows', async () => {
    const first = await html('# One');
    const second = await html('# Two');

    expect([first, second]).toEqual(['<h1>One</h1>\n', '<h1>Two</h1>\n']);
  });
});
