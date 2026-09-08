import { describe, expect, it } from 'vitest';
import { fillTemplate, newSessionValues } from '../src/template.js';

describe('fillTemplate', () => {
  it('puts the named facts in, and leaves a name it was not given exactly as typed', () => {
    expect(fillTemplate('Work on #{issue} in {checkout}. Keep {braces} alone.', { issue: '19002', checkout: 'd:/work' })).toBe(
      'Work on #19002 in d:/work. Keep {braces} alone.',
    );
  });

  it('substitutes a name that appears more than once, which a prompt referring to a card twice needs', () => {
    expect(fillTemplate('{issue} then {issue}', { issue: '7' })).toBe('7 then 7');
  });

  // A prompt half-substituted would still run, and a run is not a thing to guess at.
  it('leaves an empty template empty rather than inventing anything for it', () => {
    expect(fillTemplate('', { issue: '7' })).toBe('');
  });

  it('fills a name whose value is empty, rather than leaving the braces on a card that has no repository', () => {
    expect(fillTemplate('[{repo}]', { repo: '' })).toBe('[]');
  });

  /**
   * Every object literal inherits `constructor`, `toString` and the rest, so a plain lookup would substitute a
   * function's source into a prompt merely mentioning one — and a card action's prompt is dispatched unattended.
   */
  it('leaves an inherited name alone, which a plain lookup would substitute a function’s source for', () => {
    expect(fillTemplate('{constructor} {toString} {hasOwnProperty} {valueOf}', { issue: '7' })).toBe(
      '{constructor} {toString} {hasOwnProperty} {valueOf}',
    );
  });
});

describe('newSessionValues', () => {
  const card = {
    issueNumber: 19002,
    issue: { title: 'Refund window', url: 'https://github.com/example-org/example-repo/issues/19002', repository: 'example-org/example-repo' },
  };

  /**
   * The keys are the roster, since `fillTemplate` substitutes from the object itself. Written out rather than
   * derived, so one dropped fails here — and the pairing this cannot pin is the settings description in the
   * extension's own manifest, which is prose in another package.
   */
  it('names every placeholder the settings description publishes, and fills each from the card', () => {
    const values = newSessionValues(card, 'd:/work/repo');

    expect(Object.keys(values)).toEqual(['issue', 'repo', 'title', 'url', 'checkout']);
    expect(values).toEqual({
      issue: '19002',
      repo: 'example-org/example-repo',
      title: 'Refund window',
      url: 'https://github.com/example-org/example-repo/issues/19002',
      checkout: 'd:/work/repo',
    });
  });

  // A session with no issue of its own is a card too (R4), and it still has a checkout to be started in.
  it('empties the issue’s own fields for a card that has no issue, rather than printing undefined', () => {
    expect(newSessionValues({ issueNumber: null, issue: null }, 'd:/work/repo')).toEqual({
      issue: '',
      repo: '',
      title: '',
      url: '',
      checkout: 'd:/work/repo',
    });
  });

  it('empties the repository for a snapshot an older hub cached without one', () => {
    expect(newSessionValues({ issueNumber: 7, issue: { title: 't', url: 'u' } }, 'd:/work').repo).toBe('');
  });
});
