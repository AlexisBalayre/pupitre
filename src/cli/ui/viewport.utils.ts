/**
 * The arithmetic that keeps a frame shorter than the terminal (decision 121).
 * Ink clears the screen and rewrites the whole frame whenever the frame is as
 * tall as the terminal, so every list on screen is cut to the rows left after
 * the parts that cannot be. Pure functions, no Ink: the components call them
 * and the tests pin them.
 */

/** A list cut to `max` lines, the last of which is the `+N more` line when it cut anything. */
export function clip<T>(items: T[], max: number): { shown: T[]; hidden: number } {
  if (items.length <= max) return { shown: items, hidden: 0 };
  const shown = items.slice(0, Math.max(max - 1, 0));
  return { shown, hidden: items.length - shown.length };
}

export function moreLine(hidden: number): string {
  return `  +${hidden} more`;
}

/** The rows a project's debt or radar block may take: an even share of the cap, never under `floor`. */
export function sectionShare(cap: number, projects: number, floor: number): number {
  return Math.max(Math.floor(cap / Math.max(projects, 1)), floor);
}

/** What a block really takes once it is held to `share` lines. */
export function usedLines(natural: number[], share: number): number {
  return natural.reduce((sum, lines) => sum + Math.min(lines, share), 0);
}

/**
 * `text` broken at spaces into lines of at most `width` characters, a word
 * longer than a line cut where the line ends. The lines are drawn one row each,
 * truncated, so the count here is the count on screen: Ink's own wrap would
 * decide its breaks where `App` cannot see them.
 */
export function wrapLines(text: string, width: number): string[] {
  const max = Math.max(width, 1);
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const joined = line === '' ? word : `${line} ${word}`;
    if (joined.length <= max) {
      line = joined;
      continue;
    }
    if (line !== '') lines.push(line);
    let rest = word;
    while (rest.length > max) {
      lines.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    line = rest;
  }
  lines.push(line);
  return lines;
}

/**
 * Where a window of `size` rows starts so the cursor is inside it, centred
 * where the list is long enough to let it be. Stateless on purpose: the same
 * cursor always draws the same window, so a refresh never moves the table.
 */
export function windowStart(total: number, size: number, cursor: number): number {
  const centred = cursor - Math.floor(size / 2);
  return Math.min(Math.max(centred, 0), Math.max(total - size, 0));
}
