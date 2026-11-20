/**
 * The CLI refuses with this message and exit 1, no stack: every case is the
 * operator's to resolve (cd into a repo, `pup init`, or `--project <id>`),
 * not a bug (decision 43).
 */
export class ProjectResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectResolutionError';
  }
}
