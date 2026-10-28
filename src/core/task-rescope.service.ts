import type { Database } from 'better-sqlite3';
import { insertDecisionRecord } from './decision-record.repository.js';
import {
  appendEvent,
  claimingSession,
  getTask,
  readTaskSpec,
  rescopeTaskSpec,
  workingSession,
} from './session.repository.js';
import { assertPlannableSpec } from './task-spec.utils.js';

export type RescopeOutcome =
  | { status: 'rescoped'; sessionId: string; added: string[] }
  | { status: 'unchanged'; sessionId: string }
  | { status: 'working'; sessionId: string }
  | { status: 'unclaimed' }
  | { status: 'unknown' };

/**
 * `pup plan edit <task> --rescope --scope <glob...>`: append globs to the
 * scope-in of a task a session claimed, whose spec `pup plan edit` otherwise
 * keeps frozen (decision 115). Never removes a glob. Refused while a session
 * is at work on the task, whose hooks still hold the old scope; once it has
 * stopped, the gate, `pup review` and the next `pup fix` all read the widened
 * spec. The write, the `rescope` event on the claiming session and the
 * decision record `pup log` lists are one transaction. The caller is the
 * operator: the CLI refuses a session and the conductor before this runs.
 */
export function rescopeTask(db: Database, taskId: string, globs: string[]): RescopeOutcome {
  if (!getTask(db, taskId)) return { status: 'unknown' };
  const sessionId = claimingSession(db, taskId);
  if (sessionId === undefined) return { status: 'unclaimed' };
  const working = workingSession(db, taskId);
  if (working !== undefined) return { status: 'working', sessionId: working };
  const spec = readTaskSpec(db, taskId);
  const added = [...new Set(globs)].filter((glob) => !spec.scopeIn.includes(glob));
  if (added.length === 0) return { status: 'unchanged', sessionId };
  const widened = { ...spec, scopeIn: [...spec.scopeIn, ...added] };
  assertPlannableSpec(widened);
  return db.transaction((): RescopeOutcome => {
    if (!rescopeTaskSpec(db, taskId, JSON.stringify(widened))) {
      return { status: 'working', sessionId: workingSession(db, taskId) ?? sessionId };
    }
    appendEvent(db, sessionId, 'rescope', { task: taskId, added, by: 'operator' });
    insertDecisionRecord(db, {
      sessionId,
      summary: `The operator widened ${taskId}'s scope-in after launch, adding ${added.join(', ')}.`,
      files: added,
    });
    return { status: 'rescoped', sessionId, added };
  })();
}
