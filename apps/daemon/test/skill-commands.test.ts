import { describe, expect, it } from 'vitest';
import { unknownCommandMessage } from '../src/daemon/skill-commands.js';

const commands = (...names: string[]) => names.map(name => ({ name }));

describe('unknown command suggestions', () => {
  it('allows two edits only when the name without the skill prefix is longer than three characters', () => {
    expect(unknownCommandMessage('skill:ab', commands('skill:cd', 'skill:ac')))
      .toBe('Unknown or unavailable command: /skill:ab. Did you mean /skill:ac?');
    expect(unknownCommandMessage('skill:revew-pr', commands('skill:review-pr')))
      .toBe('Unknown or unavailable command: /skill:revew-pr. Did you mean /skill:review-pr?');
    expect(unknownCommandMessage('abc', commands('axy'))).toBe('Unknown or unavailable command: /abc.');
  });

  it('orders suggestions by distance, then name, and lists at most three', () => {
    expect(unknownCommandMessage('skill:test', commands('skill:tesu', 'skill:tezz', 'skill:tesa', 'skill:Test', 'skill:tests')))
      .toBe('Unknown or unavailable command: /skill:test. Did you mean /skill:Test, /skill:tesa, /skill:tests?');
  });
});
