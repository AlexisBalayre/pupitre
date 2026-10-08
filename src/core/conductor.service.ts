import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { failureSummary } from '../adapters/capability.utils.js';
import {
  conductorName,
  hasConductorWindow,
  kickoff,
  killConductor,
  launchConductor,
  launchWatcher,
} from '../claude/session-runtime.service.js';
import { codegraphBinary, prepareGraph } from './codegraph.client.js';
import { assertNoArmedGitDrivers, currentBranch, runGit } from './git-diff.client.js';
import { getWatcherBeat } from './overlap.repository.js';
import { WATCH_STALE_AFTER_MS } from './overlap.service.js';
import { projectId, projectPaths } from './paths.utils.js';
import {
  compileConductorProfile,
  snapshotUserConfigHash,
  writeCompiledProfile,
} from './profile-compiler.service.js';
import { isRefusedSteer, rollBackRefusedLaunch } from './session-lifecycle.errors.js';
import type { ConductorHandle, StartConductorRequest } from './types/conductor.types.js';

/**
 * The conductor's private detached checkout of the merge target — the only thing
 * its code graph is ever built from, and never the live main working tree (see
 * `refreshConductorCheckout`).
 *
 * Derived here rather than added to `projectPaths` beside `conductorCompiledDir`,
 * which is where the rest of the conductor's state layout lives: this module is
 * its only consumer, and `paths.utils.ts` is outside this task's scope. If a
 * second consumer ever appears, that is the moment to move it there.
 */
export function conductorCheckoutDir(repoPath: string): string {
  return join(projectPaths(repoPath).root, 'conductor', 'checkout');
}

/**
 * Create or refresh the conductor's own detached checkout of the merge target,
 * and answer its path. THIS is what its code graph is built from.
 *
 * Not the live main working tree, which was the first shape of this and was
 * wrong in a way that matters. A working tree is not "what has merged": it
 * carries untracked files, and a session's Bash is only guarded against
 * `.claude/`, so a session can write into the repo root from its own worktree.
 * Two consequences, both reached without any privilege the session did not
 * already have. A root `codegraph.json` steers the indexer — `{"include":
 * [".worktrees/**"]}` pulls every session's worktree into the conductor's graph,
 * and an `exclude` blinds it to whatever the session would rather it not see.
 * And an untracked source file is returned VERBATIM into the context of the one
 * agent that plans, launches and steers every other one. The conductor is the
 * highest-privilege reader in the system; its graph must not be writable by the
 * things it supervises.
 *
 * A detached checkout of the target branch is tracked content and nothing else,
 * which fixes both at the root rather than blacklisting the two known levers —
 * and it is also what keeps session worktrees out of the graph in a repo whose
 * `.gitignore` does not list `.worktrees/`. Detached on purpose: the branch
 * stays free for the main checkout and for `pup merge` to move.
 *
 * Refreshed at start and not after: the graph is a snapshot of the target as of
 * the moment the window opened, which the context section says in as many words.
 * `pup conductor stop` leaves it in place — it is a cache, and re-cutting it on
 * every start is the expensive half.
 */
function refreshConductorCheckout(repoPath: string, checkoutDir: string): string {
  // A checkout runs smudge filters, so it is exactly the operation decision 50's
  // guard exists for. Inside the caller's try: an armed driver costs the
  // conductor its graph, not its window.
  assertNoArmedGitDrivers(repoPath);
  // The branch the main checkout is on IS the merge target — the same rule
  // `runMergeGate` reads it by, so the conductor's graph and the gate's
  // destination can never disagree about which branch that is.
  const target = currentBranch(repoPath);
  if (!target) {
    throw new Error(`Main worktree at ${repoPath} is not on a branch; no merge target to index.`);
  }
  if (existsSync(join(checkoutDir, '.git'))) {
    // `refs/heads/`: a bare name resolves a same-named tag first (decision 80).
    runGit(checkoutDir, ['checkout', '--detach', `refs/heads/${target}`]);
  } else {
    // An operator who clears `~/.pupitre` leaves the registration behind, and
    // `worktree add` then refuses the path forever ("missing but already
    // registered") — the conductor would silently never get a graph again.
    // Prune drops only registrations whose directory is already gone, so it
    // heals that and touches nothing that still exists.
    runGit(repoPath, ['worktree', 'prune']);
    mkdirSync(dirname(checkoutDir), { recursive: true });
    runGit(repoPath, ['worktree', 'add', '--detach', checkoutDir, `refs/heads/${target}`]);
  }
  return checkoutDir;
}

/**
 * The conductor's graph, or undefined when it gets none. Cutting the checkout is
 * inside the same failure envelope as the index: either step failing costs the
 * graph and prints one line, never the window.
 */
