import type { Database } from 'better-sqlite3';
import {
  listPanes,
  PROBE_PATH,
  windowLabel,
  windowSockets,
} from '../claude/session-runtime.service.js';
import type { Tier } from '../claude/types/model-ladder.types.js';
import { insertDecisionRecord } from './decision-record.repository.js';
import { InvalidProfileError } from './errors/profile.errors.js';
import { globToRegExpSource } from './glob.utils.js';
import { PROTECTED_PATH_GLOBS } from './merge-gate.constants.js';
import { scopeConflicts } from './overlap.service.js';
import { asStringArray, parseJsonOr } from './report-data.utils.js';
import { asTier, taskTier, tierForScope } from './routing.utils.js';
import {
  appendEvent,
  claimingSession,
  getProject,
  getSession,
  getTask,
  listTaskSessions,
  raiseToCritical,
  readTaskSpec,
  rescopeTaskSpec,
  workingSession,
} from './session.repository.js';
import { assertPlannableSpec } from './task-spec.utils.js';
import type { ScopeConflict } from './types/overlap.types.js';
import type { RescopeCaller } from './types/session-event.types.js';

/**
 * What a rescope did: the globs it appended, none when all were there, the
 * tier it leaves, and the live sessions of other tasks the added globs share
 * files with.
 */
interface Rescoped {
  sessionId: string;
  added: string[];
  tier: Tier;
  raised: boolean;
  overlaps: ScopeConflict[];
}

/** Any C0 control, DEL or C1 control: none belongs in a path. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/;

/** The paths a glob matches, case-insensitively, as the scope-audit reads protected ones. */
interface Reach {
  /** The glob before its first wildcard, lower-cased: every path it matches starts with it. */
  prefix: string;
  /** The one path it matches, when it has no wildcard. */
  path?: string;
  matches: (path: string) => boolean;
}

/**
 * What `glob` reaches as the matcher reads it: trimmed, one leading `./`
 * dropped, a trailing `/` reaching all beneath.
 */
