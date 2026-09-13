import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  conductorName,
  hasConductorWindow,
  kickoff,
  killConductor,
  launchConductor,
} from '../claude/session-runtime.service.js';
import { codegraphBinary, prepareGraph } from './codegraph.client.js';
import { projectId, projectPaths } from './paths.utils.js';
import {
  compileConductorProfile,
  snapshotUserConfigHash,
  writeCompiledProfile,
} from './profile-compiler.service.js';
import type { ConductorHandle, StartConductorRequest } from './types/conductor.types.js';

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
 * Its code graph is the main checkout's, indexed here and served over MCP the
 * way a session's worktree graph is (decision 51): the conductor plans and
 * reviews from what has merged, so main's index is the right one for it, and
 * main is the only checkout it ever reads.
 */
export function startConductor(req: StartConductorRequest): ConductorHandle {
  const pid = projectId(req.repoPath);
  const name = conductorName(pid);
  const outDir = projectPaths(req.repoPath).conductorCompiledDir;
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
  });
  mkdirSync(outDir, { recursive: true });
  writeCompiledProfile(compiled, outDir);
  // Indexed before the launch, so the window opens on a graph that is already
  // there; a checkout that will not index costs the conductor its graph, never
  // its window.
  const indexed = prepareGraph(binary, req.repoPath, req.repoPath);
  const pane = launchConductor({
    projectId: pid,
    repoPath: req.repoPath,
    settingsPath: join(outDir, 'settings.json'),
    model: req.model,
    mcpConfigPath: indexed ? join(outDir, 'mcp.json') : undefined,
  });
  const delivered = kickoff(pane, compiled.contextMarkdown);
  return { name, paneId: pane.paneId, delivered };
}

export function stopConductor(repoPath: string): void {
  killConductor(projectId(repoPath));
}

export function isConductorRunning(repoPath: string): boolean {
  return hasConductorWindow(projectId(repoPath));
}
