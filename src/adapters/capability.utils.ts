import type { CapabilityContext, CapabilityUnavailable } from './types/adapter.types.js';

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

/**
 * One-line reason from a failed shell-out, for a capability's `unavailable`
 * channel. Prefers stderr — a tool that dies says why there.
 */
export function failureSummary(error: unknown): string {
  const failure = error as { stderr?: string; stdout?: string; message?: string };
  return sanitizeReason(failure.stderr || failure.stdout || failure.message || 'command failed');
}
