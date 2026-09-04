export class UnknownTaskError extends Error {
  constructor(taskId: string) {
    super(`No task ${taskId}. Run \`pup plan\` to see the backlog.`);
    this.name = 'UnknownTaskError';
  }
}

export class TaskAlreadyClaimedError extends Error {
  constructor(taskId: string, sessionId: string) {
    super(
      `Task ${taskId} is already claimed by session ${sessionId}. ` +
        'Kill that session first if you want to start over.',
    );
    this.name = 'TaskAlreadyClaimedError';
  }
}
