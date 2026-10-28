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

/** What a rescope did: the globs it appended, none when all were there, and the tier it leaves. */
interface Rescoped {
  sessionId: string;
  added: string[];
  tier: Tier;
  raised: boolean;
}

/**
 * The globs a rescope refuses, stricter than a plan's (decision 115): a
 * rescope widens a scope the gate already audited, so it names paths, never
 * the whole tree, never a path outside the repo. A glob of nothing but star
 * segments (`*`, `**`, `**` then `*`) matches every path or nearly.
 */
const GLOB_REFUSALS: readonly (readonly [RegExp, string])[] = [
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
  [/[\u0000-\u001f\u007f-\u009f]/, 'contains a control character'],
  [/^\s*$/, 'is empty'],
  [/^\*+(\/\*+)*\/?$/, 'matches every path'],
  [/^\//, 'is absolute'],
  [/(^|\/)\.\.(\/|$)/, 'has a `..` segment'],
];

/**
 * A rescope's refusals are the CLI's spec-edit refusals: it already refuses
 * every InvalidProfileError `pup plan edit` meets, scrubbed, since the text
 * can carry a stored session id.
 */
function refusal(message: string): InvalidProfileError {
  return new InvalidProfileError(message);
}

function assertRescopableGlob(glob: string): void {
  const refused = GLOB_REFUSALS.find(([pattern]) => pattern.test(glob));
  if (refused) throw refusal(`Rescope glob ${JSON.stringify(glob)} ${refused[1]}.`);
}

/**
 * Whether the session's window may still be open, so its worker could keep
 * editing past a rescope: a window wears its name, or its recorded pane
 * answers a capture. Fails closed: a probe that errors any other way than "no
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
 * The tier the session's next window runs on once the scope-in is widened: a
 * standard one is raised to critical when the widened scope implies it,
 * since the window routes from the session's own stored tier; never lowered.
 */
function settleTier(
  db: Database,
  ids: { taskId: string; sessionId: string },
  before: Tier,
  widened: string[],
): Tier {
  if (before !== 'standard' || tierForScope(widened) !== 'critical') return before;
  raiseToCritical(db, ids.taskId, ids.sessionId);
  return 'critical';
}

/**
 * `pup plan edit <task> --rescope --scope <glob...>`: append globs to the
 * scope-in of a task a session claimed, whose spec `pup plan edit` otherwise
 * keeps frozen (decision 115). Never removes a glob. Refused while a session
 * on the task is in a state that is not listed as rescopable, which the
 * write's own guard decides, or still has a window open, whose hooks hold the
 * old scope; once it has stopped, the gate, `pup review` and the next
 * `pup fix` all read the widened spec. The read, the checks, the write, the
 * tier raise, the `rescope` event on the claiming session and the decision
 * record `pup log` lists are one immediate transaction: no other writer lands
 * between the read and the write, and a refusal after the write rolls it
 * back. The caller is the operator: the CLI refuses a session and the
 * conductor before this runs.
 */
export function rescopeTask(db: Database, taskId: string, globs: string[]): Rescoped {
  for (const glob of globs) assertRescopableGlob(glob);
  return db
    .transaction((): Rescoped => {
      const task = getTask(db, taskId);
      if (!task) throw refusal(`No task ${taskId}.`);
      const sessionId = claimingSession(db, taskId);
      if (sessionId === undefined) {
        throw refusal(
          `No session has claimed ${taskId}; widen its scope with \`pup plan edit ${taskId} --scope ...\`.`,
        );
      }
      const spec = readTaskSpec(db, taskId);
      const before = asTier(getSession(db, sessionId)?.tier) ?? taskTier(task.tier, spec.scopeIn);
      const added = [...new Set(globs)].filter((glob) => !spec.scopeIn.includes(glob));
      if (added.length === 0) return { sessionId, added, tier: before, raised: false };
      const widened = { ...spec, scopeIn: [...spec.scopeIn, ...added] };
      assertPlannableSpec(widened);
      if (!rescopeTaskSpec(db, taskId, JSON.stringify(widened))) {
        throw refusal(
          `Session ${workingSession(db, taskId)} is at work on ${taskId}; rescope once it stops.`,
        );
      }
      const open = listTaskSessions(db, taskId).find(windowOpen);
      if (open) {
        throw refusal(
          `Session ${open.id}'s window is still open, so its worker could keep editing ` +
            `${taskId}; rescope once the window is closed.`,
        );
      }
      const tier = settleTier(db, { taskId, sessionId }, before, widened.scopeIn);
      const raised = tier !== before;
      appendEvent(db, sessionId, 'rescope', { task: taskId, added, by: 'operator', tier, raised });
      insertDecisionRecord(db, {
        sessionId,
        summary: `The operator widened ${taskId}'s scope-in after launch, adding ${added.join(', ')}.`,
        files: added,
      });
      return { sessionId, added, tier, raised };
    })
    .immediate();
}
