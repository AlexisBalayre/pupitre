import type { Database } from 'better-sqlite3';
import type { Tier } from '../claude/model-ladder.constants.js';
import {
  hasSessionWindow,
  readInputBox,
  SessionPaneMissingError,
} from '../claude/session-runtime.service.js';
import { insertDecisionRecord } from './decision-record.repository.js';
import { InvalidProfileError } from './profile.errors.js';
import { asTier, taskTier, tierForScope } from './routing.utils.js';
import {
  appendEvent,
  claimingSession,
  getSession,
  getTask,
  listTaskSessions,
  raiseToCritical,
  readTaskSpec,
  rescopeTaskSpec,
  type SessionRow,
  workingSession,
} from './session.repository.js';
import { sessionPane } from './session-lifecycle.service.js';
import { assertPlannableSpec } from './task-spec.utils.js';

export type RescopeOutcome =
  | { status: 'rescoped'; sessionId: string; added: string[]; tier: Tier; raised: boolean }
  | { status: 'unchanged'; sessionId: string }
  | { status: 'working'; sessionId: string }
  | { status: 'live'; sessionId: string }
  | { status: 'unclaimed' }
  | { status: 'unknown' };

/** Any C0 control, DEL or C1 control: none belongs in a path. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/;

// A glob made of nothing but star segments (`*`, `**`, `**/*`, `*/**`) matches
// every path or nearly every one.
const STARS_ONLY = /^\*+(\/\*+)*\/?$/;

/**
 * The checks a glob passes before a rescope appends it, stricter than a plan's
 * (decision 115): a rescope widens a scope the gate already audited, so it
 * names paths, never the whole tree, never a path outside the repo.
 */
function assertRescopableGlob(glob: string): void {
  const refuse = (why: string) => {
    throw new InvalidProfileError(`Rescope glob ${JSON.stringify(glob)} ${why}.`);
  };
  if (CONTROL_CHAR.test(glob)) refuse('contains a control character');
  if (glob.trim() === '') refuse('is empty');
  if (STARS_ONLY.test(glob)) refuse('matches every path');
  if (glob.startsWith('/')) refuse('is absolute');
  if (glob.split('/').includes('..')) refuse('has a `..` segment');
}

/**
 * Whether the session's window may still be open, so its worker could keep
 * editing past a rescope: its recorded pane answers a capture, or a window
 * wears its name. Fails closed: a probe that errors any other way than "no
 * such pane" counts as open.
 */
function windowOpen(row: SessionRow): boolean {
  if (hasSessionWindow(row.id)) return true;
  if (row.tmux_target === null) return false;
  try {
    readInputBox(sessionPane(row));
    return true;
  } catch (error) {
    return !(error instanceof SessionPaneMissingError);
  }
}

/**
 * `pup plan edit <task> --rescope --scope <glob...>`: append globs to the
 * scope-in of a task a session claimed, whose spec `pup plan edit` otherwise
 * keeps frozen (decision 115). Never removes a glob. Refused while a session
 * on the task is in a state that is not listed as rescopable, or still has a
 * window open, whose hooks hold the old scope; once it has stopped, the gate,
 * `pup review` and the next `pup fix` all read the widened spec. The read, the
 * checks, the write, the `rescope` event on the claiming session and the
 * decision record `pup log` lists are one immediate transaction, so no other
 * writer lands between the read and the write. A widened scope-in that implies
 * critical raises a standard task and session to critical in the same write,
 * since the session's next window routes from its own stored tier; a tier is
 * never lowered. The caller is the operator: the CLI refuses a session and the
 * conductor before this runs.
 */
export function rescopeTask(db: Database, taskId: string, globs: string[]): RescopeOutcome {
  for (const glob of globs) assertRescopableGlob(glob);
  return db
    .transaction((): RescopeOutcome => {
      const task = getTask(db, taskId);
      if (!task) return { status: 'unknown' };
      const sessionId = claimingSession(db, taskId);
      if (sessionId === undefined) return { status: 'unclaimed' };
      const working = workingSession(db, taskId);
      if (working !== undefined) return { status: 'working', sessionId: working };
      const open = listTaskSessions(db, taskId).find(windowOpen);
      if (open) return { status: 'live', sessionId: open.id };
      const spec = readTaskSpec(db, taskId);
      const added = [...new Set(globs)].filter((glob) => !spec.scopeIn.includes(glob));
      if (added.length === 0) return { status: 'unchanged', sessionId };
      const widened = { ...spec, scopeIn: [...spec.scopeIn, ...added] };
      assertPlannableSpec(widened);
      if (!rescopeTaskSpec(db, taskId, JSON.stringify(widened))) {
        return { status: 'working', sessionId: workingSession(db, taskId) ?? sessionId };
      }
      const before = asTier(getSession(db, sessionId)?.tier) ?? taskTier(task.tier, spec.scopeIn);
      const raised = before === 'standard' && tierForScope(widened.scopeIn) === 'critical';
      if (raised) raiseToCritical(db, taskId, sessionId);
      const tier: Tier = raised ? 'critical' : before;
      appendEvent(db, sessionId, 'rescope', { task: taskId, added, by: 'operator', tier, raised });
      insertDecisionRecord(db, {
        sessionId,
        summary: `The operator widened ${taskId}'s scope-in after launch, adding ${added.join(', ')}.`,
        files: added,
      });
      return { status: 'rescoped', sessionId, added, tier, raised };
    })
    .immediate();
}
