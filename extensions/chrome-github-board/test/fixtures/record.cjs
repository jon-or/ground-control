// Records the GitHub project board markup the overlay paints onto. Run: `npm run record --workspace
// @ground-control/chrome-github-board`. The source is a public board, so this needs no login and no token; the
// scrub still runs, because the board is somebody's real work.
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { chromium } = require('playwright');
const { COLUMNS, ISSUES, PROJECT, REPO, VIEWS, assertScrubbed, titles } = require('./anonymise.cjs');

/** GitHub's own public roadmap, in its board view. Public, so a recording needs no account of the developer's. */
const SOURCE = 'https://github.com/orgs/github/projects/4247/views/21';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto(SOURCE, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-board-card-id]');

  // Typing into the filter is what makes GitHub draw the Save and Discard the collapse folds away. An anonymous
  // visitor gets Discard alone — Save needs write access to the board, and no public recording will ever show one.
  const filter = page.locator('[role="region"][aria-label="View filters"] input').first();

  await filter.click();
  await filter.type(' label:example');
  await page.getByRole('button', { name: 'Discard', exact: true }).waitFor();

  const captured = await page.evaluate(
    ({ issues, names, repo, columns, project, viewNames }) => {
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

      // The filter bar, trimmed to the View button and the unsaved-filter actions: the overlay hangs its own
      // button beside the first and folds the second away, and the filter input between them is the developer's
      // own words.
      const bar = document.querySelector('[role="region"][aria-label="View filters"]').cloneNode(true);
      const wanted = ['View', 'Discard'].map((word) =>
        [...bar.querySelectorAll('button')].find((button) => button.textContent.trim() === word),
      );

      for (const child of [...bar.children]) {
        if (!wanted.some((button) => button && child.contains(button))) {
          child.remove();
        }
      }

      // The two rows the overlay's collapse folds away: the project's title bar, trimmed to the title itself
      // because the rest of it is the team's own faces, and the row of view tabs, trimmed to two.
      const nav = document.querySelector('[role="navigation"][aria-label="Project"]').cloneNode(true);

      for (const child of [...nav.children].slice(1)) {
        child.remove();
      }

      const heading = nav.querySelector('h1');

      recorded.push(heading.textContent);
      heading.textContent = project;

      let tabRow = document.querySelector('nav[aria-label="Select view"]');

      while (tabRow.parentElement && tabRow.parentElement.id !== 'memex-project-view-root') {
        tabRow = tabRow.parentElement;
      }

      tabRow = tabRow.cloneNode(true);

      // Each tab carries a menu button and a tooltip that repeat the view's name, and the row ends in a new-view
      // button. Nothing here reads any of them, so they go whole rather than being rewritten.
      for (const extra of tabRow.querySelectorAll('button, [data-component="Tooltip"]')) {
        extra.remove();
      }

      const tabs = [...tabRow.querySelectorAll('[role="tab"]')];

      for (const tab of tabs.slice(viewNames.length)) {
        tab.remove();
      }

      // A view's name is the team's own word for it, and it is written into the tab twice — the title and the text.
      for (const [index, tab] of tabs.slice(0, viewNames.length).entries()) {
        recorded.push(tab.getAttribute('title'), tab.getAttribute('href'));
        tab.setAttribute('title', viewNames[index]);
        tab.removeAttribute('href');

        const walker = document.createTreeWalker(tab, NodeFilter.SHOW_TEXT);
        let named = false;

        while (walker.nextNode()) {
          const node = walker.currentNode;

          if (node.textContent.trim() === '') {
            continue;
          }

          recorded.push(node.textContent);
          node.textContent = named ? '' : viewNames[index];
          named = true;
        }
      }

      // Icons only, and they carry paths the tests never walk. Dropping them keeps the fixture readable.
      for (const svg of [...clone.querySelectorAll('svg'), ...bar.querySelectorAll('svg'), ...nav.querySelectorAll('svg'), ...tabRow.querySelectorAll('svg')]) {
        svg.remove();
      }

      return {
        html: clone.outerHTML,
        bar: bar.outerHTML,
        nav: nav.outerHTML,
        views: tabRow.outerHTML,
        recorded: recorded.filter(Boolean),
      };
    },
    { issues: ISSUES, names: titles(), repo: REPO, columns: COLUMNS, project: PROJECT, viewNames: VIEWS },
  );

  await browser.close();

  // Nesting as the page serves it: the project's title bar is a sibling of the view root, and the tab row is the
  // view root's first child. The overlay's collapse climbs that shape, so a flattened fixture would prove nothing.
  let nav = captured.nav;

  let html = `${captured.views}<div class="Board-module__boardContainer">${captured.bar}${captured.html}</div>`;

  for (const value of captured.recorded) {
    if (String(value).length > 2) {
      html = html.split(String(value)).join('scrubbed');
      nav = nav.split(String(value)).join('scrubbed');
    }
  }

  const document = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><title>Project board</title></head>',
    `<body>${nav}<div id="memex-project-view-root">${html}</div></body></html>`,
    '',
  ].join('\n');

  assertScrubbed(document, captured.recorded);
  writeFileSync(join(__dirname, 'project-board.html'), document);

  process.stdout.write(`Recorded ${ISSUES.length} cards from ${SOURCE}.\n`);
}

void main();
