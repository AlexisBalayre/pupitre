import type { Database } from 'better-sqlite3';
import { sanitizeReason } from '../adapters/capability.utils.js';
import { launchedAncestor } from '../core/operator-guard.service.js';
import { projectId } from '../core/paths.utils.js';
import type { FleetReading } from '../core/types/fleet.types.js';
import type { LaunchedAncestor } from '../core/types/operator-guard.types.js';

/**
 * Refuse an operator-only command run under a window pup opened, a session's
 * or the conductor's, whatever its environment and cwd say: the markers are
 * the caller's word, and a caller can empty or unset them and leave its
 * worktree, but not leave the process tree it runs in (decisions 115, 188).
 * `ancestor` is what the process tree said, asked of the project's store the
 * command acts on, after the marker checks, which name the caller in plainer
 * words when it kept its markers. A tree `ps` could not read refuses too: it
 * cannot tell the caller from a window. Prints the refusal and returns true
 * when it refused.
 */
export function refusedUnderWindow(
  ancestor: LaunchedAncestor | undefined,
  command: string,
): boolean {
  if (ancestor === undefined) return false;
  const under = underWindow(ancestor);
  console.error(
    under === undefined
      ? `${command} could not read the process tree (\`ps\` failed), so it cannot tell this ` +
          'caller from a session or the conductor; nothing changed.'
      : `${command} is operator-only, and this runs under ${under}, whatever its environment ` +
          'says; run it from your own shell.',
  );
  process.exitCode = 1;
  return true;
}

/** What the caller runs under, in words; undefined for a tree `ps` could not read. */
function underWindow(ancestor: LaunchedAncestor): string | undefined {
  if (ancestor.kind === 'pane') {
    return `process ${ancestor.pid}, the pane pup recorded for ${sanitizeReason(ancestor.window)}'s window`;
  }
  return ancestor.kind === 'launched'
    ? `${sanitizeReason(ancestor.name)}, a Claude Code pup launched`
    : undefined;
}

/**
 * Why `pup ui` drives nothing for a caller under a window pup opened in any of
 * `stores`, whatever its environment says, asked as the guarded commands ask
 * it (decision 188): its keys run the respawn, the unblock and the merge.
 * Undefined when the caller runs under none.
 */
export function readOnlyUnderWindow(
  stores: readonly { db: Database; repoPath: string }[],
): string | undefined {
  for (const { db, repoPath } of stores) {
    const ancestor = launchedAncestor(db, repoPath);
    if (ancestor === undefined) continue;
    const under = underWindow(ancestor);
    return under === undefined
      ? 'read-only: the process tree could not be read (`ps` failed), so this caller cannot be ' +
          'told from a session or the conductor (decision 188).'
      : `read-only: this runs under ${under}, whatever its environment says (decision 188).`;
  }
  return undefined;
}

/**
 * The fleet `pup ui` drives, and why it drives nothing: each store its first
 * reading rendered is asked as `readOnlyUnderWindow` asks it (decision 188),
 * and only those are ever driven. A store whose first snapshot threw stays
 * open and renders once it mends, so a caller could break its own project's
 * reading to skip the check and mend it to be handed that project's keys:
 * every later reading lists it as a line, never a row, until `pup ui` starts
 * again and asks it.
 */
export function askedFleet(read: () => FleetReading): {
  read: () => FleetReading;
  readOnlyReason: string | undefined;
} {
  const asked = new Set(read().projects.map(({ deps }) => deps));
  return {
    read: () => {
      const { projects, unreadable } = read();
      const unasked = projects.filter(({ deps }) => !asked.has(deps));
      return {
        projects: projects.filter(({ deps }) => asked.has(deps)),
        unreadable: [
          ...unreadable,
          ...unasked.map(
            ({ deps }) =>
              `${projectId(deps.repoPath)}  ${sanitizeReason(deps.repoPath)}  held out: ` +
              'unreadable when `pup ui` started, so never asked whether this runs under its ' +
              'windows; restart it to read this (decision 188)',
          ),
        ],
      };
    },
    readOnlyReason: readOnlyUnderWindow([...asked]),
  };
}
