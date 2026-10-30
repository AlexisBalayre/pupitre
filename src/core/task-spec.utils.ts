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
  /** Scope-in globs no editable tracked file matches: files the task is to create. */
  toCreate: string[];
}

/**
 * The tracked files a task's scope-in matches, read with the gate's own
 * precedence (`scopedPaths`), so the kickoff never names a file the session
 * could not commit: a protected path or one scope-out takes back (decision 126).
 */
export function scopeInFiles(
  tracked: string[],
  task: Pick<TaskSpec, 'scopeIn' | 'scopeOut'>,
): ScopeInFiles {
  const scopeIn = task.scopeIn.filter((glob) => glob.trim());
  const files = scopedPaths(tracked, scopeIn, task.scopeOut);
  const toCreate = scopeIn.filter((glob) => scopedPaths(files, [glob], task.scopeOut).length === 0);
  return { files, toCreate };
}
