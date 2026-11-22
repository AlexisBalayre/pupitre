import type { SessionState } from '../enums/session-state.enums.js';
import { InvalidProfileError } from './profile.errors.js';

export class InvalidTransitionError extends Error {
  constructor(from: SessionState, to: SessionState) {
    super(`Illegal session transition ${from} -> ${to}.`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * A stored spec a command that acts on it cannot use: not JSON, the wrong shape,
 * or failing the checks `pup plan add` runs. An InvalidProfileError, so every
 * command that already refuses an unplannable spec refuses this one too.
 *
 * The message is store text: it names the task id, and through
 * `assertPlannableSpec` the glob that failed, so whoever prints it scrubs it
 * (decision 68). What it never carries is the raw blob — a SyntaxError's
 * message quotes the bytes it choked on, and that one is swallowed here.
 */
export class MalformedTaskSpecError extends InvalidProfileError {
  constructor(
    readonly taskId: string,
    reason: string,
  ) {
    super(`Task ${taskId} has an unusable spec: ${reason}`);
    this.name = 'MalformedTaskSpecError';
  }
}
