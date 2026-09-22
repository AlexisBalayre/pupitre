import type { Database } from 'better-sqlite3';
import { sanitizeReason } from '../adapters/capability.utils.js';
import { conductorName } from '../claude/session-runtime.service.js';
import { isConductorRunning } from './conductor.service.js';
import { projectId } from './paths.utils.js';
import { getProject, listSessions, saveProjectDormantAt } from './session.repository.js';
import { holdingStates } from './session-state.utils.js';

/**
 * What `pup project dormant|wake` answers: a line for stdout, or the refusal
 * the CLI prints on stderr with exit 1. Nothing is written on a refusal.
 */
type DormancyOutcome = { said: string } | { refusal: string };

/**
 * The registered projects `pup project list` prints, each with whether its
 * conductor runs, or the refusal when there is nothing to print: an empty
 * registry, or a `--project` id nobody registered. `selected` narrows the
 * listing to that one id.
 */
export function listProjects<TProject extends { id: string; repoPath: string }>(
  registered: TProject[],
  selected: string | undefined,
): { refusal: string } | { projects: { project: TProject; isConductorRunning: boolean }[] } {
  const listed = registered.filter(
    (candidate) => selected === undefined || candidate.id === selected,
  );
  if (listed.length === 0) {
    return {
      refusal:
        selected === undefined
          ? 'No project registered; run pup init from the repo you want to control.'
          : `No project ${sanitizeReason(selected)}; \`pup project list\` shows the registered ones.`,
    };
  }
  return {
    projects: listed.map((project) => ({
      project,
      isConductorRunning: isConductorRunning(project.repoPath),
    })),
  };
}

/** The refusal for a repo whose store holds no `projects` row: never `pup init`ed. */
function unregistered(repoPath: string): DormancyOutcome {
  return {
    refusal: `No project at ${sanitizeReason(repoPath)}; run pup init from the repo you want to control.`,
  };
}

/**
 * Put the project in `repoPath` to sleep: the fleet views and the radar pass it
 * over until it is woken (decision 62). Refused while its conductor or any
 * session that holds files is live.
 */
export function putProjectToSleep(db: Database, repoPath: string, now: Date): DormancyOutcome {
  const pid = projectId(repoPath);
  const row = getProject(db, pid);
  if (!row) return unregistered(repoPath);
  if (row.dormant_at !== null) {
    return {
      said: `Project ${pid} is already dormant since ${sanitizeReason(String(row.dormant_at))}.`,
    };
  }
  // Named, not counted, like the brief's list of what runs on the old brief:
  // each one is something the operator stops by name first. A project put to
  // sleep with work in flight would hide that work from every view that would
  // have shown it needing the operator.
  const live = [
    ...(isConductorRunning(repoPath) ? [conductorName(pid)] : []),
    ...listSessions(db, holdingStates()).map((session) => sanitizeReason(session.id)),
  ];
  if (live.length > 0) {
    return {
      refusal: `Project ${pid} still has ${live.join(', ')} live; stop ${live.length === 1 ? 'it' : 'them'} (pup conductor stop, pup kill <session>, or merge) before putting it to sleep.`,
    };
  }
  saveProjectDormantAt(db, pid, now.toISOString());
  return {
    said: `Project ${pid} is dormant: pup status, pup ui and the radar pass it over until \`pup project wake ${pid}\`.`,
  };
}

/** Wake the project in `repoPath`: the fleet views and the radar read it again. */
export function wakeProject(db: Database, repoPath: string): DormancyOutcome {
  const pid = projectId(repoPath);
  const row = getProject(db, pid);
  if (!row) return unregistered(repoPath);
  if (row.dormant_at === null) return { said: `Project ${pid} is already active.` };
  saveProjectDormantAt(db, pid, null);
  return { said: `Project ${pid} is awake: the fleet views and the radar read it again.` };
}
