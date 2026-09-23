import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { sanitizeReason } from '../adapters/capability.utils.js';
import { SESSION_ID_PATTERN } from './paths.constants.js';

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
  /** The operator's free-Markdown brief for this project (decision 57). */
  briefFile: string;
}

/**
 * Every per-session path is built from this, so no caller can compose a path
 * outside `sessionsDir` without passing `SESSION_ID_PATTERN` here. A throw, not
 * a fallback: a minted id always passes, so a failing one came out of a store
 * written by hand, and the callers that name one session have nothing to do
 * but refuse; the readers that sweep every row check first and skip
 * (decision 66). The id is sanitized into the message (decision 29).
 */
function sessionFragment(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      `Session id "${sanitizeReason(sessionId)}" is not a usable path fragment ` +
        '(letters, digits, underscore and hyphen, at most 64 characters).',
    );
  }
  return sessionId;
}

export function projectPaths(repoPath: string, base = join(homedir(), '.pupitre')): ProjectPaths {
  const root = join(base, projectId(repoPath));
  const sessionsDir = join(root, 'sessions');
  const sessionDir = (sessionId: string) => join(sessionsDir, sessionFragment(sessionId));
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
    briefFile: join(root, 'brief.md'),
  };
}
