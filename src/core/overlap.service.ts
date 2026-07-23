import { execFileSync } from 'node:child_process';
import type { Database } from 'better-sqlite3';

import { gitDiffPaths, scrubbedGitEnv } from './git-diff.client.js';
import { recordWatcherBeat, replaceOverlaps } from './overlap.repository.js';
import { projectId } from './paths.utils.js';
import { listSessions } from './session.repository.js';
import type { OverlapPair } from './types/overlap.types.js';

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
  const target = execFileSync('git', ['-C', repoPath, 'branch', '--show-current'], {
    encoding: 'utf8',
    env: scrubbedGitEnv(),
  }).trim();
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
