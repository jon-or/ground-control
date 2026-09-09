// Record public GitHub board markup with npm run record --workspace @ground-control/chrome-github-board. No
// login is needed; scrub all recorded data.
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { chromium } = require('playwright');
const { ASSIGNED, ASSIGNEE, AVATAR, COLUMNS, ISSUES, PROJECT, REPO, VIEWS, assertScrubbed, titles } = require('./anonymise.cjs');

/** GitHub's own public roadmap, in its board view. Public, so a recording needs no account of the developer's. */
const SOURCE = 'https://github.com/orgs/github/projects/4247/views/21';

/**
 * Record an assignee stack from the first available public board and insert it into the roadmap fixture, which
 * has no assignees.
 */
const ASSIGNEE_SOURCES = [
  'https://github.com/orgs/nodejs/projects/14',
  'https://github.com/orgs/nodejs/projects/11',
  'https://github.com/orgs/rust-lang/projects/69',
];

/**
 * Record and scrub one real assignee stack. Replace the login in its caption, alt text, and tooltip. Read the
 * generated tooltip ID from the markup so reuse cannot create duplicate IDs.
 *
 * @returns {Promise<{ html: string, tooltipId: string, recorded: string[] }>}
 */
async function recordAssigneeStack(browser) {
  for (const url of ASSIGNEE_SOURCES) {
    const page = await browser.newPage();

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForSelector('[data-board-card-id]', { timeout: 20_000 });

      const found = await page.evaluate(() => {
        for (const card of document.querySelectorAll('[data-board-card-id]')) {
          const figure = card.querySelector('[data-component="AvatarStack"]')?.closest('figure');
          const image = figure?.querySelector('img[alt]');
          const tooltipId = figure?.querySelector('[aria-labelledby]')?.getAttribute('aria-labelledby');

          if (figure && image && tooltipId && figure.querySelectorAll('img').length === 1) {
            return { html: figure.outerHTML, login: image.getAttribute('alt'), src: image.getAttribute('src'), tooltipId };
          }
        }

        return null;
      });

      await page.close();

      if (found) {
        // Match avatar URLs by pattern because getAttribute decodes ampersands that remain escaped in
        // serialized HTML.
        const html = found.html
          .split(found.login)
          .join(ASSIGNEE)
          .replace(/https:\/\/avatars\.githubusercontent\.com\/[^"'\s]+/g, AVATAR);

        process.stdout.write(`Recorded an assignee stack from ${url}.\n`);

        return { html, tooltipId: found.tooltipId, recorded: [found.login, found.src] };
      }
    } catch (error) {
      // Named, because a board that timed out and an `evaluate` that threw read identically from the message below.
      console.log(`No assignee stack from ${url}: ${error}`);
      await page.close();
    }
  }

  throw new Error(`No public board in ${ASSIGNEE_SOURCES.join(', ')} showed an assignee stack.`);
}

async function main() {
  const browser = await chromium.launch();
  const stack = await recordAssigneeStack(browser);
  const page = await browser.newPage();

  await page.goto(SOURCE, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-board-card-id]');

  // Type a filter to reveal unsaved-filter controls. Anonymous recording exposes Discard; Save requires write
  // access.
  const filter = page.locator('[role="region"][aria-label="View filters"] input').first();

  await filter.click();
  await filter.type(' label:example');
  await page.getByRole('button', { name: 'Discard', exact: true }).waitFor();

  const captured = await page.evaluate(
    ({ issues, names, repo, columns, project, viewNames, assigned, assigneeStack, tooltipId }) => {
      const region = document.getElementById('project-items-region');
      const clone = region.cloneNode(true);
      const recorded = [];

      // Keep two columns, including one empty column, to test traversal. Trim whole nodes and rewrite only
      // scrubbed values.
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

        // Insert the recorded stack in the existing empty header slot. Leave one card unassigned to test the
        // no-replacement case.
        if (assigned.includes(number)) {
          const slot = card.querySelector('[id^="board-card-header-title"]').parentElement.parentElement.lastElementChild;

          if (slot.childElementCount > 0) {
            throw new Error('The assignee slot is no longer the empty last child of the card header.');
          }

          // Avoid inserting a second copy of the tooltip ID referenced by aria-labelledby.
          slot.innerHTML = assigneeStack.split(tooltipId).join(`_r_a${number}_`);
        }
      }

      // Keep the View button and unsaved-filter actions for menu insertion and collapse tests. Remove free
      // text from the filter input.
      const bar = document.querySelector('[role="region"][aria-label="View filters"]').cloneNode(true);
      const wanted = ['View', 'Discard'].map((word) =>
        [...bar.querySelectorAll('button')].find((button) => button.textContent.trim() === word),
      );

      for (const child of [...bar.children]) {
        if (!wanted.some((button) => button && child.contains(button))) {
          child.remove();
        }
      }

      // Keep the project title and two view tabs for collapse tests; remove unrelated profile images.
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

      // Remove unused view menus, duplicate tooltips, and the new-view button as whole nodes.
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
    {
      issues: ISSUES,
      names: titles(),
      repo: REPO,
      columns: COLUMNS,
      project: PROJECT,
      viewNames: VIEWS,
      assigned: ASSIGNED,
      assigneeStack: stack.html,
      tooltipId: stack.tooltipId,
    },
  );

  await browser.close();

  // Preserve recorded nesting: title bar beside the view root, with tabs as its first child. Collapse
  // behavior depends on these ancestor relationships.
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

  assertScrubbed(document, [...captured.recorded, ...stack.recorded]);
  writeFileSync(join(__dirname, 'project-board.html'), document);

  process.stdout.write(`Recorded ${ISSUES.length} cards from ${SOURCE}.\n`);
}

void main();
