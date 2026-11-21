export interface GateChildEnvOptions {
  /**
   * Per-run scratch, handed over as `TMPDIR`. Separate from the cache dir
   * because the two have different lifetimes: what a run leaves in `TMPDIR`
   * should go with the run, what a toolchain caches should survive it.
   */
  scratchDir: string;
  /** Stable cache root every redirected cache var is pointed at. */
  cacheDir: string;
  /**
   * Extra names the operator allowed with `--gate-env`, for a suite that
   * genuinely needs them. A flag and not an environment variable on purpose:
   * whoever controls pup's own environment — direnv's `.envrc`, a CI job, a
   * wrapper script — could otherwise widen this list without touching the
   * command the operator typed (decision 28, refined; decision 36).
   */
  passthrough?: string[];
  /**
   * Values pup itself computes for one child — `COVERAGE_FILE` aimed at a
   * capability's report directory. Not a second ambient channel: values are
   * built from pup's own run state, such as a temp directory it just created —
   * never copied from a name in pup's environment or read from a file a
   * session can write; anything of that kind stays behind the operator's
   * `--gate-env` flag. Names come from the closed `SETTABLE_VARS` list; an
   * unlisted one throws rather than being dropped, because the passthrough
   * names come from outside pup, where ignoring is the safe default, but a
   * pup-set name is written in pup's own source, so surfacing the bug at the
   * call site beats silently not setting it.
   */
  set?: Record<string, string>;
  /** Defaults to pup's own environment. */
  env?: NodeJS.ProcessEnv;
}
