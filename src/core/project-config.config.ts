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
 * Whether the gate may skip the test stage on a change of only untested paths
 * (decision 139). Yes when the repo has no `.pupitre/project.yml` or the file
 * leaves the key out. A malformed file throws: an unknown key or a value that
 * is not a boolean would otherwise leave the skip on without anyone noticing.
 */
export function skipsTestsOnUntestedChanges(repoPath: string): boolean {
  const configPath = join(repoPath, PROJECT_CONFIG_PATH);
  if (!existsSync(configPath)) return true;
  const raw = parse(readFileSync(configPath, 'utf8')) as unknown;
  if (raw === null) return true;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid ${PROJECT_CONFIG_PATH}: expected a mapping of settings.`);
  }
  const unknown = Object.keys(raw).filter((key) => key !== SKIP_UNTESTED_KEY);
  if (unknown.length > 0) {
    throw new Error(
      `Invalid ${PROJECT_CONFIG_PATH}: unknown key(s) ${unknown.join(', ')} (valid: ${SKIP_UNTESTED_KEY}).`,
    );
  }
  const value = (raw as Record<string, unknown>)[SKIP_UNTESTED_KEY];
  if (value === undefined) return true;
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid ${PROJECT_CONFIG_PATH}: ${SKIP_UNTESTED_KEY} must be true or false.`);
  }
  return value;
}
