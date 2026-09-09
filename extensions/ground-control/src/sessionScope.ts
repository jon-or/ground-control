import * as vscode from 'vscode';
import { diskReaders, repositoryOf, restrictedSessionScope, sessionInScope, sessionScopeSchema } from '@ground-control/core';
import type { HistoricalSession, OpenRoute, Session, SessionCheck, SessionScope } from '@ground-control/core';

export type SessionChecker = (sessionId: string) => Promise<SessionCheck | null>;

export function readSessionScope(): SessionScope {
  const cfg = vscode.workspace.getConfiguration('groundControl');
  return {
    includeRepositories: cfg.get<string[]>('sessions.includeRepositories', []),
    excludeRepositories: cfg.get<string[]>('sessions.excludeRepositories', []),
    includeDirectories: cfg.get<string[]>('sessions.includeDirectories', []),
    excludeDirectories: cfg.get<string[]>('sessions.excludeDirectories', []),
    showHistory: cfg.get<boolean>('sessions.showHistory', true),
    showAdHoc: cfg.get<boolean>('sessions.showAdHoc', true),
  };
}

/** Recheck local settings at execution, including while their update is still reaching the hub. */
export function sessionAllowed(session: Session | HistoricalSession, history = false, root?: string): boolean {
  const parsed = sessionScopeSchema.safeParse(readSessionScope());
  return parsed.success && (!history || parsed.data.showHistory) &&
    (parsed.data.showAdHoc || session.issueNumber !== null) && sessionInScope(parsed.data, {
      ...session, checkoutRoot: root ?? ('checkoutRoot' in session ? session.checkoutRoot : null),
    });
}

export function routeAllowed(plan: OpenRoute): boolean {
  if ('session' in plan) {
    return sessionAllowed(plan.session, plan.route.startsWith('resume-'), plan.root);
  }
  const parsed = sessionScopeSchema.safeParse(readSessionScope());
  if (!parsed.success) return false;
  if (!restrictedSessionScope(parsed.data)) return true;
  return sessionInScope(parsed.data, {
    repository: repositoryOf(plan.root, diskReaders().readText), cwd: plan.root, checkoutRoot: plan.root,
  });
}
