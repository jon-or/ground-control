import { execFile } from 'node:child_process';
import { z } from 'zod';
import { spawnable } from '@ground-control/core';
import type { ReadFailure, SourceReading, WorkSource } from '@ground-control/core';
import { parseAuthStatusLogins } from './identity.js';
import { fetchAssignedIssues } from './issues.js';
import type { AssignedIssues, GithubConfig, Result } from './types.js';

export const GITHUB_SOURCE_ID = 'github';

/**
 * The GitHub entry in a pushed configuration. Parsed rather than trusted, because a client is not necessarily this
 * editor: `ghPath` becomes a process, and `maxPages` bounds how much of someone's GitHub a client can ask for.
 */
const github = z
  .object({
    ghPath: spawnable.default('gh'),
    repo: z.string().min(1),
    logins: z.array(z.string()).default([]),
    projectNumber: z.number().int().nonnegative().default(0),
    cardSource: z.enum(['project', 'issueSearch']).default('project'),
    maxPages: z.number().int().min(1).max(20).default(5),
  })
  .strict();

/** Nothing has been said about this source yet — a hub the browser started alone. Not something a developer broke. */
function unconfigured(raw: unknown): boolean {
  return raw === undefined || raw === null || (typeof raw === 'object' && Object.keys(raw).length === 0);
}

export function readGithubConfig(raw: unknown): { config: GithubConfig } | { failure: ReadFailure } {
  if (unconfigured(raw)) {
    return {
      failure: {
        subject: GITHUB_SOURCE_ID,
        kind: 'bad-config',
        message: 'The board has not been told which repository your work is tracked in.',
        remedy: 'Set groundControl.github.repo in Settings.',
      },
    };
  }

  const parsed = github.safeParse(raw);

  if (parsed.success) {
    return { config: parsed.data };
  }

  const issue = parsed.error.issues[0];

  return {
    failure: {
      subject: GITHUB_SOURCE_ID,
      kind: 'bad-config',
      message: `The GitHub settings could not be read: ${issue?.path.join('.') || 'the value'} ${issue?.message ?? 'is not valid'}.`,
      remedy: 'Fix the groundControl.github settings, or remove them to use the defaults.',
    },
  };
}

/** Whose issues these are, seeded from what the CLI already knows. Detected only — adopting one is the developer's (R26). */
export function detectLogins(ghPath: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(ghPath, ['auth', 'status'], { windowsHide: true }, (_error, stdout, stderr) =>
      resolve(parseAuthStatusLogins(`${stdout}${stderr}`)),
    );
  });
}

export interface GithubSourceDeps {
  fetch(config: GithubConfig): Promise<Result<AssignedIssues>>;
  detectLogins(ghPath: string): Promise<string[]>;
}

/**
 * The issues assigned to the developer on the team's project board, as a work source. It holds the last
 * configuration it accepted: a refused one leaves it holding nothing, so a board that is named as misconfigured is
 * never also polled with settings nobody set.
 */
export function makeGithubSource(deps: Partial<GithubSourceDeps> = {}): WorkSource {
  const fetch = deps.fetch ?? ((config: GithubConfig) => fetchAssignedIssues(config));
  const detect = deps.detectLogins ?? detectLogins;

  let held: GithubConfig | null = null;

  return {
    id: GITHUB_SOURCE_ID,
    displayName: 'GitHub',

    configure(raw) {
      const parsed = readGithubConfig(raw);

      if ('failure' in parsed) {
        held = null;

        return parsed.failure;
      }

      held = parsed.config;

      return null;
    },

    async read(): Promise<SourceReading> {
      const config = held;

      if (config === null) {
        return { items: null, failure: null, needs: null };
      }

      // Nobody to read for. Every query is `assignee:`, so there is no read to make and no default that would be
      // anything but somebody else's issues.
      if (config.logins.length === 0) {
        return {
          items: null,
          failure: {
            subject: GITHUB_SOURCE_ID,
            kind: 'no-logins',
            message: 'The board does not know which GitHub account is yours, so it is showing sessions only.',
            remedy:
              'Set groundControl.github.logins in Settings, or run Ground Control: Refresh Board to be asked again.',
          },
          needs: { detected: await detect(config.ghPath) },
        };
      }

      const result = await fetch(config);

      if (!result.ok) {
        return { items: null, failure: { ...result.error, subject: GITHUB_SOURCE_ID }, needs: null };
      }

      const { cards, matched, totalAssigned, notOnProject, truncated, fetchedAt } = result.value;

      return {
        items: { cards, owners: config.logins, matched, totalAssigned, notOnProject, truncated, fetchedAt },
        failure: null,
        needs: null,
      };
    },
  };
}
