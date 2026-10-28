import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { Tier } from '../claude/model-ladder.constants.js';
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
import { assertPlannableSpec } from './task-spec.utils.js';

/** What a rescope did: the globs it appended, none when all were there, and the tier it leaves. */
interface Rescoped {
  sessionId: string;
  added: string[];
  tier: Tier;
  raised: boolean;
}

/** Any C0 control, DEL or C1 control: none belongs in a path. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The globs a rescope refuses, stricter than a plan's (decision 115): a
 * rescope widens a scope the gate already audited, so it names paths, never
 * the whole tree, never a path outside the repo, never the workflows a
 * same-repo PR runs with the repo's secrets. Each check but the first reads
 * the glob as the matcher does, `globToRegExpSource`'s trim and one leading
 * `./` stripped, so a glob cannot dress past a check in what the matcher
 * drops. A wildcard anywhere in the first segment can match every top-level
 * directory, `.github` among them.
 */
const GLOB_REFUSALS: readonly (readonly [(raw: string, form: string) => boolean, string])[] = [
  [(raw) => CONTROL_CHAR.test(raw), 'contains a control character'],
  [(_raw, form) => form === '', 'is empty'],
  [(_raw, form) => form.startsWith('/'), 'is absolute'],
  [(_raw, form) => /^[^/]*[*?]/.test(form), 'has a wildcard in its first segment'],
  [(_raw, form) => form.split('/').includes('..'), 'has a `..` segment'],
  [
    (_raw, form) => /^\.github(\/|$)/i.test(form),
    "reaches `.github`, whose workflows run with the repo's secrets",
  ],
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
  const form = glob.trim().replace(/^\.\//, '');
  const refused = GLOB_REFUSALS.find(([test]) => test(glob, form));
  if (refused) throw refusal(`Rescope glob ${JSON.stringify(glob)} ${refused[1]}.`);
}

/**
 * Where tmux is looked up, in place of the caller's PATH: a worker cannot hand
 * the probe a fake tmux.
 */
const TMUX_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

/**
 * Past this a probe counts as unanswered. It runs inside the store's write
 * lock, so a listener at the socket that never replies must not hold it.
 */
const PROBE_TIMEOUT_MS = 2000;

/**
 * The sockets a session's window can be on: the default server's at tmux's
 * built-in `/tmp`, and at the operator's `TMUX_TMPDIR` when set, which the
 * launch hands tmux (decision 47). An empty one is unset, as tmux reads it.
 */
function tmuxSockets(): string[] {
  const uid = process.getuid?.();
  const dirs = ['/tmp', process.env.TMUX_TMPDIR || '/tmp'];
  return [...new Set(dirs.map((dir) => join(dir, `tmux-${uid}`, 'default')))];
}

/**
 * Every pane on the server at `socket`, one `<pane id> <session name>` line
 * each; undefined when it did not answer in time, for any reason.
 */
function listPanes(socket: string): string | undefined {
  try {
    return execFileSync(
      'tmux',
      ['-S', socket, 'list-panes', '-a', '-F', '#{pane_id} #{session_name}'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: TMUX_PATH },
        timeout: PROBE_TIMEOUT_MS,
      },
    );
  } catch {
    return undefined;
  }
}

/**
 * Whether the server lists the session's window: its recorded pane, or a
 * tmux session wearing the name its launch gave it (`pup-<id>`).
 */
function listsWindow(panes: string, row: SessionRow): boolean {
  return panes.split('\n').some((line) => {
    const [pane, name] = line.split(' ');
    return pane === row.tmux_target || name === `pup-${row.id}`;
  });
}

/** The tier the session's next window routes on, as `sessionWindowRoute` reads it. */
function routedTier(db: Database, taskId: string, sessionId: string, scopeIn: string[]): Tier {
  return (
    asTier(getSession(db, sessionId)?.tier) ?? taskTier(getTask(db, taskId)?.tier ?? null, scopeIn)
  );
}

/**
 * `pup plan edit <task> --rescope --scope <glob...>`: append globs to the
 * scope-in of a task a session claimed, whose spec `pup plan edit` otherwise
 * keeps frozen (decision 115). Never removes a glob. Refused while a session
 * on the task is in a state that is not listed as rescopable, which the
 * write's own guard decides, or may still have a window open, whose hooks
 * hold the old scope: one a default tmux server lists, or any at all when one
 * does not answer. Once it has stopped, the gate, `pup review` and the next
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
      const added = [...new Set(globs)].filter((glob) => !spec.scopeIn.includes(glob));
      if (added.length === 0) {
        return {
          sessionId,
          added,
          tier: routedTier(db, taskId, sessionId, spec.scopeIn),
          raised: false,
        };
      }
      const widened = { ...spec, scopeIn: [...spec.scopeIn, ...added] };
      assertPlannableSpec(widened);
      if (!rescopeTaskSpec(db, taskId, JSON.stringify(widened))) {
        throw refusal(
          `Session ${workingSession(db, taskId)} is at work on ${taskId}; rescope once it stops.`,
        );
      }
      const servers = tmuxSockets().map(listPanes);
      const open = listTaskSessions(db, taskId).find((row) =>
        servers.some((panes) => panes === undefined || listsWindow(panes, row)),
      );
      if (open) {
        throw refusal(
          `Session ${open.id}'s window may still be open (a default tmux server lists it, or ` +
            `did not answer), so its worker could keep editing ${taskId}; rescope once it is closed.`,
        );
      }
      // The task's row and the session's each from its own stored tier: a
      // relaunch routes from the task's, a fix round from the session's.
      const raised =
        tierForScope(widened.scopeIn) === 'critical' && raiseToCritical(db, taskId, sessionId);
      const tier = routedTier(db, taskId, sessionId, widened.scopeIn);
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
