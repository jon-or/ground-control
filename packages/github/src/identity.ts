/**
 * Pulls every logged-in account out of `gh auth status`. `gh api user` would name only the active one,
 * and R28 exists because developers routinely hold a human and a bot account at once.
 */
export function parseAuthStatusLogins(output: string): string[] {
  const logins = new Set<string>();

  for (const match of output.matchAll(/Logged in to \S+ account (\S+)/g)) {
    const login = match[1];

    if (login) {
      logins.add(login);
    }
  }

  return [...logins];
}
