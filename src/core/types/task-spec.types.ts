/** What a task's scope-in names among the tracked files, as its kickoff lists them. */
export interface ScopeInFiles {
  /** Tracked files the task may edit, in `tracked`'s order. */
  files: string[];
  /** Scope-in globs that match no tracked path and name an editable one: files to create. */
  toCreate: string[];
}
