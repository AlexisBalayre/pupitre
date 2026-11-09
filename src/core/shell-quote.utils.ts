/**
 * A word a shell takes literally, single-quoted when it would not. A quote
 * and a backslash are both escaped outside the quotes: fish, unlike a POSIX
 * shell, reads `\'` inside single quotes as a quote, so a backslash left
 * there could end the quotes early and run what follows.
 */
export function shellWord(word: string): string {
  return /^[\w.,:/@-]+$/.test(word) ? word : `'${word.replace(/['\\]/g, "'\\$&'")}'`;
}
