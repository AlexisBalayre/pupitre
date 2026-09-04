import { execFileSync } from 'node:child_process';
import type { Database } from 'better-sqlite3';

import { GIT_SAFE_CONFIG, gitDiffPaths, scrubbedGitEnv } from './git-diff.client.js';
import { recordWatcherBeat, replaceOverlaps } from './overlap.repository.js';
import { projectId } from './paths.utils.js';
import { scopedPaths } from './scope-audit.utils.js';
import { getTask, listSessions } from './session.repository.js';
import { holdingStates } from './session-state.utils.js';
import type { OverlapPair, ScopeConflict } from './types/overlap.types.js';
import type { TaskSpec } from './types/profile.types.js';

/** Cadence of the conflict radar; status flags the watcher stale above 3x this. */
export const WATCH_INTERVAL_MS = 15_000;
export const WATCH_STALE_AFTER_MS = 3 * WATCH_INTERVAL_MS;

/** Pairwise same-file intersections, session ids in insertion order, files sorted. */
export function intersectSessionFiles(filesBySession: Record<string, string[]>): OverlapPair[] {
  const entries = Object.entries(filesBySession).map(
    ([id, files]) => [id, new Set(files)] as const,
  );
  const pairs: OverlapPair[] = [];
  for (let a = 0; a < entries.length; a++) {
    for (let b = a + 1; b < entries.length; b++) {
      const [idA, filesA] = entries[a] as (typeof entries)[number];
      const [idB, filesB] = entries[b] as (typeof entries)[number];
      const shared = [...filesA].filter((file) => filesB.has(file)).sort();
      if (shared.length > 0) pairs.push({ sessionA: idA, sessionB: idB, files: shared });
    }
  }
  return pairs;
}

/**
 * One radar sweep: diff every live session's branch against the target (same
 * merge-base diff the gate and review queue use), store the pairwise same-file
 * overlaps, and record a heartbeat so `pup status` can tell a silent radar
 * from a dead one. A session whose diff errors (branch gone mid-scan) is
 * skipped rather than failing the sweep.
 */
export function scanOverlaps(db: Database, repoPath: string, now = new Date()): OverlapPair[] {
  const target = execFileSync(
    'git',
    [...GIT_SAFE_CONFIG, '-C', repoPath, 'branch', '--show-current'],
    {
      encoding: 'utf8',
      env: scrubbedGitEnv(),
    },
  ).trim();
  const live = listSessions(db, ['running', 'awaiting-review']);
  const filesBySession: Record<string, string[]> = {};
  for (const session of live) {
    try {
      filesBySession[session.id] = gitDiffPaths(repoPath, target, session.branch);
    } catch {
      // branch may have just been merged/deleted; the next sweep self-corrects
    }
  }
  const pairs = intersectSessionFiles(filesBySession);
  replaceOverlaps(db, pairs);
  recordWatcherBeat(db, projectId(repoPath), now);
  return pairs;
}

/**
 * The key the task under consideration is filed under while it is compared
 * against live sessions. `sessionSlug` maps everything outside `[a-zA-Z0-9]`
 * to `-`, so no minted session id can contain a `:` and collide with it.
 */
const CANDIDATE_KEY = 'launch:candidate';

/**
 * Live sessions whose scope already claims tracked files this scope also
 * claims — admission control for `pup launch`, asked before a worktree exists
 * (decision 41).
 *
 * Scopes are resolved against `git ls-files` rather than a diff because the
 * task has written nothing yet, which is the whole point: the radar reports an
 * overlap once both agents are in the file, this refuses the second launch.
 * The consequence is that a scope naming only files that do not exist yet
 * resolves to nothing and cannot conflict.
 */
export function scopeConflicts(
  db: Database,
  repoPath: string,
  scopeIn: string[],
  scopeOut: string[] = [],
): ScopeConflict[] {
  const live = listSessions(db, holdingStates());
  // No live session means nothing to compare against, and skipping the git
  // call keeps a launch into a fresh repo from depending on one.
  if (live.length === 0) return [];
  const tracked = trackedFiles(repoPath);
  const filesBySession: Record<string, string[]> = {};
  for (const session of live) {
    // Both branches are unreachable while the store is pup's own: an id cannot
    // contain a `:`, and `sessions.task_id` is a NOT NULL foreign key. They are
    // loud rather than skipped because a scope this cannot read is a scope it
    // cannot clear, and silently comparing against nothing is the fail-open
    // direction (decision 29).
    if (session.id === CANDIDATE_KEY) throw new Error(`Session ${session.id} shadows the launch.`);
    const task = getTask(db, session.task_id);
    if (!task) throw new Error(`Session ${session.id} has no task ${session.task_id}.`);
    const spec = JSON.parse(task.spec) as TaskSpec;
    filesBySession[session.id] = scopedPaths(tracked, spec.scopeIn ?? [], spec.scopeOut ?? []);
  }
  filesBySession[CANDIDATE_KEY] = scopedPaths(tracked, scopeIn, scopeOut);
  // Either side, so the answer does not rest on the candidate having been
  // inserted last — an invariant a later refactor would silently break, leaving
  // the check reporting no conflict ever.
  return intersectSessionFiles(filesBySession)
    .filter((pair) => pair.sessionA === CANDIDATE_KEY || pair.sessionB === CANDIDATE_KEY)
    .map((pair) => ({
      sessionId: pair.sessionA === CANDIDATE_KEY ? pair.sessionB : pair.sessionA,
      files: pair.files,
    }));
}

/**
 * Tracked repo-relative paths. `-z` for the same reason `gitDiffPaths` uses
 * it: git C-quotes non-ASCII names otherwise, and a quoted path would match
 * different globs than the real one.
 */
function trackedFiles(repoPath: string): string[] {
  return execFileSync('git', [...GIT_SAFE_CONFIG, '-C', repoPath, 'ls-files', '-z'], {
    encoding: 'utf8',
    env: scrubbedGitEnv(),
  })
    .split('\0')
    .filter(Boolean);
}
