import type { Database } from 'better-sqlite3';
import type { WindowEnv } from '../../claude/types/session-runtime.types.js';
import type { RouteOverride } from './session-lifecycle.types.js';

/**
 * What both respawns take: the session, the window env its command resolved
 * (decision 106), and the route override the operator named, if any.
 */
export type RespawnArgs = [
  db: Database,
  repoPath: string,
  sessionId: string,
  env: WindowEnv,
  pathsBase?: string,
  override?: RouteOverride,
];
