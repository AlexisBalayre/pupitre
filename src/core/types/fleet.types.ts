import type { Database } from 'better-sqlite3';
import type { DashboardSnapshot, FleetSummary } from './dashboard.types.js';

/**
 * A project `pup init` registered, read back from its own store under
 * `~/.pupitre`. Owned here, where the fleet reads it; `listRegisteredProjects`
 * in `src/cli/project.utils.ts` is its producer (decision 65).
 */
export interface RegisteredProject {
  id: string;
  repoPath: string;
  dbFile: string;
  /** False when the repo was deleted or moved since it registered — reported, never used. */
  repoExists: boolean;
  /**
   * False when `repoPath` is not its own canonical path — a trailing slash, a
   * symlink, a `..` — reported, never opened (decision 61, checked by the scan since 65).
   */
  isOwnPath: boolean;
  /** When the operator put the project to sleep, or null while it is active (decision 62). */
  dormantAt: string | null;
}

/**
 * One fleet project as `pup status` prints it: a line saying why it was not
 * read, or its snapshot and what in it waits on the operator (decision 60).
 */
export type FleetBlock =
  | { header: string; reason: string }
  | {
      header: string;
      snapshot: DashboardSnapshot;
      summary: FleetSummary;
      dormantAt: string | null;
    };

/**
 * One fleet project's open store and repo, and the bin its keys re-enter pup
 * with: `pup ui`'s `ActionDeps`, owned here so the fleet and the dashboard
 * cannot drift apart.
 */
export interface FleetStore {
  db: Database;
  repoPath: string;
  /**
   * Absolute path to the `pup` entry script — `process.argv[1]`, the same value
   * a session's environment carries as `PUP_BIN`. Only the merge uses it, and
   * only because the merge runs as a child.
   */
  pupBin: string;
}

/**
 * One look at the fleet: `pup ui`'s `DashboardReading`, the unreadable lines
 * already sanitized as `pup status` prints them.
 */
export interface FleetReading {
  projects: { deps: FleetStore; snapshot: DashboardSnapshot }[];
  unreadable: string[];
}
