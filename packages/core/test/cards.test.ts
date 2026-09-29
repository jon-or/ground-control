import { describe, expect, it } from 'vitest';
import { sharedAssignment } from '../src/cards.js';

describe('whether an issue is shared', () => {
  it('is shared when somebody else is assigned beside the developer', () => {
    expect(sharedAssignment(['dev-1', 'dev-2'], ['dev-1'])).toBe(true);
  });

  it('is shared between two colleagues with the developer unassigned', () => {
    expect(sharedAssignment(['dev-2', 'dev-3'], ['dev-1'])).toBe(true);
  });

  it('counts every developer login as one person, in any case', () => {
    expect(sharedAssignment(['dev-1', 'DEV-1-alt'], ['dev-1', 'dev-1-alt'])).toBe(false);
    expect(sharedAssignment(['dev-1', 'dev-1-alt', 'dev-2'], ['dev-1', 'dev-1-alt'])).toBe(true);
  });

  it('is not shared with one assignee or none', () => {
    expect(sharedAssignment(['dev-1'], ['dev-1'])).toBe(false);
    expect(sharedAssignment(['dev-2'], ['dev-1'])).toBe(false);
    expect(sharedAssignment([], ['dev-1'])).toBe(false);
  });
});
