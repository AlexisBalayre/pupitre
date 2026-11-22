import type { ChildProcess } from 'node:child_process';
import type { InterruptSignal } from '../enums/interrupt-signal.enums.js';

export interface GateChildOptions {
  /** Working directory, and always writable: the checkout being measured. */
  cwd: string;
  /**
   * The trusted checkout (decision 29's `configPath`). Read-only to the child —
   * it is the key the toolchain cache is scoped by, nothing more. One repo's
   * gate must not hand the next repo its package manager, so this is required
   * rather than optional: every call site knows it, and a cache shared by
   * default is a cross-repo execution channel. `pup init`/`pup audit` pass the
   * same path as `cwd`, where the write grant is legitimate.
   */
  repoPath: string;
  /**
   * The checkout `cwd` must stay under once resolved; the child is refused
   * otherwise, in every mode (decision 180). The gate passes its checkout, so
   * a nested package's cwd an earlier child redirected through a link is not
   * granted the link's target.
   */
  root?: string;
  /** Further writable paths — a capability's report directory, which the child may remove. */
  writablePaths?: string[];
  /**
   * Extra env names the operator allowed with `--gate-env`. Never read from
   * pup's own environment: an ambient channel (direnv, a CI job, a wrapper
   * script) is the door that flag exists to close (decision 28, refined).
   */
  gateEnv?: string[];
  /**
   * Vars pup itself computes and sets for this child — `COVERAGE_FILE` aimed
   * at a capability's report directory. Values are built from pup's own run
   * state, such as a temp directory it just created — never copied from a
   * name in pup's environment or read from anything a session writes; ambient
   * values stay behind `gateEnv`'s operator flag, so decision 36's one seam
   * keeps its one answer. Names come from gate-env.utils' closed
   * `SETTABLE_VARS` list; any other name throws — see there for why the
   * namespace cannot be denylisted.
   */
  env?: Record<string, string>;
  timeout?: number;
  maxBuffer?: number;
  /** Fed to the child's stdin; absent means stdin is closed. */
  input?: string;
}

export interface LiveChild {
  child: ChildProcess;
  /** Set when pup forwarded an interrupt to it, so its exit is not read as a stage result. */
  interruptedBy?: InterruptSignal;
  /** Kills the group once the grace after the first interrupt runs out. */
  killTimer?: NodeJS.Timeout;
}

export interface SandboxRun {
  /** The child's TMPDIR, and everything a run leaves behind. Per run. */
  scratchDir: string;
  /**
   * Holds the generated profiles, each child's in a directory of its own that
   * its profile denies; no grant reaches the rest, so no child writes any.
   */
  policyDir: string;
}
