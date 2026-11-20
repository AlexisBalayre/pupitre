export interface DiffFileStat {
  path: string;
  /** null for binary files (git reports `-`). */
  added: number | null;
  deleted: number | null;
}

/** What turned per-worktree config on: the file, the extension, or a value git cannot read. */
export type WorktreeConfigCause = 'file' | 'on' | 'unreadable';
