import { describe, expect, it } from 'vitest';

import { QuestionRefusedError } from '../../core/session-lifecycle.service.js';
import { askedLines, askedQuestion, optionLines } from './question.utils.js';

// Decision 93: what `pup session ask` and `pup conductor ask` store, refused
// before anything is stored when it is not a question the operator can answer
// with one key.
describe('askedQuestion', () => {
  const ask = (text: string | undefined, option?: string[], recommend?: string) =>
    askedQuestion('pup session ask', text, {
      ...(option ? { option } : {}),
      ...(recommend === undefined ? {} : { recommend }),
    });

  it('stores the bare text when no options are offered', () => {
    expect(ask('rebase or merge?')).toEqual({ text: 'rebase or merge?' });
  });

  it('stores the options and the recommended one by its number', () => {
    expect(ask('which?', ['rebase', 'merge'], '2')).toEqual({
      text: 'which?',
      options: ['rebase', 'merge'],
      recommended: 2,
    });
  });

  it('stores options with no recommendation', () => {
    expect(ask('which?', ['rebase', 'merge'])).toEqual({
      text: 'which?',
      options: ['rebase', 'merge'],
    });
  });

  it.each([
    ['no question', undefined, undefined, undefined, 'pup session ask needs the question itself.'],
    ['a blank question', '  ', undefined, undefined, 'pup session ask needs the question itself.'],
    ['five options', 'which?', ['a', 'b', 'c', 'd', 'e'], undefined, /at most 4 options/],
    ['a blank option', 'which?', ['a', ' '], undefined, 'Every --option needs its text.'],
    ['a recommendation past them', 'which?', ['a', 'b'], '3', /one of the 2 options, from 1/],
    ['a recommendation of 0', 'which?', ['a', 'b'], '0', /one of the 2 options/],
    ['a recommendation in words', 'which?', ['a', 'b'], 'two', /one of the 2 options/],
    ['a recommendation with no options', 'which?', undefined, '1', /one of the 0 options/],
  ])('refuses %s', (_, text, option, recommend, message) => {
    expect(() => ask(text, option, recommend)).toThrow(QuestionRefusedError);
    expect(() => ask(text, option, recommend)).toThrow(message);
  });
});

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
