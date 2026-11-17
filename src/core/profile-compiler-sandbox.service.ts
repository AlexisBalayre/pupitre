import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { claudeUserDir } from '../claude/session-runtime.service.js';

/**
 * The one directory a sandboxed worker may bind and connect Unix sockets in:
 * where tsx 4 puts the IPC socket it opens on every run,
 * `<TMPDIR>/tsx-<euid>/<pid>.pipe` (decision 194). Claude Code 2.1.326 points
 * a Bash child's `TMPDIR` at `claude-<uid>` under `CLAUDE_CODE_TMPDIR`, resolved,
 * and under `/tmp` without the variable. A worker never has it: the launch
 * strips every `CLAUDE*` variable and `--session-env` cannot name it. So the
 * compile does not read its own, which Claude Code sets when pup runs from a
 * Claude Code Bash call.
 */
export function tsxSocketDir(): string {
  return join(
    realpathSync('/tmp'),
    `claude-${process.getuid?.() ?? 0}`,
    `tsx-${process.geteuid?.() ?? 0}`,
  );
}

/**
 * Allow-rule tools whose argument Claude Code 2.1.325 adds to the sandbox: an
 * `Edit(...)` path to the write list, a `WebFetch(domain:...)` host to the
 * network list. `Write(...)` goes with `Edit(...)`; WebFetch takes only the
 * `domain:` form, so its whole call form is refused (decision 191).
 */
const SANDBOX_WIDENING_TOOLS = new Set(['Edit', 'Write', 'WebFetch']);

/**
 * A worker loads the operator's user `settings.json` beside the compiled one
 * (`--setting-sources user`, decision 9), and Claude Code joins the sandbox's
 * lists from every source it loads: a `sandbox` key's own lists, its
 * `permissions.additionalDirectories` and the paths and domains of its
 * `Edit(...)` and `WebFetch(domain:...)` allow rules. No compiled value takes
 * an entry back, so the compile refuses a user file that holds any of them,
 * or one it cannot read and check (decision 191).
 */
export function refuseUserSandbox(repoPath: string): void {
  const settingsPath = join(claudeUserDir(repoPath), 'settings.json');
  if (!existsSync(settingsPath)) return;
  const invalid = (why: string) => new Error(`Invalid ${settingsPath}: ${why} (decision 191).`);
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    throw invalid(
      `workerSandbox needs to read it as JSON, to check it adds nothing to the worker's sandbox: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(settings)) throw invalid('workerSandbox needs it to hold a JSON object');
  if ('sandbox' in settings) {
    throw invalid(
      "its `sandbox` key is refused while workerSandbox is on, since Claude Code adds its lists to the worker's sandbox",
    );
  }
  const { permissions } = settings;
  if (permissions === undefined) return;
  if (!isObject(permissions)) {
    throw invalid('its `permissions` must be an object, for workerSandbox to check it');
  }
  if ('additionalDirectories' in permissions) {
    throw invalid(
      "its `permissions.additionalDirectories` is refused while workerSandbox is on, since Claude Code adds each directory to the worker's sandbox write list",
    );
  }
  const { allow } = permissions;
  if (allow === undefined) return;
  if (!Array.isArray(allow)) {
    throw invalid('its `permissions.allow` must be a list, for workerSandbox to check it');
  }
  for (const rule of allow) {
    if (typeof rule !== 'string') {
      throw invalid(
        `its \`permissions.allow\` holds ${JSON.stringify(rule)}, not a rule string, for workerSandbox to check`,
      );
    }
    const open = rule.indexOf('(');
    if (open !== -1 && SANDBOX_WIDENING_TOOLS.has(rule.slice(0, open).trim())) {
      throw invalid(
        `its \`permissions.allow\` rule ${JSON.stringify(rule)} is refused while workerSandbox is on, since Claude Code adds its path or domain to the worker's sandbox`,
      );
    }
  }
}
