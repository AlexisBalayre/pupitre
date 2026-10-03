import type {
  Adapter,
  CoverageReport,
  DuplicationReport,
  FileComplexity,
} from '../../adapters/types/adapter.types.js';
import type { PatchCoverage } from './coverage.types.js';
import type { DebtBaseline } from './init.types.js';
import type { GateStageResult } from './merge-gate.types.js';

/** A capability an adapter declared and then could not run (decision 29). */
export interface DebtGap {
  adapterId: string;
  /** `'dead code'` or `'coverage'`; duplication and complexity have no unavailable arm. */
  capability: string;
  /** The adapter's own words, raw — every consumer sanitizes at its own edge. */
  reason: string;
}

/**
 * What the detected adapters measured, across all of them. Every debt number
 * pupitre stores or gates against comes through here, so `pup init`'s bar and
 * the merge gate's comparison cannot come to count different things — which is
 * exactly what they did while the gate measured one adapter and init measured
 * every one (decision 72, amending decision 22).
 */
export interface DebtMeasurement {
  /** The comparable bar: what `pup init` stores and a passing merge ratchets to. */
  debt: DebtBaseline;
  gaps: DebtGap[];
  /** Blocks behind `debt.duplicatedLines`; absent when no adapter declares duplication. */
  duplication?: DuplicationReport;
  /** The report behind `debt.coverageRatio`; absent when it was unavailable (see `gaps`). */
  coverage?: CoverageReport;
  /**
   * Which adapter produced `coverage` — the gate asks that same adapter which
   * changed files it expected to see in its own report, or a Python file would
   * count as missing from a TypeScript report. Absent when none declares it.
   */
  coverageAdapter?: Adapter;
}

/**
 * What the gate hands `judgeDebt`: `measureDebt` over the session's worktree,
 * plus the three things only the diff can supply.
 */
export interface GateDebtMeasurement extends DebtMeasurement {
  /** Complexity over the changed files, from the target branch and the worktree. */
  complexity?: { before: FileComplexity[]; after: FileComplexity[] };
  /** Changed files `coverageAdapter` expects to appear in its own report. */
  coverableFiles: string[];
  /** Patch coverage over the diff's added lines; absent when there is no report. */
  patch?: PatchCoverage;
  /**
   * Suffix naming what a nested package kept out of these numbers, said on
   * every stage the exclusion shapes so a pass reads as "measured without
   * these" rather than "nothing to measure" (decisions 29, 59).
   */
  nestedNote: string;
}

export interface DebtVerdict {
  /**
   * dead-code, duplication, complexity and coverage, in that order. A flagged
   * stage's detail is the bare summary: the caller appends the accept hint or
   * the accepted-as-debt reason, because only it knows whether this merge
   * carries `--accept-debt`.
   */
  stages: GateStageResult[];
  /** What a merge writes to the ledger, or refuses over — at most one per stage. */
  flags: DebtFlag[];
  /** The bar a passing merge ratchets to: only the metrics this run could compare. */
  ratchet: DebtBaseline;
}

export interface DebtFlag {
  description: string;
  files: string[];
}
