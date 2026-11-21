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
  /** The plan's latest usage reading, which every window's status line writes (decision 156). */
  usageFile: string;
}
