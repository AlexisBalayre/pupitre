/** Changed-line count (adds + deletes, lockfiles excluded) above which the diff-size stage flags. */
export const DIFF_SIZE_FLAG_LINES = 600;

/** Excluded from the diff-size count — machine-generated churn, not review surface. */
export const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'uv.lock',
  'poetry.lock',
  'Cargo.lock',
];

/** Paths no session may touch regardless of scope (decision 6: gate is the backstop). */
export const PROTECTED_PATH_GLOBS = ['.claude/**'];

/** Serializes merges per repo (decision 8); lives in .git so it never lands in a diff. */
export const MERGE_LOCK_DIRNAME = 'pup-merge.lock';

export const GATE_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/** Tail of a failed command's output kept in the gate report / re-steer prompt. */
export const GATE_OUTPUT_TAIL_CHARS = 2000;

/** Gate failures beyond this park the session as blocked (decision 7). */
export const MAX_REJECTS_BEFORE_BLOCKED = 2;
