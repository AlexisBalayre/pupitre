import { globToRegExp } from './glob.utils.js';
import { InvalidProfileError } from './profile.errors.js';
import { scopedPaths } from './scope-audit.utils.js';
import type { TaskSpec } from './types/profile.types.js';

/** Control characters that must never reach a generated scope pattern file. */
const GLOB_UNSAFE = /[\r\n\0]/;

/**
 * The subset of `compileProfile`'s validation a stored spec must satisfy to be
 * launchable at all. Compilation re-checks it; running it here moves the failure
 * to the command that caused it, which matters once a spec outlives the command
 * that wrote it (decision 40).
 *
 * The control-character rule is the load-bearing one: `scope-in.pat` is read by
 * `grep -qE -f`, where a blank line is a pattern matching every path, so one
 * newline inside a glob would turn the Edit/Write hook into allow-all.
 */
export function assertPlannableSpec(task: TaskSpec): void {
  // `?? []` because this now also runs over specs read back from the store,
  // where a row written before this validation existed can be missing `scopeIn`
  // entirely — the same refusal covers it, rather than a bare TypeError.
  if ((task.scopeIn ?? []).filter((glob) => glob.trim()).length === 0) {
    throw new InvalidProfileError(
      'Task scope-in is empty; a session with no scope can edit nothing.',
    );
  }
  for (const glob of [...task.scopeIn, ...(task.scopeOut ?? [])]) {
    if (GLOB_UNSAFE.test(glob)) {
      throw new InvalidProfileError(
        `Scope glob contains a control character: ${JSON.stringify(glob)}`,
      );
    }
  }
}

/** What a task's scope-in names among the tracked files, as its kickoff lists them. */
export interface ScopeInFiles {
  /** Tracked files the task may edit, in `tracked`'s order. */
  files: string[];
  /** Scope-in globs that match no tracked path and name an editable one: files to create. */
  toCreate: string[];
}

/** Candidates `scopedPaths` takes per call, so the deadline is checked between calls. */
const SCOPE_BATCH = 1_000;

/**
 * The tracked files a task's scope-in matches, read with the gate's own
 * precedence (`scopedPaths`), so the kickoff never names a file the session
 * could not commit: a protected path or one scope-out takes back (decision 128).
 * A glob is to be created only when it matches no tracked path at all, before
 * that precedence, and its own text is not refused by it: a glob whose files
 * are all protected or under scope-out names nothing the session may add.
 * Undefined once `deadline` (a `Date.now()` instant) passes, checked between
 * paths: the listing is the repo's, which a session can plant to be huge.
 */
export function scopeInFiles(
  tracked: string[],
  task: Pick<TaskSpec, 'scopeIn' | 'scopeOut'>,
  deadline: number,
): ScopeInFiles | undefined {
  const scopeIn = task.scopeIn.filter((glob) => glob.trim());
  const inRes = scopeIn.map(globToRegExp);
  const matched = new Set<number>();
  const candidates: string[] = [];
  for (const path of tracked) {
    if (Date.now() > deadline) return undefined;
    const hits = inRes.flatMap((re, index) => (re.test(path) ? [index] : []));
    for (const index of hits) matched.add(index);
    if (hits.length > 0) candidates.push(path);
  }
  const files: string[] = [];
  for (let start = 0; start < candidates.length; start += SCOPE_BATCH) {
    if (Date.now() > deadline) return undefined;
    files.push(
      ...scopedPaths(candidates.slice(start, start + SCOPE_BATCH), scopeIn, task.scopeOut),
    );
  }
  // A glob's text matches its own pattern, so the gate's rule reads it as a path.
  const toCreate = scopeIn.filter(
    (glob, index) => !matched.has(index) && scopedPaths([glob], [glob], task.scopeOut).length > 0,
  );
  return { files, toCreate };
}
