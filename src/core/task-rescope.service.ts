import { basename } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { Tier } from '../claude/model-ladder.constants.js';
import {
  listPanes,
  listProcesses,
  PROBE_PATH,
  windowLabel,
  windowSockets,
} from '../claude/session-runtime.service.js';
import { insertDecisionRecord } from './decision-record.repository.js';
import { globToRegExpSource } from './glob.utils.js';
import { PROTECTED_PATH_GLOBS } from './merge-gate.constants.js';
import { InvalidProfileError } from './profile.errors.js';
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
import type { RescopeCaller } from './types/session-event.types.js';

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

/** The gate's protected paths, as its scope-audit matches them: case-insensitively. */
const PROTECTED = PROTECTED_PATH_GLOBS.map((glob) => new RegExp(globToRegExpSource(glob), 'i'));

/** The pre-commit hook a worker's own commits run in a repo with no `.husky`, as this one. */
const PRE_COMMIT = 'scripts/pre-commit';

/**
 * Whether the glob, in the matcher's form, can reach `scripts/pre-commit` in
 * any case: by matching it, or as a directory above it, bare or with a
 * trailing `/`, which the edit hooks read as everything beneath it.
 */
function reachesPreCommit(form: string): boolean {
  const dir = form.replace(/\/+$/, '').toLowerCase();
  return (
    new RegExp(globToRegExpSource(form), 'i').test(PRE_COMMIT) || PRE_COMMIT.startsWith(`${dir}/`)
  );
}

/**
 * The globs a rescope refuses, stricter than a plan's (decision 115): a
 * rescope widens a scope the gate already audited, so it names paths, never
 * the whole tree, never a path outside the repo, never the workflows a
 * same-repo PR runs with the repo's secrets, never a path the gate protects
 * from every session, never the git hooks a worker's commits run. A glob
 * metacharacter pup's matcher reads literally is refused outright, since a
 * gitignore- or bash-style matcher reads it as a class, a set or an escape
 * and would widen past it. Each check but the first reads the glob as the
 * matcher does, `globToRegExpSource`'s trim and one leading `./` stripped, so
 * a glob cannot dress past a check in what the matcher drops. A wildcard
 * anywhere in the first segment can match every top-level directory,
 * `.github` among them; past that check the first segment is literal, so a
 * path in it stands for every path the glob can reach there.
 */
const GLOB_REFUSALS: readonly (readonly [(raw: string, form: string) => boolean, string])[] = [
  [(raw) => CONTROL_CHAR.test(raw), 'contains a control character'],
  [
    (_raw, form) => /[[\]{}\\]/.test(form),
    'holds `[`, `]`, `{`, `}` or `\\`, which another matcher reads as a class, a set or an escape',
  ],
  [(_raw, form) => form === '', 'is empty'],
  [(_raw, form) => form.startsWith('/'), 'is absolute'],
  [(_raw, form) => /^[^/]*[*?]/.test(form), 'has a wildcard in its first segment'],
  [(_raw, form) => form.split('/').includes('..'), 'has a `..` segment'],
  [
    (_raw, form) => /^\.github(\/|$)/i.test(form),
    "reaches `.github`, whose workflows run with the repo's secrets",
  ],
  [
    (_raw, form) => PROTECTED.some((re) => re.test(`${form.split('/')[0]}/x`)),
    `reaches a path the gate protects whatever the scope (${PROTECTED_PATH_GLOBS.join(', ')})`,
  ],
  [
    (_raw, form) => /^\.husky(\/|$)/i.test(form),
    "reaches `.husky`, the git hooks that check a worker's own commits",
  ],
  [
    (_raw, form) => reachesPreCommit(form),
    `reaches \`${PRE_COMMIT}\`, the hook that checks a worker's own commits`,
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

/** The tmux name a pup launch passed as `--name` (`launchArgs`), if `args` carries one. */
function launchedName(args: string): string | undefined {
  const words = args.split(' ');
  const at = words.indexOf('--name');
  const name = at === -1 ? undefined : words[at + 1];
  return name?.startsWith('pup-') ? name : undefined;
}

/** The Claude Code pup launched that a process runs under, or why that could not be read. */
type LaunchedAncestor = { kind: 'launched'; name: string } | { kind: 'unreadable' };

/**
 * Whether this process runs under a Claude Code pup launched, a session's
 * window or a conductor's, read from the process tree rather than from an
 * environment or a cwd the caller sets (decision 115): each process from this
 * one's parent up is looked for the `--name pup-<...>` its launch passed.
 * A tmux process is passed over: a server lists the command that started it,
 * which can be a launch's, and the operator's own panes run under it. A `ps`
 * that failed is `unreadable`, which a rescope refuses. A process that left
 * the tree (a double fork, `setsid`, a job a tmux server or launchd started)
 * is under none, the ceiling decision 115 names.
 */
export function launchedAncestor(): LaunchedAncestor | undefined {
  const table = listProcesses();
  if (table === undefined) return { kind: 'unreadable' };
  const seen = new Set<number>();
  for (let pid = process.ppid; pid > 1 && !seen.has(pid); pid = table.get(pid)?.parent ?? 0) {
    seen.add(pid);
    const args = table.get(pid)?.args ?? '';
    const name = basename(args.split(' ')[0] ?? '').startsWith('tmux')
      ? undefined
      : launchedName(args);
    if (name !== undefined) return { kind: 'launched', name };
  }
  return undefined;
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
 * back. The CLI refuses a session and the conductor before this runs, and
 * hands over what it saw of the caller it took for the operator, which the
 * event records as seen, not as confirmed.
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
        };
      }
      const widened = { ...spec, scopeIn: [...spec.scopeIn, ...added] };
      assertPlannableSpec(widened);
      if (!rescopeTaskSpec(db, taskId, JSON.stringify(widened))) {
        throw refusal(
          `Session ${workingSession(db, taskId)} is at work on ${taskId}; rescope once it stops.`,
        );
      }
      const open = mayHaveOpenWindow(
        getProject(db, task.project_id)?.repo_path ?? '',
        listTaskSessions(db, taskId).map((row) => row.id),
      );
      if (open !== undefined) throw openWindowRefusal(taskId, open);
      // The task's row and the session's each from its own stored tier: a
      // relaunch routes from the task's, a fix round from the session's.
      // Raised on what the rescope adds, never on the old globs: a task the
      // operator pinned standard over a critical scope (decision 92) stays so.
      const raised = tierForScope(added) === 'critical' && raiseToCritical(db, taskId, sessionId);
      const tier = routedTier(db, taskId, sessionId, widened.scopeIn);
      appendEvent(db, sessionId, 'rescope', { task: taskId, added, tier, raised, ...caller });
      insertDecisionRecord(db, {
        sessionId,
        summary:
          `A caller taken for the operator (no session or conductor marker) widened ${taskId}'s ` +
          `scope-in after launch, adding ${added.join(', ')}.`,
        files: added,
      });
      return { sessionId, added, tier, raised };
    })
    .immediate();
}