function reach(glob: string): Reach {
  const form = glob.trim().replace(/^\.\//, '');
  const re = new RegExp(globToRegExpSource(glob), 'i');
  const literal = !/[*?]/.test(form) && !form.endsWith('/');
  return {
    prefix: form.replace(/[*?].*/s, '').toLowerCase(),
    ...(literal ? { path: form } : {}),
    matches: (path) => re.test(path),
  };
}

/** Every path beneath `path`, read as the directory it can be. */
function beneath(path: string): Reach {
  const prefix = `${path}/`.toLowerCase();
  return { prefix, matches: (other) => other.toLowerCase().startsWith(prefix) };
}

/**
 * Whether two reaches can share a path. Two whose prefixes diverge cannot;
 * past that, one without a wildcard has a single path, which the other
 * matches or not, and two with wildcards are taken to share one.
 */
function overlaps(a: Reach, b: Reach): boolean {
  if (!a.prefix.startsWith(b.prefix) && !b.prefix.startsWith(a.prefix)) return false;
  if (b.path !== undefined) return a.matches(b.path);
  if (a.path !== undefined) return b.matches(a.path);
  return true;
}

/** The gate's protected paths. */
const PROTECTED = PROTECTED_PATH_GLOBS.map(reach);

/** What a rescope glob reaches: a path without a wildcard stands for itself and all beneath it. */
function rescopeReach(glob: string): Reach[] {
  const own = reach(glob);
  return own.path === undefined ? [own] : [own, beneath(own.path)];
}

/**
 * The pre-commit hook a worker's own commits run in a repo with no `.husky`, as
 * this one. Refused in every project pup manages: git records no tracked source
 * for a hook it runs, so pup cannot name another project's (decision 115).
 */
const PRE_COMMIT = 'scripts/pre-commit';

/**
 * The globs a rescope refuses, stricter than a plan's (decision 115): a
 * rescope widens a scope the gate already audited, so it names paths, never
 * the whole tree, never a path outside the repo, never the workflows a
 * same-repo PR runs with the repo's secrets, never a path the gate protects
 * from every session, never the git hooks a worker's commits run. A glob
 * metacharacter pup's matcher reads literally is refused outright, since a
 * gitignore-, bash- or extglob-style matcher reads it as a class, a set, an
 * escape, a pattern list or a negation and would widen past it. A bare `+`
 * or `@` is extglob syntax only before a `(`, which is refused, so
 * `src/routes/+page.svelte` and `packages/@acme/ui/**` pass; `!` is refused
 * anywhere, since a leading one negates the whole glob in minimatch,
 * picomatch and gitignore. A leading `:` is git pathspec magic (`:^src`,
 * `:!src`), which excludes rather than names. Each check
 * but the first reads the glob as the matcher does, `globToRegExpSource`'s
 * trim and one leading `./` stripped, so a glob cannot dress past a check in
 * what the matcher drops. A wildcard
 * anywhere in the first segment can match every top-level directory,
 * `.github` among them. A protected entry, a file or a directory at any
 * depth, is refused whenever the glob can share a path with it (`overlaps`).
 */
const GLOB_REFUSALS: readonly (readonly [(raw: string, form: string) => boolean, string])[] = [
  [(raw) => CONTROL_CHAR.test(raw), 'contains a control character'],
  [
    (_raw, form) => /[[\]{}\\()|!]/.test(form),
    'holds `[`, `]`, `{`, `}`, `\\`, `(`, `)`, `|` or `!`, which another matcher reads as a class, a set, an escape, an extglob pattern list such as `+(a)` or a negation',
  ],
  [(_raw, form) => form.startsWith(':'), 'starts with `:`, which git reads as pathspec magic'],
  [
    (_raw, form) =>
      form
        .replace(/\/$/, '')
        .split('/')
        .some((segment) => segment === '.' || segment === ''),
    'is empty, absolute or has a `.` or an empty segment, which a normalizing matcher drops',
  ],
  [(_raw, form) => /^[^/]*[*?]/.test(form), 'has a wildcard in its first segment'],
  [(_raw, form) => form.split('/').includes('..'), 'has a `..` segment'],
  [
    (_raw, form) => /^\.github(\/|$)/i.test(form),
    "reaches `.github`, whose workflows run with the repo's secrets",
  ],
  [
    (raw) => rescopeReach(raw).some((own) => PROTECTED.some((guarded) => overlaps(own, guarded))),
    `reaches a path the gate protects whatever the scope (${PROTECTED_PATH_GLOBS.join(', ')})`,
  ],
  [
    // `scripts/pre-commit` by a glob that matches it, or by a directory above
    // it, bare or with a trailing `/`: pup's matcher reads a bare `scripts`
    // as that one path, but a gitignore-style one reads it as all beneath.
    (_raw, form) =>
      /^\.husky(\/|$)/i.test(form) ||
      new RegExp(globToRegExpSource(form), 'i').test(PRE_COMMIT) ||
      PRE_COMMIT.startsWith(`${form.replace(/\/+$/, '').toLowerCase()}/`),
    `reaches a git hook that checks a worker's own commits (\`.husky\`, \`${PRE_COMMIT}\`)`,
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
 * The pane `listPanes` lines list for the session, if any: one in the tmux
 * session of its launch name, or one whose start command carries the launch's
 * `--name <tmux name>` (`launchArgs`). tmux fixes a pane's start command when
 * it starts it, so a worker that renames its session or moves its pane still
 * matches, and a pane id is never matched: a `%N` means a pane only on the
 * server that minted it, and a restarted or another server reuses it.
 */
function listedPane(lines: readonly string[], sessionId: string): string | undefined {
  const name = windowLabel({ sessionId });
  return lines
    .map((line) => line.split('\t'))
    .find(
      ([, started = '', ...listed]) =>
        listed.join('\t') === name || ` ${started} `.includes(` --name ${name} `),
    )?.[0];
}

/** Why a rescope cannot rule out an open window: what the refusal names. */
type OpenWindow =
  | { kind: 'listed'; sessionId: string; socket: string; pane: string }
  | { kind: 'unanswered'; socket: string; detail: string }
  | { kind: 'no-tmux' };

/**
 * Why a window of `sessionIds`, sessions of the project at `repoPath`, may
 * still be open, or undefined when every server asked answered and listed
 * none of them (decision 115). A server that did not answer, no server
 * running and a timeout included, leaves every window possibly open, and so
 * does a tmux `PROBE_PATH` does not hold; each is named apart, since neither
 * is fixed by closing a window.
 */
function mayHaveOpenWindow(
  repoPath: string,
  sessionIds: readonly string[],
): OpenWindow | undefined {
  const servers = windowSockets(repoPath, sessionIds).map((socket) => ({
    socket,
    panes: listPanes(socket),
  }));
  for (const { socket, panes } of servers) {
    if (Array.isArray(panes)) continue;
    return panes.noTmux
      ? { kind: 'no-tmux' }
      : { kind: 'unanswered', socket, detail: panes.detail };
  }
  for (const sessionId of sessionIds) {
    for (const { socket, panes } of servers) {
      const pane = Array.isArray(panes) ? listedPane(panes, sessionId) : undefined;
      if (pane !== undefined) return { kind: 'listed', sessionId, socket, pane };
    }
  }
  return undefined;
}

/**
 * The refusal for a window the probe cannot rule closed, naming what it saw,
 * so the operator knows whether to close a window, start a server or install
 * tmux where the probe looks.
 */
function openWindowRefusal(taskId: string, open: OpenWindow): InvalidProfileError {
  switch (open.kind) {
    case 'listed':
      return refusal(
        `Session ${open.sessionId}'s window is open: the tmux server at ${open.socket} lists ` +
          `it as pane ${open.pane}, so its worker could keep editing ${taskId}; rescope once ` +
          'it is closed.',
      );
    case 'unanswered':
      return refusal(
        `The tmux server at ${open.socket} did not answer (${open.detail}), so a window of ` +
          `${taskId}'s sessions may be open on it; rescope once a server answers there.`,
      );
    case 'no-tmux':
      return refusal(
        `No tmux on the window probe's fixed PATH (${PROBE_PATH}), so a rescope cannot check ` +
          `that no window of ${taskId}'s sessions is open; link tmux into one of those directories.`,
      );
  }
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
 * `pup fix` all read the widened spec. The added globs go through a launch's
 * overlap check against every live session of another task (decision 99):
 * what they share is recorded and returned, never refused, and the next fix
 * round introduces the workers. The read, the checks, the write, the tier
 * raise, the `rescope` event on the claiming session, its overlaps and the
 * decision record `pup log` lists are one immediate transaction: no other
 * writer lands between the read and the write, and a refusal after the write
 * rolls it back. The CLI refuses a session and the conductor before this
 * runs, and hands over what it saw of the caller it took for the operator,
 * which the event records as seen, not as confirmed (decision 188).
 */
export function rescopeTask(
  db: Database,
  taskId: string,
  globs: string[],
  caller: RescopeCaller,
): Rescoped {
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
          overlaps: [],
        };
      }
      const widened = { ...spec, scopeIn: [...spec.scopeIn, ...added] };
      assertPlannableSpec(widened);
      if (!rescopeTaskSpec(db, taskId, JSON.stringify(widened))) {
        throw refusal(
          `Session ${workingSession(db, taskId)} is at work on ${taskId}; rescope once it stops.`,
        );
      }
      const repoPath = getProject(db, task.project_id)?.repo_path ?? '';
      const taskSessions = listTaskSessions(db, taskId).map((row) => row.id);
      const open = mayHaveOpenWindow(repoPath, taskSessions);
      if (open !== undefined) throw openWindowRefusal(taskId, open);
      // The task's own sessions hold its scope already: only another task's
      // session is an overlap.
      const overlaps = scopeConflicts(db, repoPath, added, widened.scopeOut).filter(
        (conflict) => !taskSessions.includes(conflict.sessionId),
      );
      // The task's row and the session's each from its own stored tier: a
      // relaunch routes from the task's, a fix round from the session's.
      // Raised on what the rescope adds, never on the old globs: a task the
      // operator pinned standard over a critical scope (decision 92) stays so.
      const raised = tierForScope(added) === 'critical' && raiseToCritical(db, taskId, sessionId);
      const tier = routedTier(db, taskId, sessionId, widened.scopeIn);
      appendEvent(db, sessionId, 'rescope', { task: taskId, added, tier, raised, ...caller });
      if (overlaps.length > 0) {
        appendEvent(db, sessionId, 'scope_overlap', {
          via: 'rescope',
          accepted: overlaps.map((conflict) => ({
            session: conflict.sessionId,
            files: conflict.files,
          })),
        });
      }
      insertDecisionRecord(db, {
        sessionId,
        summary:
          `A caller taken for the operator (no session or conductor marker) widened ${taskId}'s ` +
          `scope-in after launch, adding ${added.join(', ')}.`,
        files: added,
      });
      return { sessionId, added, tier, raised, overlaps };
    })
    .immediate();
}

