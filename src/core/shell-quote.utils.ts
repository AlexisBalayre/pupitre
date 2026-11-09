/** A word a shell takes literally, single-quoted when it would not. */
export function shellWord(word: string): string {
  return /^[\w.,:/@-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}
