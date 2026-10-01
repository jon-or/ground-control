import { describe, expect, it } from 'vitest';
import { actionPrompt, approvalPrompt, basePromptValues, dispatchName, promptValues, worktreePrompt, worktreePromptValues } from '../src/prompt.js';
import { fillTemplate } from '@ground-control/core';
import type { ActionPlan } from '../src/plan.js';

const PLAN: ActionPlan = {
  action: 'merge',
  qualifier: 'upstream',
  evidence: '17198|4021|abc',
  repository: 'example-org/example-repo',
  issueNumber: 17198,
  pullRequest: 4021,
  branch: '17198-channel-mapping',
  base: 'master',
  defaultBranch: 'master',
  target: '',
  role: 'author',
  defaultOid: '',
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
    expect(Object.keys(VALUES)).toEqual(['issue', 'repo', 'pr', 'branch', 'base', 'default', 'target', 'checkout', 'resultPath']);
    expect(fillTemplate('{issue} {repo} {pr} {branch} {base} {default} [{target}] {checkout} {resultPath}', VALUES)).toBe(
      '17198 example-org/example-repo 4021 17198-channel-mapping master master [] ' +
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

/** A base merge is the base pull request's upstream merge, so the placeholders keep their meanings (R39). */
describe('base merge prompt values', () => {
  it('fills the base pull request, its branch, the default branch, and the base worktree', () => {
    const values = basePromptValues(
      { repository: 'example-org/example-repo', issueNumber: 17000, pullRequest: 4000, branch: '17000-parent-feature', defaultBranch: 'master', headOid: 'b1b1b1b' },
      'd:/work/repo.worktrees/17000-parent-feature',
      'C:/Users/dev/.claude/ground-control/runs/merge-0123.json',
    );

    expect(values).toEqual({
      issue: '17000',
      repo: 'example-org/example-repo',
      pr: '4000',
      branch: '17000-parent-feature',
      base: 'master',
      default: 'master',
      target: '',
      checkout: 'd:/work/repo.worktrees/17000-parent-feature',
      resultPath: 'C:/Users/dev/.claude/ground-control/runs/merge-0123.json',
    });
    expect(fillTemplate('/or-merge {base} {branch} {issue}', values)).toBe('/or-merge master 17000-parent-feature 17000');
  });
});

describe('what a dispatched session is called', () => {
  it('names the board, the action and the issue, so it is told from work the developer started', () => {
    expect(dispatchName(PLAN.action, PLAN.issueNumber, PLAN.qualifier)).toBe('ground-control · merge upstream · #17198');
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
  const values = worktreePromptValues(card, 'd:/work/repo', 'C:/Users/dev/.claude/ground-control/runs/issue-17198.json', null);

  it('defines and fills every supported placeholder', () => {
    expect(Object.keys(values)).toEqual(['issue', 'repo', 'title', 'url', 'clone', 'pr', 'branch', 'role', 'resultPath']);
    expect(fillTemplate('/init-worktree {issue} --report {resultPath} in {clone} for {repo}: {title} {url}', values)).toBe(
      '/init-worktree 17198 --report C:/Users/dev/.claude/ground-control/runs/issue-17198.json in d:/work/repo ' +
        'for example-org/example-repo: Channel mapping drops the last row https://github.com/example-org/example-repo/issues/17198',
    );
  });

  it('fills an empty repository where the card names none', () => {
    expect(worktreePromptValues({ ...card, issue: { title: 't', url: 'u' } }, 'd:/work/repo', 'r', null).repo).toBe('');
  });
});

/** The blank line between the developer's prompt and the contract the board adds. */
const BREAK = '\n\n';

describe('result contract', () => {
  const values = promptValues(PLAN, 'd:/work/repo.worktrees/17198-channel-mapping', 'C:/runs/issue-17198.json');
  const worktreeValues = worktreePromptValues(
    { issueNumber: 17198, issue: { title: 'Channel mapping drops the last row', url: 'https://example.invalid/17198' } },
    'd:/work/repo',
    'C:/runs/issue-17198.json',
    null,
  );

  /** An unattended run reports only through the file, so a prompt that never mentions it always looks blocked. */
  it('appends the action report contract, word for word, to a prompt that omits the path', () => {
    expect(actionPrompt('/or-merge {base} {branch} {issue} --single', values)).toBe(
      '/or-merge master 17198-channel-mapping 17198 --single' + BREAK +
        'This run is unattended. Before you finish, write JSON to C:/runs/issue-17198.json: ' +
        '{"outcome":"completed","detail":"<what happened>"} once the work is complete; ' +
        '{"outcome":"awaiting-approval","detail":"<what is ready and what approving it does>"} when the work is complete except ' +
        'for a step the developer must approve, such as posting or publishing; otherwise ' +
        '{"outcome":"blocked","detail":"<the question or problem that stopped it>"}. ' +
        'Add "auditPath":"<absolute path>" when the run wrote a Markdown report, and, to awaiting-approval, ' +
        '"approve":"<the prompt that performs the step>" when a prompt can perform it. ' +
        'Write every key of whichever object you write, however the run ends, and ask no questions.',
    );
  });

  it('appends the worktree report contract, word for word, naming completed and the absolute path', () => {
    expect(worktreePrompt('/init-worktree {issue}', worktreeValues)).toBe(
      '/init-worktree 17198' + BREAK +
        'This run is unattended. Before you finish, write JSON to C:/runs/issue-17198.json: ' +
        '{"outcome":"completed","worktree":"<absolute path of the worktree>","detail":"<what happened>"}, or ' +
        '{"outcome":"blocked","detail":"<why no worktree>"}. ' +
        'Write every key of whichever object you write, however the run ends, and ask no questions.',
    );
  });

  it('leaves a prompt that places the path itself exactly as written', () => {
    expect(actionPrompt('/or-merge {branch} --report {resultPath}', values)).toBe(
      '/or-merge 17198-channel-mapping --report C:/runs/issue-17198.json',
    );
    expect(worktreePrompt('/init-worktree {issue} --report {resultPath}', worktreeValues)).toBe(
      '/init-worktree 17198 --report C:/runs/issue-17198.json',
    );
  });

  /** The session wrote the approval prompt, so no other placeholder is the board's to fill (R39). */
  it('fills only the result path in an approval prompt, and appends the contract where it has none', () => {
    expect(approvalPrompt('/address-qa 19719 publish {issue} result:{resultPath}', 'C:/runs/issue-19719.json')).toBe(
      '/address-qa 19719 publish {issue} result:C:/runs/issue-19719.json',
    );
    expect(approvalPrompt('/address-qa 19719 publish', 'C:/runs/issue-19719.json')).toBe(
      '/address-qa 19719 publish' + BREAK +
        'This run is unattended. Before you finish, write JSON to C:/runs/issue-19719.json: ' +
        '{"outcome":"completed","detail":"<what happened>"} once the work is complete; ' +
        '{"outcome":"awaiting-approval","detail":"<what is ready and what approving it does>"} when the work is complete except ' +
        'for a step the developer must approve, such as posting or publishing; otherwise ' +
        '{"outcome":"blocked","detail":"<the question or problem that stopped it>"}. ' +
        'Add "auditPath":"<absolute path>" when the run wrote a Markdown report, and, to awaiting-approval, ' +
        '"approve":"<the prompt that performs the step>" when a prompt can perform it. ' +
        'Write every key of whichever object you write, however the run ends, and ask no questions.',
    );
  });
});
