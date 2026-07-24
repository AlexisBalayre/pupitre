import { isAbsolute, join, relative, sep } from 'node:path';
import type { DeadExport } from './types/adapter.types.js';

/**
 * One full vulture line: `path.py:42: unused function 'foo' (60% confidence)`.
 * Anchored end to end so a crafted filename containing a vulture-shaped prefix
 * cannot fabricate a finding — the greedy path group swallows it whole.
 */
const VULTURE_LINE =
  /^(.+):\d+: unused (?:function|class|method|variable|import|attribute|property) '([^']+)' \(\d+% confidence\)$/;

/**
 * Vulture findings as dead exports. Unreachable-code findings carry no name and
 * are dropped: the baseline keys on `file\0name` pairs, so a nameless finding
 * could never be matched against it. Paths escaping the repo are dropped too —
 * the pairs land in the stored baseline and ledger, never back on disk, but an
 * out-of-repo entry would still poison what later merges are compared against.
 */
export function parseVultureOutput(stdout: string, repoPath: string): DeadExport[] {
  const dead: DeadExport[] = [];
  for (const line of stdout.split('\n')) {
    const match = VULTURE_LINE.exec(line);
    if (!match) continue;
    const raw = match[1] as string;
    const file = relative(repoPath, isAbsolute(raw) ? raw : join(repoPath, raw))
      .split(sep)
      .join('/');
    if (!file || file.startsWith('..')) continue;
    dead.push({ file, exportName: match[2] as string });
  }
  return dead;
}
