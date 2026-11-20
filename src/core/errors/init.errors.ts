export class NoAdapterError extends Error {
  constructor(repoPath: string) {
    super(
      `No adapter detected for ${repoPath} (supported stacks: TypeScript, Python, or a .pupitre/adapter.yml).`,
    );
    this.name = 'NoAdapterError';
  }
}

/**
 * A stage died before measuring anything: the package manager it runs through
 * could not load from pup's toolchain cache. Stored, that FAIL becomes the bar
 * the next merge gates against (decision 55), so the capture stops instead.
 */
export class BrokenToolchainError extends Error {
  constructor(stage: string, installPath: string) {
    super(
      `${stage} could not load its package manager from the toolchain cache: ${installPath} is broken. ` +
        'No baseline stored — move that directory aside and re-run.',
    );
    this.name = 'BrokenToolchainError';
  }
}
