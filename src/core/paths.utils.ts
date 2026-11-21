import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { sanitizeReason } from '../adapters/capability.utils.js';
import { SESSION_ID_PATTERN } from './constants/paths.constants.js';
import type { ProjectPaths } from './types/paths.types.js';

/**
 * A stable project id from its repo path. Sessions and state for one repo live
 * under a single directory keyed by this id, so two clones at different paths
 * never share state.
 */
export function projectId(repoPath: string): string {
  return createHash('sha256').update(repoPath).digest('hex').slice(0, 12);
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

/**
 * Write a file pup owns under the store. A session can write there too, so
 * whatever stands at `path` may be a link it planted (decision 194). The
 * content goes to a fresh, randomly named file beside `path`, created with
 * O_EXCL | O_NOFOLLOW so nothing planted there is written through, then synced
 * and renamed over `path`. The rename replaces a link without following it, and
 * a reader sees the old file or the new one, never half of one. A directory at
 * `path` fails the rename, and the temp file is removed. `mode`, when given, is
 * set on the descriptor, exact whatever the umask.
 */
export function writeStoreFile(path: string, content: string, mode?: number): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const fd = openSync(temp, flags, mode ?? 0o666);
  try {
    try {
      if (mode !== undefined) fchmodSync(fd, mode);
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
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
    usageFile: join(root, 'usage.json'),
  };
}
