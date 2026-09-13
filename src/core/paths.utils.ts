import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * A stable project id from its repo path. Sessions and state for one repo live
 * under a single directory keyed by this id, so two clones at different paths
 * never share state.
 */
export function projectId(repoPath: string): string {
  return createHash('sha256').update(repoPath).digest('hex').slice(0, 12);
}

export interface ProjectPaths {
  root: string;
  dbFile: string;
  profilesDir: string;
  sessionsDir: string;
  sessionDir(sessionId: string): string;
  compiledDir(sessionId: string): string;
  eventsFile(sessionId: string): string;
  handoffFile(sessionId: string): string;
  /** The conductor's compiled profile — one per project, beside the sessions (decision 47). */
  conductorCompiledDir: string;
  /**
   * The conductor's private detached checkout of the merge target, and the only
   * thing its code graph is ever built from. Never the live main working tree:
   * that carries untracked files and a root `codegraph.json` a session can write
   * from its own worktree, either of which would steer or feed the
   * highest-privilege agent's graph (decision 51).
   */
  conductorCheckoutDir: string;
}

export function projectPaths(repoPath: string, base = join(homedir(), '.pupitre')): ProjectPaths {
  const root = join(base, projectId(repoPath));
  const sessionsDir = join(root, 'sessions');
  const sessionDir = (sessionId: string) => join(sessionsDir, sessionId);
  return {
    root,
    dbFile: join(root, 'state.db'),
    profilesDir: join(root, 'profiles'),
    sessionsDir,
    sessionDir,
    compiledDir: (sessionId) => join(sessionDir(sessionId), 'compiled'),
    eventsFile: (sessionId) => join(sessionDir(sessionId), 'events.jsonl'),
    handoffFile: (sessionId) => join(sessionDir(sessionId), 'handoff.md'),
    conductorCompiledDir: join(root, 'conductor', 'compiled'),
    conductorCheckoutDir: join(root, 'conductor', 'checkout'),
  };
}
