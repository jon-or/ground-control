/**
 * The template with the board's own facts in it. The keys of `values` are the whole of what is substituted, and a
 * name that is not one of them is left exactly as typed rather than emptied: a prompt that came out half-substituted
 * would still run, and a run is not a thing to guess at. A developer's own prompt may contain braces of its own.
 *
 * `Object.hasOwn`, not a lookup: every object literal inherits `constructor`, `toString` and the rest, and a plain
 * read would substitute those into a prompt that merely mentions one.
 */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) => (Object.hasOwn(values, name) ? values[name] ?? whole : whole));
}

/**
 * What a new session's prompt is filled from, which is also the roster of names it may use. `{branch}` is
 * deliberately absent: a card carries no branch of its own — automation reads one off a pull request — and an
 * unstarted card is the case this verb exists for.
 */
export function newSessionValues(
  card: { issueNumber: number | null; issue: { title: string; url: string; repository?: string } | null },
  checkout: string,
): Record<string, string> {
  const { issue } = card;

  return {
    issue: card.issueNumber === null ? '' : String(card.issueNumber),
    repo: issue?.repository ?? '',
    title: issue?.title ?? '',
    url: issue?.url ?? '',
    checkout,
  };
}
