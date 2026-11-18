import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * The project's own settings, read from the trusted main checkout. It sits
 * under `.pupitre/`, a protected path (`PROTECTED_PATH_GLOBS`), so no session
 * can change the settings its own gate reads.
 */
const PROJECT_CONFIG_PATH = '.pupitre/project.yml';

/**
 * The key that turns the decision 139 skip off: `false` runs the test stage on
 * every change, for a repo whose tests read a file `UNTESTED_PATH_GLOBS` lists.
 */
const SKIP_UNTESTED_KEY = 'skipTestsOnUntestedChanges';

/**
 * The key that runs every worker's Bash calls inside Claude Code's sandbox
 * (decision 191): `true` turns it on, from the next launch.
 */
const WORKER_SANDBOX_KEY = 'workerSandbox';

/**
 * The key that sets how many minutes of merge-lock work the live sessions may
 * have ahead of them before a launch is refused (decision 197).
 */
const LOCK_BACKLOG_BUDGET_KEY = 'lockBacklogBudgetMinutes';

/** The merge-lock backlog a launch is held under when the project sets none (decision 197). */
const DEFAULT_LOCK_BACKLOG_BUDGET_MINUTES = 60;

/** The largest budget a project may set: a day of lock work, past which the backlog holds nothing back. */
const MAX_LOCK_BACKLOG_BUDGET_MINUTES = 1440;

/**
 * The key that sets the `autoCompactWindow` pup compiles into every worker's
 * and the conductor's settings (decision 200), so no session runs on whatever
 * window the operator's own settings name.
 */
const AUTO_COMPACT_WINDOW_KEY = 'autoCompactWindow';

/** The window a session compacts in when the project sets none: the 2026-11-16 study's choice (decision 200). */
const DEFAULT_AUTO_COMPACT_WINDOW_TOKENS = 150_000;

/** The smallest window Claude Code accepts. */
const MIN_AUTO_COMPACT_WINDOW_TOKENS = 100_000;

/** The largest context window a model has: a window past it would never compact. */
const MAX_AUTO_COMPACT_WINDOW_TOKENS = 1_000_000;

const PROJECT_CONFIG_KEYS = [
  SKIP_UNTESTED_KEY,
  WORKER_SANDBOX_KEY,
  LOCK_BACKLOG_BUDGET_KEY,
  AUTO_COMPACT_WINDOW_KEY,
];

/**
 * One setting's raw value, undefined when the repo has no `.pupitre/project.yml`
 * or the file leaves the key out. A malformed file throws: an unknown key would
 * otherwise leave the default in force without anyone noticing.
 */
function projectValue(repoPath: string, key: string): unknown {
  const configPath = join(repoPath, PROJECT_CONFIG_PATH);
  if (!existsSync(configPath)) return undefined;
  const raw = parse(readFileSync(configPath, 'utf8')) as unknown;
  if (raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid ${PROJECT_CONFIG_PATH}: expected a mapping of settings.`);
  }
  const unknown = Object.keys(raw).filter((name) => !PROJECT_CONFIG_KEYS.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `Invalid ${PROJECT_CONFIG_PATH}: unknown key(s) ${unknown.join(', ')} (valid: ${PROJECT_CONFIG_KEYS.join(', ')}).`,
    );
  }
  return (raw as Record<string, unknown>)[key];
}

/**
 * One boolean setting, or `fallback` when the project gives none. A value that
 * is not a boolean throws rather than leave the default in force.
 */
function projectSetting(repoPath: string, key: string, fallback: boolean): boolean {
  const value = projectValue(repoPath, key);
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid ${PROJECT_CONFIG_PATH}: ${key} must be true or false.`);
  }
  return value;
}

/**
 * Whether the gate may skip the test stage on a change of only untested paths
 * (decision 139). Yes unless the project says otherwise.
 */
export function skipsTestsOnUntestedChanges(repoPath: string): boolean {
  return projectSetting(repoPath, SKIP_UNTESTED_KEY, true);
}

/**
 * Whether a worker's compiled settings switch on the Bash sandbox (decision
 * 191). No unless the project says so. Anywhere but macOS it throws rather
 * than launch: the sandbox was probed only there, and its grants of files that
 * do not exist at launch may not hold elsewhere (ceiling 12).
 */
export function workerSandboxOn(repoPath: string): boolean {
  const on = projectSetting(repoPath, WORKER_SANDBOX_KEY, false);
  if (on && process.platform !== 'darwin') {
    throw new Error(
      `Invalid ${PROJECT_CONFIG_PATH}: ${WORKER_SANDBOX_KEY} is refused outside macOS until the sandbox is probed there (decision 191).`,
    );
  }
  return on;
}

/**
 * The minutes of merge-lock work past which `pup launch` and `pup new` refuse
 * (decision 197): the project's `lockBacklogBudgetMinutes`, else
 * `DEFAULT_LOCK_BACKLOG_BUDGET_MINUTES`. A value that is not a number above 0
 * and at most `MAX_LOCK_BACKLOG_BUDGET_MINUTES` throws rather than leave the
 * default in force.
 */
export function lockBacklogBudgetMinutes(repoPath: string): number {
  const value = projectValue(repoPath, LOCK_BACKLOG_BUDGET_KEY);
  if (value === undefined) return DEFAULT_LOCK_BACKLOG_BUDGET_MINUTES;
  if (typeof value !== 'number' || !(value > 0 && value <= MAX_LOCK_BACKLOG_BUDGET_MINUTES)) {
    throw new Error(
      `Invalid ${PROJECT_CONFIG_PATH}: ${LOCK_BACKLOG_BUDGET_KEY} must be a number of minutes above 0 and at most ${MAX_LOCK_BACKLOG_BUDGET_MINUTES}.`,
    );
  }
  return value;
}

/**
 * The `autoCompactWindow` every session is compiled with (decision 200): the
 * project's own, else `DEFAULT_AUTO_COMPACT_WINDOW_TOKENS`. A value that is not
 * a whole number of tokens from `MIN_AUTO_COMPACT_WINDOW_TOKENS` to
 * `MAX_AUTO_COMPACT_WINDOW_TOKENS` throws rather than leave the default in force.
 */
export function autoCompactWindowTokens(repoPath: string): number {
  const value = projectValue(repoPath, AUTO_COMPACT_WINDOW_KEY);
  if (value === undefined) return DEFAULT_AUTO_COMPACT_WINDOW_TOKENS;
  if (
    !Number.isInteger(value) ||
    (value as number) < MIN_AUTO_COMPACT_WINDOW_TOKENS ||
    (value as number) > MAX_AUTO_COMPACT_WINDOW_TOKENS
  ) {
    throw new Error(
      `Invalid ${PROJECT_CONFIG_PATH}: ${AUTO_COMPACT_WINDOW_KEY} must be a whole number of tokens from ${MIN_AUTO_COMPACT_WINDOW_TOKENS} to ${MAX_AUTO_COMPACT_WINDOW_TOKENS}.`,
    );
  }
  return value as number;
}
