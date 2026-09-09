import { execFile } from 'node:child_process';
import { z } from 'zod';
import { DEFAULT_BOARD_POLICY, spawnable } from '@ground-control/core';
import type { BoardPolicy, Logger, ReadFailure } from '@ground-control/core';
import type { CardReading, ContextReading, IssueCard, SourceReading, WorkSource } from '@ground-control/core';
import { fetchCardContext } from './context.js';
import { makeGhRunner } from './gh.js';
import { parseAuthStatusLogins } from './identity.js';
import { fetchAssignedIssues, fetchIssue } from './issues.js';
import type { AssignedIssues, GithubConfig, Result } from './types.js';

export const GITHUB_SOURCE_ID = 'github';

/** Validate client settings: ghPath starts a process and maxPages bounds GitHub reads. */
const github = z
  .object({
    ghPath: spawnable.default('gh'),
    repo: z.string().min(1),
    logins: z.array(z.string()).default([]),
    projectNumber: z.number().int().nonnegative().default(0),
    projectOwner: z.string().trim().default(''),
    statusField: z.string().trim().min(1).default('Status'),
    cardSource: z.enum(['project', 'issueSearch']).default('project'),
    // GitHub search returns at most 1,000 results, so pages past the tenth read nothing.
    maxPages: z.number().int().min(1).max(10).default(5),
  })
  .strict();

/** Detect missing settings, including a hub started by the browser alone. */
function unconfigured(raw: unknown): boolean {
  if (raw === undefined || raw === null || (typeof raw === 'object' && Object.keys(raw).length === 0)) {
    return true;
  }

  // The default editor settings contain a blank repository.
  const repo = (raw as { repo?: unknown }).repo;

  return typeof repo === 'string' && repo.trim().length === 0;
}

/** Client source settings only; the board policy arrives with configure, never from a client. */
export type GithubSettings = Omit<GithubConfig, 'reviewStatuses' | 'avatar'>;

export function readGithubConfig(raw: unknown): { config: GithubSettings } | { failure: ReadFailure } {
  if (unconfigured(raw)) {
    return {
      failure: {
        subject: GITHUB_SOURCE_ID,
        kind: 'bad-config',
        message: 'No GitHub repository is configured.',
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

/** Detect logged-in accounts; the developer chooses which to use (R26). */
export function detectLogins(ghPath: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(ghPath, ['auth', 'status'], { windowsHide: true }, (_error, stdout, stderr) =>
      resolve(parseAuthStatusLogins(`${stdout}${stderr}`)),
    );
  });
}

export interface GithubSourceDeps {
  /** Optional duration logging for gh invocations. */
  log: Logger;
  fetch(config: GithubConfig): Promise<Result<AssignedIssues>>;
  detectLogins(ghPath: string): Promise<string[]>;
  readContext(config: GithubConfig, card: IssueCard, signal: AbortSignal): Promise<ContextReading>;
  readCard(config: GithubConfig, owner: string, name: string, number: number, signal: AbortSignal): Promise<Result<IssueCard | null>>;
}

/** Match github.com owner/name repositories only. Enterprise checkouts remain unlinked (R4). */
function repositoryKeyOf(config: GithubConfig): string {
  return `github.com/${config.repo}`.toLowerCase();
}

/** Read assigned issues with the last accepted configuration. Invalid settings disable reads. */
export function makeGithubSource(deps: Partial<GithubSourceDeps> = {}): WorkSource {
  const fetch = deps.fetch ?? ((config: GithubConfig) => fetchAssignedIssues(config, makeGhRunner(config.ghPath, deps.log)));
  const detect = deps.detectLogins ?? detectLogins;
  const readOne =
    deps.readCard ??
    ((config: GithubConfig, owner: string, name: string, number: number, signal: AbortSignal) =>
      fetchIssue(config, owner, name, number, makeGhRunner(config.ghPath, deps.log), signal));
  const context =
    deps.readContext ??
    ((config: GithubConfig, card: IssueCard, signal: AbortSignal) =>
      fetchCardContext(config, card, makeGhRunner(config.ghPath, deps.log), signal));

  let currentConfig: GithubConfig | null = null;

  return {
    id: GITHUB_SOURCE_ID,
    displayName: 'GitHub',

    configure(raw, board: BoardPolicy = DEFAULT_BOARD_POLICY) {
      const parsed = readGithubConfig(raw);

      if ('failure' in parsed) {
        currentConfig = null;

        return parsed.failure;
      }

      currentConfig = { ...parsed.config, reviewStatuses: [...board.reviewStatuses], avatar: board.avatar };

      return null;
    },

    async read(): Promise<SourceReading> {
      const config = currentConfig;

      if (config === null) {
        return { items: null, failure: null, needs: null };
      }

      // Every query requires an explicit assignee; do not default to another account.
      if (config.logins.length === 0) {
        return {
          items: null,
          failure: {
            subject: GITHUB_SOURCE_ID,
            kind: 'no-logins',
            message: 'No GitHub account is selected. Showing sessions only.',
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

      const { cards, matched, totalAssigned, notOnProject, truncated, fetchedAt, fieldProblem } = result.value;

      return {
        items: { cards, owners: config.logins, matched, totalAssigned, notOnProject, truncated, fetchedAt, fieldProblem },
        failure: null,
        needs: null,
      };
    },

    readContext(card, signal): Promise<ContextReading> {
      // Use only accepted settings for context reads.
      return currentConfig === null
        ? Promise.resolve({
            context: null,
            failure: {
              subject: GITHUB_SOURCE_ID,
              kind: 'bad-config',
              message: 'No GitHub repository is configured.',
              remedy: 'Set groundControl.github.repo in Settings.',
            },
          })
        : context(currentConfig, card, signal);
    },

    async readCard(repository, number, signal): Promise<CardReading | null> {
      // Only query the configured repository. Null means this source does not serve it, not that the issue is missing.
      if (currentConfig === null || repository !== repositoryKeyOf(currentConfig)) {
        return null;
      }

      const [owner = '', name = ''] = currentConfig.repo.split('/');
      const result = await readOne(currentConfig, owner, name, number, signal);

      return result.ok
        ? { card: result.value, failure: null }
        : { card: null, failure: { ...result.error, subject: GITHUB_SOURCE_ID } };
    },
  };
}
