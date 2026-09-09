/**
 * Substitute only own keys of values and preserve unknown placeholders. Object.hasOwn prevents inherited names
 * such as constructor and toString from being inserted into user prompts.
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
