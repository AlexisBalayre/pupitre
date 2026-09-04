import { InvalidProfileError } from './profile.errors.js';
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
