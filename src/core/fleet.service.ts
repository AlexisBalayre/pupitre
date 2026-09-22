import type { Database } from 'better-sqlite3';
import { failureSummary, sanitizeReason } from '../adapters/capability.utils.js';
import { buildDashboardSnapshot, fleetSummary } from './dashboard.service.js';
import { openStore } from './db.client.js';
import type { DashboardSnapshot, FleetSummary } from './types/dashboard.types.js';

/**
 * A registered project as the registry scan reads it — `listRegisteredProjects`'
 * rows, which answer whether the repo is still there and whether its path is
 * its own without opening the store.
 */
interface FleetProject {
  id: string;
  repoPath: string;
  dbFile: string;
  repoExists: boolean;
  isOwnPath: boolean;
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

/** One fleet project's open store and repo, and the bin its keys re-enter pup with. */
interface FleetStore {
  db: Database;
  repoPath: string;
  pupBin: string;
}

/**
 * One look at the fleet: `pup ui`'s `DashboardReading`, the unreadable lines
 * already sanitized as `pup status` prints them.
 */
interface FleetReading {
  projects: { deps: FleetStore; snapshot: DashboardSnapshot }[];
  unreadable: string[];
}

/**
 * Why a fleet project is listed but never opened, or undefined when it may be
 * opened. A repo that is gone is decision 60's case; a `repo_path` that is not
 * its own canonical path is decision 61's, a store a session can plant to be
 * listed as a near-twin of the real project, whose `l` would launch the
 * session's spec there and whose `c` would start a conductor.
 */
function fleetRefusal(project: FleetProject): string | undefined {
  if (!project.repoExists) return 'missing: the repo no longer exists';
  if (!project.isOwnPath) return 'not its own path: a variant of a repo path, never opened';
  return undefined;
}

/** A fleet project's id and repo, as its `pup status` block and `pup ui` line lead. */
function fleetHeader(project: FleetProject): string {
  return `${project.id}  ${sanitizeReason(project.repoPath)}`;
}

/**
 * The fleet both readers draw: every registered project, less the dormant ones
 * unless `--dormant` asks for them (decision 62). The dormant flag is read
 * from each store's own row by the read-only registry scan, so a hidden
 * project's store is never opened; `hidden` is how many were left out.
 */
function awakeFleet(
  registered: FleetProject[],
  shouldShowDormant: boolean,
): { shown: FleetProject[]; hidden: number } {
  const shown = shouldShowDormant
    ? registered
    : registered.filter((project) => project.dormantAt === null);
  return { shown, hidden: registered.length - shown.length };
}

/**
 * `pup status`'s fleet: one block per shown project, from each store's own
 * snapshot. A project `fleetRefusal` turns away is a line and its store left
 * shut — opening it would migrate a store nobody can act on, or one a session
 * planted. One store that fails to open, migrate or snapshot is that project's
 * line, not the fleet's end, as `listRegisteredProjects` degrades an unreadable
 * store. Each store is closed before the next is opened, so a long fleet holds
 * one handle at a time.
 */
export function readFleet(
  registered: FleetProject[],
  now: number,
  shouldShowDormant: boolean,
): { blocks: FleetBlock[]; hidden: number } {
  const { shown, hidden } = awakeFleet(registered, shouldShowDormant);
  const blocks = shown.map((project): FleetBlock => {
    const header = fleetHeader(project);
    const refusal = fleetRefusal(project);
    if (refusal) return { header, reason: refusal };
    let db: Database | undefined;
    try {
      db = openStore(project.dbFile);
      const snapshot = buildDashboardSnapshot(db, project.repoPath, now);
      return { header, snapshot, summary: fleetSummary(snapshot), dormantAt: project.dormantAt };
    } catch (error) {
      return { header, reason: `unreadable: ${failureSummary(error)}` };
    } finally {
      db?.close();
    }
  });
  return { blocks, hidden };
}

/**
 * `pup ui --all`'s reading (decision 61): every shown project's store, opened
 * once and held for the dashboard's life, since each row's keys write through
 * its own project's store and repo — never the cwd's. A project `fleetRefusal`
 * turns away, or whose store will not open, is a line of its own and never
 * opened again; one whose snapshot throws is that reading's line, and the rest
 * of the fleet still renders — `readFleet`'s isolation, per reading.
 */
export function fleetReading(
  registered: FleetProject[],
  shouldShowDormant: boolean,
  pupBin: string,
): () => FleetReading {
  const shut: string[] = [];
  const opened: { header: string; deps: FleetStore }[] = [];
  for (const project of awakeFleet(registered, shouldShowDormant).shown) {
    const header = fleetHeader(project);
    const refusal = fleetRefusal(project);
    if (refusal) {
      shut.push(`${header}  ${refusal}`);
      continue;
    }
    try {
      const db = openStore(project.dbFile);
      opened.push({ header, deps: { db, repoPath: project.repoPath, pupBin } });
    } catch (error) {
      shut.push(`${header}  unreadable: ${failureSummary(error)}`);
    }
  }
  return () => {
    const now = Date.now();
    const reading: FleetReading = { projects: [], unreadable: [...shut] };
    for (const { header, deps } of opened) {
      try {
        reading.projects.push({
          deps,
          snapshot: buildDashboardSnapshot(deps.db, deps.repoPath, now),
        });
      } catch (error) {
        reading.unreadable.push(`${header}  unreadable: ${failureSummary(error)}`);
      }
    }
    return reading;
  };
}
