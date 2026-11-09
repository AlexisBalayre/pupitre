import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { shellWord } from './shell-quote.utils.js';

/** The one argument `shell` hands a command when it reads `line` as one word. */
function parsedBy(shell: string, line: string): string {
  return execFileSync(shell, ['-c', `printf %s ${line}`], { encoding: 'utf8' });
}

/**
 * The word fish reads from `line`. Unlike in a POSIX shell, `\'` and `\\` are
 * escapes inside fish's single quotes, so a backslash there can end the quotes
 * early. Outside quotes only what shellWord writes is modelled; any other
 * character fish would read specially fails the test rather than pass it.
 */
function readByFish(line: string): string {
  let word = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i] as string;
    const next = line[i + 1];
    if (char === '\\' && (next === "'" || next === '\\')) {
      word += next;
      i++;
    } else if (char === "'") {
      quoted = !quoted;
    } else if (quoted || /[\w.,:/@-]/.test(char)) {
      word += char;
    } else {
      throw new Error(`fish reads ${JSON.stringify(char)} outside the quotes`);
    }
  }
  if (quoted) throw new Error('fish is left waiting for a closing quote');
  return word;
}

/** The shells on this machine, of those an operator may paste a line into. */
const SHELLS = ['sh', 'bash', 'zsh', 'fish'].filter(
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
    ['a\\b', "'a'\\\\'b'"],
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

  it.each(AWKWARD_WORDS)('fish reads %j back as the one word it was', (word) => {
    expect(readByFish(shellWord(word))).toBe(word);
  });

  // Quoting fit for sh alone, `'x\'\''; ...'`, lets fish read the `\'` as a
  // quote inside the quotes, so the `'` meant to close them opens new ones
  // after `;`, and the command after it runs.
  it('keeps a backslash-quote from ending the quotes under fish', () => {
    const word = "x\\'; touch pwned #";
    expect(() => readByFish(`'${word.replaceAll("'", "'\\''")}'`)).toThrow(/";"/);
    expect(shellWord(word)).toBe("'x'\\\\''\\''; touch pwned #'");
    expect(readByFish(shellWord(word))).toBe(word);
  });
});
