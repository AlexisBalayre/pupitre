/**
 * Changed source lines (adds + deletes; lockfiles, test files and `docs/`
 * excluded) above which the diff-size stage flags (decision 107).
 */
export const DIFF_SIZE_FLAG_LINES = 600;

/**
 * The one test spelling the diff-size stage trusts: what a vitest `include`
 * conventionally collects, where parking production code fails the test stage
 * (decision 39). `*.spec.*`, `.test.mts`, `.test.tsx` and Python names are
 * collected by nothing pup can confirm, so they count as source (decision 107).
 */
export const DIFF_SIZE_TEST_SUFFIX = '.test.ts';

/** Counted apart from source in the diff-size stage: prose, not code to review for size. */
export const DIFF_SIZE_DOCS_DIR = 'docs/';

/**
 * Prose under `DIFF_SIZE_DOCS_DIR`. `.mdx` is left out because it compiles to
 * a component, and anything else under `docs/` may be running code (decision 107).
 */
export const DIFF_SIZE_DOCS_EXTENSIONS = ['.md', '.rst', '.txt', '.adoc'];

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

/** Per-file rise in decision points above which the complexity stage flags (docs/04 stage 4). */
export const COMPLEXITY_FILE_FLAG_DELTA = 15;

/** Findings/blocks quoted in a flagged debt stage's detail; the rest is elided. */
export const DEBT_DETAIL_SAMPLES = 3;

/** The untracked directory a Node stage resolves its packages from, per package directory (decision 81). */
export const GATE_ENVIRONMENT_DIR = 'node_modules';

/**
 * Identifies the rule `duplicatedLines` was counted under, so a baseline from
 * an older rule is skipped rather than compared (decision 39). Bump this
 * whenever what counts as duplication changes — dropping imports (decision 33)
 * would have needed it too, and leaving nested packages out (decision 58) did
 * (decision 59).
 */
export const DUPLICATION_RULE_ID = 'tests-excluded+nested-packages';

/** Slack under the baseline ratio before the coverage stage flags — float noise, not policy. */
export const COVERAGE_RATIO_EPSILON = 0.005;

/**
 * Paths no session may touch regardless of scope (decision 6: gate is the
 * backstop). `.pupitre/**` holds the adapter escape hatch (decision 24) — gate
 * config a session could otherwise weaken for every future merge.
 */
export const PROTECTED_PATH_GLOBS = ['.claude/**', '.pupitre/**'];

/** Serializes merges per repo (decision 8); lives in .git so it never lands in a diff. */
export const MERGE_LOCK_DIRNAME = 'pup-merge.lock';

export const GATE_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/** Tail of a failed command's output kept in the gate report / re-steer prompt. */
export const GATE_OUTPUT_TAIL_CHARS = 2000;

/** Gate failures beyond this park the session as blocked (decision 7). */
export const MAX_REJECTS_BEFORE_BLOCKED = 2;

/** PR titles built from a task goal are cut here — GitHub truncates around this anyway. */
export const PR_TITLE_MAX_CHARS = 72;

/** A sha as the gate pins it, which can then never read as an option. */
export const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
