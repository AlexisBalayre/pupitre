export class CustomAdapterConfigError extends Error {
  constructor(detail: string) {
    super(`Invalid .pupitre/adapter.yml: ${detail}`);
    this.name = 'CustomAdapterConfigError';
  }
}

/** A configured capability command failed or emitted invalid JSON — loud, never a silent pass. */
export class CustomAdapterCommandError extends Error {
  constructor(capability: string, command: string, detail: string) {
    super(`Custom adapter ${capability} command (${command}) failed: ${detail}`);
    this.name = 'CustomAdapterCommandError';
  }
}
