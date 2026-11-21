/** Two live sessions whose branch diffs touch at least one identical file. */
export interface OverlapPair {
  sessionA: string;
  sessionB: string;
  files: string[];
}

/**
 * A live session already scoped to files a task about to launch also claims.
 * The radar's after-the-fact sibling: same shared-file answer, asked of two
 * scopes before either has written anything (decision 41).
 */
export interface ScopeConflict {
  sessionId: string;
  files: string[];
}

/** Sessions appending to one decision file at once, which the radar names in a line. */
export interface AppendOnlyNote {
  file: string;
  sessions: number;
}