function graphForConductor(
  binary: string | undefined,
  repoPath: string,
  checkoutDir: string,
  outDir: string,
): string | undefined {
  if (binary) {
    try {
      refreshConductorCheckout(repoPath, checkoutDir);
    } catch (error) {
      // Through `failureSummary` like every other shell-out (decision 29): git's
      // stderr on its way to the terminal an operator reads a decision from.
      console.error(
        `Could not refresh ${checkoutDir}: launching without a code graph. ${failureSummary(error)}`,
      );
      return undefined;
    }
  }
  // With no binary this is the one call that prints the "no codegraph" line.
  return prepareGraph(binary, repoPath, checkoutDir) ? join(outDir, 'mcp.json') : undefined;
}

/**
 * Compile the conductor's profile and open its window in the main checkout,
 * then type its context in as the opening prompt. One conductor per project:
 * a stale window wearing the name is replaced, as a session's would be. Not
 * a session — no task, worktree, branch or row — so nothing here touches the
 * store; the conductor's trace is the tasks it plans (`origin = conductor`)
 * and the events on the sessions it drives (decision 47). The window opens on
 * the conductor's own tmux socket, so the kickoff — the one thing that types
 * into it — goes to the pane the launch returned, on that same server.
 *
 * Its code graph is built from a PRIVATE detached checkout of the merge target,
 * never from the live main working tree (decision 51 — see
 * `refreshConductorCheckout`).
 *
 * A window that refuses or never takes its context is rolled back here rather
 * than by each front end, and answered for with one `LaunchRolledBackError`:
 * there is no half-started conductor to hand back, only a window to kill. A
 * start that succeeds brings the conflict radar up with it (`startRadarWith`)
 * and says in the handle whether it did.
 */
export function startConductor(req: StartConductorRequest): ConductorHandle {
  const pid = projectId(req.repoPath);
  const name = conductorName(pid);
  const outDir = projectPaths(req.repoPath).conductorCompiledDir;
  const checkoutDir = conductorCheckoutDir(req.repoPath);
  // Before the compile, because the answer shapes the compiled files and the
  // hash is recorded over them: which binary serves the graph is part of the
  // conductor's environment, not a runtime detail (decision 51).
  const binary = codegraphBinary(req.repoPath);
  const compiled = compileConductorProfile({
    base: req.base,
    repoPath: req.repoPath,
    projectId: pid,
    conductorName: name,
    workerModel: req.workerModel,
    userConfigHash: snapshotUserConfigHash(req.claudeUserDir),
    outDir,
    codegraphBinary: binary,
    checkoutPath: checkoutDir,
  });
  mkdirSync(outDir, { recursive: true });
  writeCompiledProfile(compiled, outDir);
  // Cut and indexed before the launch, so the window opens on a graph that is
  // already there.
  const mcpConfigPath = graphForConductor(binary, req.repoPath, checkoutDir, outDir);
  const pane = launchConductor({
    projectId: pid,
    repoPath: req.repoPath,
    settingsPath: join(outDir, 'settings.json'),
    model: req.model,
    mcpConfigPath,
  });
  let delivered: boolean;
  try {
    delivered = kickoff(pane, compiled.contextMarkdown);
  } catch (error) {
    if (!isRefusedSteer(error)) throw error;
    // Rolled back like a session launch whose kickoff never landed, so nothing
    // runs on an empty prompt; the window is the conductor's whole footprint,
    // so killing it is the whole rollback.
    throw rollBackRefusedLaunch(
      () => stopConductor(req.repoPath),
      'Conductor launch rolled back (window killed)',
      error,
    );
  }
  if (!delivered) {
    // A window with no context is a bypass-permissions agent in the main
    // checkout that has read none of its tier; killed, not left to inspect.
    // No refusal rides with this one: the window never said anything, and the
    // rollback line is the whole of what happened.
    throw rollBackRefusedLaunch(
      () => stopConductor(req.repoPath),
      `Conductor window ${name} never became ready, so its context was not delivered and ` +
        'the window was killed',
    );
  }
  return { name, paneId: pane.paneId, radarTarget: startRadarWith(req.db, pid, req.repoPath) };
}

/**
 * The conflict radar, started alongside the conductor unless one is already
 * sweeping, and named when this start brought it up.
 *
 * The radar is the turn watchdog's host, and the conductor is the thing the
 * watchdog exists to keep going: its own waiting turn dies with the worker's,
 * and then nobody resumes either (addendum to decision 35). So a conductor
 * without a radar is started with one, and the caller says so — the operator
 * asked for a fleet that runs itself, not for two commands. Whether one is up
 * is the store's word, not a window name a session could mint: a radar that
 * sweeps records its beat every sweep, and `launchWatcher` replaces whatever
 * stale window wears the name.
 */
function startRadarWith(db: Database, pid: string, repoPath: string): string | undefined {
  const beat = getWatcherBeat(db, pid);
  if (beat !== undefined && Date.now() - beat.getTime() <= WATCH_STALE_AFTER_MS) return undefined;
  return launchWatcher(pid, repoPath).target;
}

export function stopConductor(repoPath: string): void {
  killConductor(projectId(repoPath));
}

export function isConductorRunning(repoPath: string): boolean {
  return hasConductorWindow(projectId(repoPath));
}
