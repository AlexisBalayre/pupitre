import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { shellWord } from './shell-quote.utils.js';

/** The one argument `shell` hands a command when it reads `line` as one word. */
function parsedBy(shell: string, line: string): string {
  return execFileSync(shell, ['-c', `printf %s ${line}`], { encoding: 'utf8' });
}

/** The shells on this machine, of those an operator may paste a line into. */
const SHELLS = ['sh', 'bash', 'zsh'].filter(
  (shell) => spawnSync(shell, ['-c', 'exit 0']).status === 0,
);

const AWKWARD_WORDS = [
  'refs/heads/ma in',
  'refs/heads/main;touch pwned',
  "it's",
  '=pup-t-abc:',
  '$HOME',
  '`id`',
  '~root',
  '*',
  'a\\b',
  "a\\'b",
  "x\\'; touch pwned #",
  'trailing\\',
  '',
];

describe('shellWord', () => {
  it.each(['refs/heads/main', '/var/tmp/repo/.git/config', 'pup-conductor-ab12cd34ef56', '-L'])(
    'leaves %s bare: no shell reads anything into it',
    (word) => {
      expect(shellWord(word)).toBe(word);
    },
  );

  it.each([
    ['refs/heads/ma in', "'refs/heads/ma in'"],
    ['=pup-t-abc:', "'=pup-t-abc:'"],
    ["it's", "'it'\\''s'"],
    ['', "''"],
  ])('quotes %j as %s', (word, quoted) => {
    expect(shellWord(word)).toBe(quoted);
  });

  it.each(SHELLS.flatMap((shell) => AWKWARD_WORDS.map((word) => [shell, word])))(
    '%s reads %j back as the one word it was',
    (shell, word) => {
      expect(parsedBy(shell, shellWord(word))).toBe(word);
    },
  );
});
