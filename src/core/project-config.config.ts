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

const PROJECT_CONFIG_KEYS = [SKIP_UNTESTED_KEY, WORKER_SANDBOX_KEY];

/**
 * One boolean setting, or `fallback` when the repo has no `.pupitre/project.yml`
 * or the file leaves the key out. A malformed file throws: an unknown key or a
 * value that is not a boolean would otherwise leave the default in force
 * without anyone noticing.
 */
function projectSetting(repoPath: string, key: string, fallback: boolean): boolean {
  const configPath = join(repoPath, PROJECT_CONFIG_PATH);
  if (!existsSync(configPath)) return fallback;
  const raw = parse(readFileSync(configPath, 'utf8')) as unknown;
  if (raw === null) return fallback;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid ${PROJECT_CONFIG_PATH}: expected a mapping of settings.`);
  }
  const unknown = Object.keys(raw).filter((name) => !PROJECT_CONFIG_KEYS.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `Invalid ${PROJECT_CONFIG_PATH}: unknown key(s) ${unknown.join(', ')} (valid: ${PROJECT_CONFIG_KEYS.join(', ')}).`,
    );
  }
  const value = (raw as Record<string, unknown>)[key];
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
 * 191). No unless the project says so. On Linux it throws rather than launch:
 * the sandbox's grants of files that do not exist at launch were probed only
 * on macOS (ceiling 12).
 */
export function workerSandboxOn(repoPath: string): boolean {
  const on = projectSetting(repoPath, WORKER_SANDBOX_KEY, false);
  if (on && process.platform === 'linux') {
    throw new Error(
      `Invalid ${PROJECT_CONFIG_PATH}: ${WORKER_SANDBOX_KEY} is refused on Linux until the sandbox is probed there (decision 191).`,
    );
  }
  return on;
}
