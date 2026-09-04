import { sanitizeReason } from '../adapters/capability.utils.js';
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
