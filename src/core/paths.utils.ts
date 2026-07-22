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
  };
}
