import { describe, expect, it } from 'vitest';
import { dispatchName, promptValues, worktreePromptValues } from '../src/prompt.js';
import { fillTemplate } from '@ground-control/core';
import type { ActionPlan } from '../src/plan.js';

const PLAN: ActionPlan = {
  action: 'merge-upstream',
  evidence: '17198|4021|abc',
  repository: 'example-org/example-repo',
  issueNumber: 17198,
  pullRequest: 4021,
  branch: '17198-channel-mapping',
  base: 'master',
};

const VALUES = promptValues(PLAN, 'd:/work/repo.worktrees/17198-channel-mapping', 'C:/Users/dev/.claude/ground-control/runs/issue-17198.json');

describe('dispatch prompt values', () => {
  it('fills prompts from action context', () => {
    expect(fillTemplate('/or-merge {base} {branch} {issue} --single', VALUES)).toBe(
      '/or-merge master 17198-channel-mapping 17198 --single',
    );
  });

  /** Assert explicit placeholder names independently; review matching settings documentation separately. */
  it('defines and fills every supported placeholder', () => {
    expect(Object.keys(VALUES)).toEqual(['issue', 'repo', 'pr', 'branch', 'base', 'checkout', 'resultPath']);
    expect(fillTemplate('{issue} {repo} {pr} {branch} {base} {checkout} {resultPath}', VALUES)).toBe(
      '17198 example-org/example-repo 4021 17198-channel-mapping master ' +
        'd:/work/repo.worktrees/17198-channel-mapping ' +
        'C:/Users/dev/.claude/ground-control/runs/issue-17198.json',
    );
  });

  /** A developer prompt is their own text, and rewriting braces the board does not own would corrupt it. */
  it('leaves a placeholder it does not fill exactly as it was typed', () => {
    expect(fillTemplate('run {issue} in {somethingElse} with {}', VALUES)).toBe('run 17198 in {somethingElse} with {}');
  });

  it('fills a placeholder used more than once', () => {
    expect(fillTemplate('{issue} then {issue}', VALUES)).toBe('17198 then 17198');
  });

  it('keeps a prompt with no placeholders whole', () => {
    expect(fillTemplate('/or-merge', VALUES)).toBe('/or-merge');
  });

  it('supplies the result-file path', () => {
    expect(VALUES.resultPath).toBe('C:/Users/dev/.claude/ground-control/runs/issue-17198.json');
  });
});

describe('what a dispatched session is called', () => {
  it('names the board, the action and the issue, so it is told from work the developer started', () => {
    expect(dispatchName(PLAN.action, PLAN.issueNumber)).toBe('ground-control · merge-upstream · #17198');
  });

  it('names a worktree run the same way, so it is told from the action it precedes', () => {
    expect(dispatchName('create-worktree', 17198)).toBe('ground-control · create-worktree · #17198');
  });
});

describe('worktree prompt values', () => {
  const card = {
    issueNumber: 17198,
    issue: { title: 'Channel mapping drops the last row', url: 'https://github.com/example-org/example-repo/issues/17198', repository: 'example-org/example-repo' },
  };
  const values = worktreePromptValues(card, 'd:/work/repo', 'C:/Users/dev/.claude/ground-control/runs/issue-17198.json');

  it('defines and fills every supported placeholder', () => {
    expect(Object.keys(values)).toEqual(['issue', 'repo', 'title', 'url', 'clone', 'resultPath']);
    expect(fillTemplate('/init-worktree {issue} --report {resultPath} in {clone} for {repo}: {title} {url}', values)).toBe(
      '/init-worktree 17198 --report C:/Users/dev/.claude/ground-control/runs/issue-17198.json in d:/work/repo ' +
        'for example-org/example-repo: Channel mapping drops the last row https://github.com/example-org/example-repo/issues/17198',
    );
  });

  it('fills an empty repository where the card names none', () => {
    expect(worktreePromptValues({ ...card, issue: { title: 't', url: 'u' } }, 'd:/work/repo', 'r').repo).toBe('');
  });
});
