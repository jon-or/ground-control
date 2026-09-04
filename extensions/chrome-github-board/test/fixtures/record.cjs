// Records the GitHub project board markup the overlay paints onto. Run: `npm run record --workspace
// @ground-control/chrome-github-board`. The source is a public board, so this needs no login and no token; the
// scrub still runs, because the board is somebody's real work.
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { chromium } = require('playwright');
const { COLUMNS, ISSUES, REPO, assertScrubbed, titles } = require('./anonymise.cjs');

/** GitHub's own public roadmap, in its board view. Public, so a recording needs no account of the developer's. */
const SOURCE = 'https://github.com/orgs/github/projects/4247/views/21';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto(SOURCE, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-board-card-id]');

  const captured = await page.evaluate(
    ({ issues, names, repo, columns }) => {
      const region = document.getElementById('project-items-region');
      const clone = region.cloneNode(true);
      const recorded = [];

      // Two columns is enough to prove the overlay walks all of them, and an empty one is the shape a fresh board
      // has. Trimming is by removing whole nodes: nothing kept is rewritten except the values being scrubbed.
      const kept = [...clone.querySelectorAll('[data-board-column]')];
      const empty = kept.find((column) => column.querySelectorAll('[data-board-card-id]').length === 0);
      const full = kept.find((column) => column.querySelectorAll('[data-board-card-id]').length >= issues.length);

      for (const column of kept) {
        if (column !== empty && column !== full) {
          column.remove();
        }
      }

      for (const [index, column] of [empty, full].entries()) {
        recorded.push(column.getAttribute('data-board-column'), column.getAttribute('data-dnd-drag-id'), column.id);
        column.setAttribute('data-board-column', columns[index]);
        column.setAttribute('data-dnd-drag-id', `column-${index}`);
        column.id = `column-${index}`;

        const heading = column.querySelector('h2');

        if (heading) {
          recorded.push(heading.textContent);
          heading.textContent = columns[index];
        }
      }

      const cards = [...full.querySelectorAll('[data-board-card-id]')];

      for (const card of cards.slice(issues.length)) {
        card.remove();
      }

      for (const [index, card] of cards.slice(0, issues.length).entries()) {
        const number = issues[index];
        const itemId = String(20_000 + number);
        const wasItem = card.getAttribute('data-board-card-id');

        recorded.push(wasItem, card.getAttribute('data-hovercard-subject-tag'));

        for (const element of [card, ...card.querySelectorAll('*')]) {
          for (const attribute of [...element.attributes]) {
            if (attribute.value.includes(wasItem)) {
              element.setAttribute(attribute.name, attribute.value.split(wasItem).join(itemId));
            }
          }
        }

        card.setAttribute('data-hovercard-subject-tag', `issue:${number}`);

        const link = card.querySelector('a[href*="/issues/"]');

        recorded.push(link.getAttribute('href'));
        link.setAttribute('href', `https://github.com/${repo}/issues/${number}`);

        // Free text is replaced wholesale, never matched: an issue title is the author's own words and no list of
        // ids will ever cover one.
        const heading = card.querySelector('h3 span') ?? card.querySelector('h3');

        recorded.push(heading.textContent);
        heading.textContent = names[index];

        const header = card.querySelector('[id^="board-card-header-title"]');

        recorded.push(header.textContent);
        header.textContent = `${repo.split('/')[1]} #${number}`;

        // Labels are free text too, and nothing here reads them. Removed whole rather than rewritten.
        card.querySelector('ul[aria-label="Fields"]')?.remove();
      }

      // The filter bar, trimmed to the View button alone: the overlay hangs its own button beside that one and
      // copies its classes, and the filter input beside it is the developer's own words.
      const bar = document.querySelector('[role="region"][aria-label="View filters"]').cloneNode(true);
      const view = [...bar.querySelectorAll('button[data-component="Button"]')].find(
        (button) => button.textContent.trim() === 'View',
      );

      for (const child of [...bar.children]) {
        if (!child.contains(view)) {
          child.remove();
        }
      }

      // Icons only, and they carry paths the tests never walk. Dropping them keeps the fixture readable.
      for (const svg of [...clone.querySelectorAll('svg'), ...bar.querySelectorAll('svg')]) {
        svg.remove();
      }

      return { html: clone.outerHTML, bar: bar.outerHTML, recorded: recorded.filter(Boolean) };
    },
    { issues: ISSUES, names: titles(), repo: REPO, columns: COLUMNS },
  );

  await browser.close();

  let html = `${captured.bar}${captured.html}`;

  for (const value of captured.recorded) {
    if (String(value).length > 2) {
      html = html.split(String(value)).join('scrubbed');
    }
  }

  const document = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><title>Project board</title></head>',
    `<body><div class="Board-module__boardContainer">${html}</div></body></html>`,
    '',
  ].join('\n');

  assertScrubbed(document, captured.recorded);
  writeFileSync(join(__dirname, 'project-board.html'), document);

  process.stdout.write(`Recorded ${ISSUES.length} cards from ${SOURCE}.\n`);
}

void main();
