import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import type { CapabilityContext, CapabilityUnavailable } from './types/adapter.types.js';

/** Larger than any manifest, config or record pup reads this way. */
const PLAIN_FILE_MAX_BYTES = 1 << 20;

/**
 * A file that code pup does not trust may have replaced: a config in the
 * measured checkout, a slot or the session cap under the store (decision 96).
 * Opening a fifo or a device would block the event loop, and timeouts and
 * interrupt forwarding with it, so only a regular file is read, checked on the
 * descriptor opened without blocking. Throws otherwise.
 */
export function readPlainFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > PLAIN_FILE_MAX_BYTES) {
      throw new Error(`${path} is not a plain file`);
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Narrows a capability result to its "no measurement" arm. Deliberately a
 * shape check on untrusted input, not a trust control: a custom adapter's
 * capability is arbitrary parsed JSON, so this must survive `null`, primitives
 * and arrays rather than assume an object (decision 29).
 */
export function isUnavailable(result: unknown): result is CapabilityUnavailable {
  return (
    typeof result === 'object' &&
    result !== null &&
    !Array.isArray(result) &&
    typeof (result as CapabilityUnavailable).unavailable === 'string'
  );
}

/** The single-checkout context `pup init` and the code map work with. */
export function localContext(repoPath: string, gateEnv?: string[]): CapabilityContext {
  return { measurePath: repoPath, configPath: repoPath, ...(gateEnv?.length ? { gateEnv } : {}) };
}

/** Long enough to carry a stack trace's first line, short enough for one report row. */
const FAILURE_SUMMARY_CHARS = 300;

/**
 * Make a capability's reason safe to print and to embed. The text originates in
 * a session's worktree — a failing test's stderr, a custom adapter's JSON — and
 * ends up on the operator's terminal, inside the PR body's fenced gate report,
 * and in stored events. So: control characters go (ANSI cursor moves could
 * repaint a FLAGGED row as PASS on the one screen the operator decides from),
 * whitespace collapses to keep the report one row per stage and to stop a
 * closing fence from breaking out, and the cap counts code points so it cannot
 * sever a surrogate pair (decision 29).
 */
export function sanitizeReason(reason: string): string {
  const oneLine = reason
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...oneLine].slice(0, FAILURE_SUMMARY_CHARS).join('');
}

/** A stage's wall time as the gate, init and audit reports print it (decision 95). */
export function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * One-line reason from a failed shell-out, for a capability's `unavailable`
 * channel. Prefers stderr — a tool that dies says why there.
 */
export function failureSummary(error: unknown): string {
  const failure = error as { stderr?: string; stdout?: string; message?: string };
  return sanitizeReason(failure.stderr || failure.stdout || failure.message || 'command failed');
}

/**
 * Node's crash when the file it was told to run is missing: the module named in
 * the banner, with an empty require stack — nothing required it, it was the
 * entrypoint.
 */
const ENTRYPOINT_NOT_FOUND =
  /Cannot find module '([^'\n]+)'[\s\S]*code: 'MODULE_NOT_FOUND'[\s\S]*requireStack: \[\]/;

/** `<COREPACK_HOME>/v1/<manager>/<version>`, the directory corepack runs a package manager from. */
const COREPACK_INSTALL = /^(.*\/corepack\/v1\/[^/]+\/[^/]+)\//;

/**
 * The corepack install directory, when a stage's output says the package
 * manager itself failed to load rather than anything the checkout did — a
 * poisoned toolchain cache, not a measurement. Only the entrypoint counts: a
 * `MODULE_NOT_FOUND` raised by the project's own code has a require stack, and
 * one for a path outside corepack's install tree is the project's to answer.
 */
export function brokenPackageManagerInstall(output: string): string | undefined {
  const missing = ENTRYPOINT_NOT_FOUND.exec(output)?.[1];
  return missing ? COREPACK_INSTALL.exec(missing)?.[1] : undefined;
}
