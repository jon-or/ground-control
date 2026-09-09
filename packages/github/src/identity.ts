/** Read all accounts from gh auth status. gh api user returns only the active account (R28). */
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
