import { sanitizeReason } from '../adapters/capability.utils.js';
import {
  SessionPaneMissingError,
  SteerNotDeliveredError,
} from '../claude/session-runtime.service.js';
import type { ScopeConflict } from './types/overlap.types.js';

export class UnknownTaskError extends Error {
  constructor(taskId: string) {
    super(`No task ${taskId}. Run \`pup plan\` to see the backlog.`);
    this.name = 'UnknownTaskError';
  }
}

/** Files are named at most this many per session before the count takes over. */
const CONFLICT_FILES_SHOWN = 3;

export class ScopeConflictError extends Error {
  constructor(taskId: string, conflicts: ScopeConflict[]) {
    const detail = conflicts
      .map((conflict) => `${conflict.sessionId} (${namedFiles(conflict.files)})`)
      .join(', ');
    super(
      `Task ${taskId} is scoped to files a live session already holds: ${detail}. ` +
        'Narrow the scope, kill that session, or relaunch with --allow-overlap.',
    );
    this.name = 'ScopeConflictError';
  }
}

/**
 * Paths come from `git ls-files`, so a filename can carry control characters
 * or escape sequences straight into the operator's terminal — sanitized here
 * because this message is the sink every caller prints (decision 29).
 */
function namedFiles(files: string[]): string {
  const shown = files.slice(0, CONFLICT_FILES_SHOWN).map(sanitizeReason).join(', ');
  const rest = files.length - CONFLICT_FILES_SHOWN;
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

export class TaskAlreadyClaimedError extends Error {
  constructor(taskId: string, sessionId: string) {
    super(
      `Task ${taskId} is already claimed by session ${sessionId}. ` +
        'Kill that session first if you want to start over.',
    );
    this.name = 'TaskAlreadyClaimedError';
  }
}

export class UnknownSessionError extends Error {
  constructor(sessionId: string) {
    super(`No session ${sessionId}.`);
    this.name = 'UnknownSessionError';
  }
}

/**
 * A steer or an interrupt aimed at a session that has stopped — merged or
 * killed, the two states nothing transitions out of. Refused here rather than
 * at each front end, so `pup steer` and the dashboard's `s` answer for the
 * same sessions. A session that is only done with its work (`awaiting-review`)
 * still takes one: its window is up, and the gate re-steers it on a rejection.
 */
export class TerminalSessionError extends Error {
  constructor(sessionId: string, state: string, verb: string) {
    super(`Session ${sessionId} is ${state}; nothing to ${verb}.`);
    this.name = 'TerminalSessionError';
  }
}

/**
 * The two ways a steer, a kickoff included, is refused with nothing typed: the
 * paste never landed whole (decision 45), or the pane recorded at launch is
 * not there to type into (decision 46) — for a launch, a window that died
 * before its context arrived.
 */
type RefusedSteer = SteerNotDeliveredError | SessionPaneMissingError;

export function isRefusedSteer(error: unknown): error is RefusedSteer {
  return error instanceof SteerNotDeliveredError || error instanceof SessionPaneMissingError;
}

/**
 * A launch that has already undone itself. Thrown by the only two functions
 * that open a window on a compiled context — `launchTask` and `startConductor`
 * — so that neither front end has to know what half-opening one leaves behind.
 * It carries the two halves an operator needs and not the third: the refusal
 * that stopped the launch, when there was one to read, and what was undone.
 * The retry is the caller's, because it is the only half that differs between
 * a terminal and a held-open screen (`Re-run …` against `Press c again`).
 */
export class LaunchRolledBackError extends Error {
  /** Why the launch failed, or undefined when the rollback line says it all. */
  readonly refusal?: Error;
  /** What was undone, as one clause the caller punctuates its retry onto. */
  readonly rolledBack: string;

  constructor(rolledBack: string, refusal?: Error) {
    super(refusal ? `${refusal.message} ${rolledBack}.` : `${rolledBack}.`);
    this.name = 'LaunchRolledBackError';
    this.refusal = refusal;
    this.rolledBack = rolledBack;
  }
}

/**
 * Undo a launch whose opening context never landed, and answer for both halves
 * with one error. `undo` and `rolledBack` are the caller's own: a session's
 * launch kills a session, the conductor's kills a window, and each says so in
 * its own words.
 */
export function rollBackRefusedLaunch(
  undo: () => void,
  rolledBack: string,
  refusal?: Error,
): LaunchRolledBackError {
  try {
    undo();
  } catch (failed) {
    // A rollback that fails is a bug path and ends in a stack, as it always
    // has. The refusal rides out as that stack's cause rather than being lost
    // behind it: it is why the launch failed, which is why the CLI printed it
    // before killing back when the rollback lived there.
    throw failed instanceof Error && refusal ? Object.assign(failed, { cause: refusal }) : failed;
  }
  return new LaunchRolledBackError(rolledBack, refusal);
}