/** A rescope as the gate's PR body and the needs-you inbox show it. */
export interface TaskRescope {
  /** When it was recorded, as the store holds it. */
  at: string;
  sessionId: string;
  added: string[];
  tier: string;
  raised: boolean;
  /** What was seen of the caller (decision 115): evidence, not proof. */
  by: string;
  tty: string | null;
  tmuxPane: string | null;
}

/**
 * Every rescope on `taskId`, oldest first, read off the `rescope` events of
 * the sessions that ran it (decision 188), so a relaunch after a kill still
 * shows the rescopes its predecessor's claim took. The store is
 * session-writable: each field is taken only in the type a rescope writes,
 * and the caller scrubs the text before it prints.
 */
export function taskRescopes(db: Database, taskId: string): TaskRescope[] {
  const rows = db
    .prepare(
      `SELECT events.session_id, events.payload, events.created_at FROM events
       JOIN sessions ON sessions.id = events.session_id
       WHERE sessions.task_id = ? AND events.type = 'rescope' ORDER BY events.id`,
    )
    .all(taskId) as { session_id: string; payload: string; created_at: string }[];
  return rows.map((row) => {
    const fields = parseJsonOr<Record<string, unknown>>(row.payload, {});
    const text = (key: string): string | null =>
      typeof fields[key] === 'string' ? (fields[key] as string) : null;
    return {
      at: row.created_at,
      sessionId: row.session_id,
      added: asStringArray(fields.added),
      tier: text('tier') ?? 'unknown',
      raised: fields.raised === true,
      by: text('by') ?? 'unknown',
      tty: text('tty'),
      tmuxPane: text('tmuxPane'),
    };
  });
}
