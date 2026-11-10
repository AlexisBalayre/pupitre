import { describe, expect, it } from 'vitest';

import { askedLines, optionLines } from './question.utils.js';

describe('optionLines', () => {
  it('numbers the options from 1 and marks the recommended one', () => {
    expect(optionLines(['rebase', 'merge'], 2)).toEqual(['1. rebase', '2. merge  (recommended)']);
  });

  it('marks nothing without a recommendation', () => {
    expect(optionLines(['rebase'])).toEqual(['1. rebase']);
  });

  // Session-written text bound for the operator's terminal (decision 29).
  it('scrubs control characters out of each option', () => {
    expect(optionLines(['\u001b[2Jok\n$(whoami)'])).toEqual(['1. [2Jok $(whoami)']);
  });
});

describe('askedLines', () => {
  it('echoes the question, its options indented under it', () => {
    expect(
      askedLines('Session s1', { text: 'which?', options: ['rebase', 'merge'], recommended: 1 }),
    ).toEqual(['Session s1 asked: which?', '  1. rebase  (recommended)', '  2. merge']);
  });

  it('echoes a bare question scrubbed, as one line', () => {
    expect(askedLines('The conductor', { text: 'go\u0007 on?' })).toEqual([
      'The conductor asked: go on?',
    ]);
  });
});
