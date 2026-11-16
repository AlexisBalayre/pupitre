import { basename } from 'node:path';
import type { Database } from 'better-sqlite3';
import { listProcesses, recordedPanePids } from '../claude/session-runtime.service.js';
import { SESSION_ID_PATTERN } from './paths.constants.js';
import { listSessions } from './session.repository.js';
import { holdingStates } from './session-state.utils.js';

/**
 * What the process tree says of a caller it finds under a window pup opened,
 * or that it could not be read: a pane pid a launch recorded for one of the
 * project's windows, a process carrying a launch's `--name`, or a `ps` that
 * failed.
 */
export type LaunchedAncestor =
  | { kind: 'pane'; pid: number; window: string }
  | { kind: 'launched'; name: string }
  | { kind: 'unreadable' };

/** The tmux name a pup launch passed as `--name` (`launchArgs`), if `args` carries one. */
function launchedName(args: string): string | undefined {
  const words = args.split(' ');
  const at = words.indexOf('--name');
  const name = at === -1 ? undefined : words[at + 1];
  return name?.startsWith('pup-') ? name : undefined;
}

/**
 * Whether this process runs under a window pup opened, a session's or a
 * conductor's, read from the process tree rather than from an environment or
 * a cwd the caller sets (decisions 115, 188). `pup plan edit --rescope`,
 * `pup respawn`, `pup unblock`, `pup kill --respawn`, `pup dashboard` and
 * `pup merge` refuse every answer but none, and `pup ui` drives nothing on
 * one. Each process from this one's parent up is matched
 * first against the pane pids the project's launches recorded: the
 * conductor's while its window is up, and each session's in a state that can
 * hold a window, since a record outlives its window and its pid can be reused
 * once that is gone. pid and parent are what the kernel says, which no
 * process rewrites. Then against the `--name pup-<...>` pair a launch
 * passed Claude Code, which reaches any project's window but reads arguments
 * a process can overwrite. A tmux process is passed over there: a server lists
 * the command that started it, which can be a launch's, and the operator's
 * own panes run under it. A session id outside the minted shape names no
 * record and is skipped. A `ps` that failed is `unreadable`. A process that
 * left the tree (a double fork, `setsid`, a job a tmux server or launchd
 * started) is under none, the ceiling decision 115 names.
 *
 * A window named `spared` (the conductor's, for a `pup merge --pr` it may
 * run) is walked past rather than answered, and every pid up from it is
 * still asked, its own arguments included: a session can set a process's
 * title or write a record to name that window, but not leave its own above it.
 */
export function launchedAncestor(
  db: Database,
  repoPath: string,
  spared?: string,
): LaunchedAncestor | undefined {
  const table = listProcesses();
  if (table === undefined) return { kind: 'unreadable' };
  const panes = recordedPanePids(
    repoPath,
    listSessions(db, holdingStates())
      .map((row) => row.id)
      .filter((id) => SESSION_ID_PATTERN.test(id)),
  );
  const seen = new Set<number>();
  for (let pid = process.ppid; pid > 1 && !seen.has(pid); pid = table.get(pid)?.parent ?? 0) {
    seen.add(pid);
    const window = panes.get(pid);
    if (window !== undefined && window !== spared) return { kind: 'pane', pid, window };
    const args = table.get(pid)?.args ?? '';
    const name = basename(args.split(' ')[0] ?? '').startsWith('tmux')
      ? undefined
      : launchedName(args);
    if (name !== undefined && name !== spared) return { kind: 'launched', name };
  }
  return undefined;
}
