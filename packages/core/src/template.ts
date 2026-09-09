/**
 * Substitute only own keys of values and preserve unknown placeholders. Object.hasOwn prevents inherited names
 * such as constructor and toString from being inserted into user prompts.
 */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) => (Object.hasOwn(values, name) ? values[name] ?? whole : whole));
}

/** New-session prompt placeholders. Cards have no branch field; only automation obtains one from PR context. */
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
