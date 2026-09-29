import { isUnavailable, sanitizeReason } from '../adapters/capability.utils.js';
import type {
  Adapter,
  CapabilityContext,
  CoverageReport,
  DeadExport,
  DuplicationReport,
  FileComplexity,
} from '../adapters/types/adapter.types.js';
import { repoCoverageRatio } from './coverage.utils.js';
import {
  COMPLEXITY_FILE_FLAG_DELTA,
  COVERAGE_RATIO_EPSILON,
  DEBT_DETAIL_SAMPLES,
  DUPLICATION_RULE_ID,
} from './merge-gate.constants.js';
import type { PatchCoverage } from './types/coverage.types.js';
import type { DebtBaseline } from './types/init.types.js';
import type { GateStageResult } from './types/merge-gate.types.js';

/**
 * A repo path on its way into a stage detail. Paths come from `git diff -z`
 * precisely so they stay raw bytes, and a detail is printed to the operator's
 * terminal, fenced into the PR body, and fed back to the session as a re-steer
 * prompt — so a filename carrying ANSI escapes could repaint the report the
 * operator decides from (the decision-29 rationale, applied to paths).
 */
export function quotePath(path: string): string {
  return sanitizeReason(path);
}

/** Capability names as `pup init`'s findings and this module's gaps call them. */
const DEAD_CODE = 'dead code';
const COVERAGE = 'coverage';

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
 * Run every debt capability the detected adapters declare, over one checkout.
 * Counts sum across adapters rather than stopping at the first: a
 * TypeScript+Python repo has debt in both languages, and a bar counted over
 * one of them is not the repo's bar (decision 72).
 *
 * Coverage is the exception — one ratio per repo, from the first adapter that
 * can produce one, exactly as `pup init` has always taken it. Two runners'
 * ratios are not one number, and the gate's patch-coverage bar has to come
 * from the same report `coverableFiles` is answered against.
 */
export function measureDebt(adapters: Adapter[], ctx: CapabilityContext): DebtMeasurement {
  const debt: DebtBaseline = {};
  const gaps: DebtGap[] = [];

  const deadExports: DeadExport[][] = [];
  for (const adapter of adapters) {
    const result = adapter.deadCode?.(ctx);
    if (result === undefined) continue;
    if (isUnavailable(result)) {
      gaps.push({ adapterId: adapter.id, capability: DEAD_CODE, reason: result.unavailable });
    } else {
      deadExports.push(result);
    }
  }
  // Counting adapters that measured, not findings: an unavailable capability
  // must leave the bar unset (a baseline of [] would read as "0 dead exports"
  // and flag every later finding), while one that found nothing still stores [].
  if (deadExports.length > 0) debt.deadExports = deadExports.flat();

  const duplicationReports = adapters
    .map((a) => a.duplication?.(ctx))
    .filter((r): r is DuplicationReport => r !== undefined);
  let duplication: DuplicationReport | undefined;
  if (duplicationReports.length > 0) {
    duplication = mergeDuplication(duplicationReports);
    debt.duplicatedLines = duplication.duplicatedLines;
    // Stamped with the number so the gate can tell a comparable bar from one
    // counted under an older rule (decision 39).
    debt.duplicationRule = DUPLICATION_RULE_ID;
  }

  const coverageAdapter = adapters.find((a) => a.coverage);
  let coverage: CoverageReport | undefined;
  if (coverageAdapter) {
    const result = coverageAdapter.coverage?.(ctx);
    if (isUnavailable(result)) {
      gaps.push({
        adapterId: coverageAdapter.id,
        capability: COVERAGE,
        reason: result.unavailable,
      });
    } else {
      coverage = result;
    }
    const ratio = coverage ? repoCoverageRatio(coverage) : undefined;
    if (ratio !== undefined) debt.coverageRatio = ratio;
  }

  return {
    debt,
    gaps,
    ...(duplication ? { duplication } : {}),
    ...(coverage ? { coverage } : {}),
    ...(coverageAdapter ? { coverageAdapter } : {}),
  };
}

/**
 * One duplication number for the repo: each adapter counts its own language's
 * files, so the totals add and the blocks concatenate. `excludedTestBlocks`
 * stays absent unless at least one adapter reported it — a custom adapter that
 * self-reports may not know the rule, and the gate must then fall silent about
 * fixtures rather than claim it counted none.
 */
function mergeDuplication(reports: DuplicationReport[]): DuplicationReport {
  const excluded = reports
    .map((r) => r.excludedTestBlocks)
    .filter((n): n is number => n !== undefined);
  return {
    duplicatedLines: reports.reduce((sum, r) => sum + r.duplicatedLines, 0),
    blocks: reports.flatMap((r) => r.blocks),
    ...(excluded.length > 0 ? { excludedTestBlocks: excluded.reduce((sum, n) => sum + n, 0) } : {}),
  };
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

/** One stage's verdict; `ratchet` carries only the metrics that stage owns. */
interface StageVerdict {
  stage: GateStageResult;
  flag?: DebtFlag;
  ratchet?: DebtBaseline;
}

/**
 * The debt half of the gate's verdict: four stages, their flags, and the bar a
 * passing merge leaves behind. Pure, so the comparison rules the whole ratchet
 * rests on are table-testable without a git repo, a store or a real adapter —
 * `gateAndMerge` keeps the I/O and decides where these stages sit in the run.
 */
export function judgeDebt(
  measured: GateDebtMeasurement,
  baseline: DebtBaseline | undefined,
  changedPaths: string[],
  sessionId: string,
): DebtVerdict {
  const verdicts = [
    judgeDeadCode(measured, baseline, sessionId),
    judgeDuplication(measured, baseline, changedPaths, sessionId),
    judgeComplexity(measured, sessionId),
    judgeCoverage(measured, baseline, sessionId),
  ];
  return {
    stages: verdicts.map((v) => v.stage),
    flags: verdicts.flatMap((v) => (v.flag ? [v.flag] : [])),
    ratchet: Object.assign({}, ...verdicts.map((v) => v.ratchet)) as DebtBaseline,
  };
}

/** Appends the nested-package note to a detail that exclusion shapes. */
function withNote(measured: GateDebtMeasurement, detail: string): string {
  return `${detail}${measured.nestedNote}`;
}

/**
 * Why a capability produced nothing. The adapter is named only when more than
 * one could have answered, so a single-adapter repo's report reads exactly as
 * it did before decision 72.
 */
function gapReasons(gaps: DebtGap[]): string {
  const only = gaps.length === 1 ? gaps[0] : undefined;
  return only
    ? sanitizeReason(only.reason)
    : gaps.map((g) => `${sanitizeReason(g.adapterId)}: ${sanitizeReason(g.reason)}`).join('; ');
}

/** The same gaps as an aside on a stage the other adapters did measure. */
function gapAside(gaps: DebtGap[]): string {
  return gaps.length === 0
    ? ''
    : `; ${gaps
        .map((g) => `${sanitizeReason(g.adapterId)} not measured — ${sanitizeReason(g.reason)}`)
        .join('; ')}`;
}

/** `a, b, c, …` — the first few of a list, the rest elided. */
function samples(items: string[]): string {
  return `${items.slice(0, DEBT_DETAIL_SAMPLES).join(', ')}${
    items.length > DEBT_DETAIL_SAMPLES ? ', …' : ''
  }`;
}

function judgeDeadCode(
  measured: GateDebtMeasurement,
  baseline: DebtBaseline | undefined,
  sessionId: string,
): StageVerdict {
  const stage = 'dead-code';
  const gaps = measured.gaps.filter((g) => g.capability === DEAD_CODE);
  const found = measured.debt.deadExports;
  if (found === undefined) {
    const detail =
      gaps.length === 0
        ? 'not measured — adapter cannot detect dead code'
        : withNote(measured, `not measured — ${gapReasons(gaps)}`);
    return { stage: { stage, status: 'skipped', detail } };
  }
  // A count missing one adapter's findings still compares soundly — it can only
  // fail to flag — but it must not become the bar: ratcheting it would write
  // that adapter's known dead exports out, and the next merge would see them
  // as fresh.
  const ratchet = gaps.length === 0 ? { deadExports: found } : undefined;
  const known = baseline?.deadExports;
  if (!known) {
    return {
      stage: {
        stage,
        status: 'skipped',
        detail: withNote(measured, 'not measured — no debt baseline; run `pup init`'),
      },
      ...(ratchet ? { ratchet } : {}),
    };
  }
  const knownKeys = new Set(known.map((d) => `${d.file}\u0000${d.exportName}`));
  const fresh = found.filter((d) => !knownKeys.has(`${d.file}\u0000${d.exportName}`));
  if (fresh.length === 0) {
    return {
      stage: {
        stage,
        status: 'pass',
        detail: withNote(measured, `no new unused exports${gapAside(gaps)}`),
      },
      ...(ratchet ? { ratchet } : {}),
    };
  }
  const quoted = samples(fresh.map((d) => `${quotePath(d.file)}#${d.exportName}`));
  return {
    stage: {
      stage,
      status: 'flagged',
      detail: withNote(
        measured,
        `${fresh.length} new unused export(s): ${quoted}${gapAside(gaps)}`,
      ),
    },
    flag: {
      description: `New unused exports (${fresh.length}) merged from session ${sessionId}`,
      // Sorted so a retry produces the same list, and with it the same ledger
      // dedupe key, whatever order the tool reported findings in.
      files: [...new Set(fresh.map((d) => d.file))].sort(),
    },
    ...(ratchet ? { ratchet } : {}),
  };
}

function judgeDuplication(
  measured: GateDebtMeasurement,
  baseline: DebtBaseline | undefined,
  changedPaths: string[],
  sessionId: string,
): StageVerdict {
  const stage = 'duplication';
  const duplication = measured.duplication;
  if (!duplication) {
    return {
      stage: {
        stage,
        status: 'skipped',
        detail: 'not measured — adapter cannot detect duplication',
      },
    };
  }
  // A number counted under an older rule is not a bar, it is a different
  // measurement — comparing across the two passes on the difference. So a
  // mismatch skips the stage, and must not move the bar either: this number
  // was never compared to anything, and re-stamping it here would let one
  // merge write an arbitrary floor that every later merge gates against and
  // `pup audit` then confirms. Only `pup audit`, on the trusted checkout,
  // re-stamps an existing baseline (decisions 30, 39).
  const comparableRule = baseline?.duplicationRule === DUPLICATION_RULE_ID;
  const ratchet =
    comparableRule || baseline?.duplicatedLines === undefined
      ? { duplicatedLines: duplication.duplicatedLines, duplicationRule: DUPLICATION_RULE_ID }
      : undefined;
  const knownLines = comparableRule ? baseline?.duplicatedLines : undefined;
  // Say what was left out, so a number that fell has a visible reason and a
  // pile of copy-pasted fixtures is not silently invisible (decisions 29, 39).
  // Re-checked as a finite number here as well as at the custom adapter's
  // boundary: this string reaches the terminal, the fenced PR body and the
  // re-steer prompt, and an adapter is not the only possible producer.
  const excludedBlocks = duplication.excludedTestBlocks;
  const fixtureNote =
    typeof excludedBlocks === 'number' && Number.isFinite(excludedBlocks) && excludedBlocks > 0
      ? `; ${Math.trunc(excludedBlocks)} test-fixture block(s) not counted`
      : '';
  if (knownLines === undefined) {
    return {
      stage: {
        stage,
        status: 'skipped',
        detail: withNote(
          measured,
          baseline?.duplicatedLines === undefined
            ? 'not measured — no debt baseline; run `pup init`'
            : 'not measured — the stored baseline counts duplication a different way; run `pup audit`',
        ),
      },
      ...(ratchet ? { ratchet } : {}),
    };
  }
  if (duplication.duplicatedLines <= knownLines) {
    return {
      stage: {
        stage,
        status: 'pass',
        detail: withNote(
          measured,
          `${duplication.duplicatedLines} duplicated lines (baseline ${knownLines})${fixtureNote}`,
        ),
      },
      ...(ratchet ? { ratchet } : {}),
    };
  }
  const changedSet = new Set(changedPaths);
  const touchedBlocks = duplication.blocks.filter((b) =>
    b.locations.some((l) => changedSet.has(l.file)),
  );
  // Joined with `;` and never elided, unlike the other stages' samples: each
  // entry is already a `a ≈ b` pair, and a comma between them would read as a
  // third location.
  const quoted = (touchedBlocks.length > 0 ? touchedBlocks : duplication.blocks)
    .slice(0, DEBT_DETAIL_SAMPLES)
    .map((b) =>
      b.locations
        .slice(0, 2)
        .map((l) => `${quotePath(l.file)}:${l.line}`)
        .join(' ≈ '),
    )
    .join('; ');
  const files = [
    ...new Set(
      touchedBlocks.flatMap((b) => b.locations.map((l) => l.file)).filter((f) => changedSet.has(f)),
    ),
  ].sort();
  return {
    stage: {
      stage,
      status: 'flagged',
      detail: withNote(
        measured,
        `duplicated lines rose from ${knownLines} to ${duplication.duplicatedLines} (e.g. ${quoted})${fixtureNote}`,
      ),
    },
    flag: {
      description: `Duplicated lines rose from ${knownLines} to ${duplication.duplicatedLines} in session ${sessionId}`,
      files: files.length > 0 ? files : changedPaths,
    },
    ...(ratchet ? { ratchet } : {}),
  };
}

function judgeComplexity(measured: GateDebtMeasurement, sessionId: string): StageVerdict {
  const stage = 'complexity';
  if (!measured.complexity) {
    return {
      stage: {
        stage,
        status: 'skipped',
        detail: 'not measured — adapter cannot measure complexity',
      },
    };
  }
  const before = new Map(measured.complexity.before.map((f) => [f.file, f.complexity]));
  const risen = measured.complexity.after
    .map((f) => ({ ...f, delta: f.complexity - (before.get(f.file) ?? 0) }))
    .filter((f) => f.delta > COMPLEXITY_FILE_FLAG_DELTA);
  if (risen.length === 0) {
    return {
      stage: {
        stage,
        status: 'pass',
        detail: `no touched file rose by more than ${COMPLEXITY_FILE_FLAG_DELTA} decision points`,
      },
    };
  }
  const quoted = samples(risen.map((f) => `${quotePath(f.file)} (+${f.delta})`));
  return {
    stage: {
      stage,
      status: 'flagged',
      detail: `complexity rose sharply in ${risen.length} touched file(s): ${quoted}`,
    },
    flag: {
      description: `Complexity rise (+${risen.reduce((sum, f) => sum + f.delta, 0)} decision points) merged from session ${sessionId}`,
      files: risen.map((f) => f.file),
    },
  };
}

const pct = (ratio: number): string => `${Math.round(ratio * 1000) / 10}%`;

function judgeCoverage(
  measured: GateDebtMeasurement,
  baseline: DebtBaseline | undefined,
  sessionId: string,
): StageVerdict {
  const stage = 'coverage';
  const gaps = measured.gaps.filter((g) => g.capability === COVERAGE);
  const report = measured.coverage;
  if (!report && gaps.length === 0) {
    return {
      stage: { stage, status: 'skipped', detail: 'not measured — adapter cannot measure coverage' },
    };
  }
  const repoRatio = measured.debt.coverageRatio;
  const ratchet = repoRatio === undefined ? undefined : { coverageRatio: repoRatio };
  const baselineRatio = baseline?.coverageRatio;
  const coverable = measured.coverableFiles;
  if (!report || repoRatio === undefined) {
    const reason =
      gaps.length > 0 ? gapReasons(gaps) : 'the instrumented run reported no instrumentable lines';
    // Skipping here is a session-reachable outcome, not just an environment
    // gap: the coverage config lives in the worktree, so failing the run or
    // emptying the report turns the stage off. Changed source plus no
    // measurement is a flag, not a free skip (decision 30).
    if (coverable.length === 0) {
      return {
        stage: { stage, status: 'skipped', detail: withNote(measured, `not measured — ${reason}`) },
      };
    }
    return {
      stage: {
        stage,
        status: 'flagged',
        detail: withNote(
          measured,
          `${coverable.length} changed source file(s) went unmeasured — ${reason}`,
        ),
      },
      flag: {
        description: `Coverage unmeasured over ${coverable.length} changed source file(s) in session ${sessionId}`,
        files: [...coverable].sort(),
      },
    };
  }
  if (baselineRatio === undefined) {
    return {
      stage: {
        stage,
        status: 'skipped',
        detail: withNote(measured, 'not measured — no coverage baseline; run `pup init`'),
      },
      ...(ratchet ? { ratchet } : {}),
    };
  }
  const patch = measured.patch ?? { covered: 0, instrumented: 0, uncovered: [] };
  // Changed code the report never mentions is the loophole patch coverage
  // alone cannot see: excluding a file otherwise reads as "no instrumentable
  // changed lines" and passes for free (decision 30). hasOwn, not `in`: the
  // Python report is parsed JSON, so its keys can reach the prototype.
  const unreported = coverable.filter((file) => !Object.hasOwn(report.files, file));
  const ratio = patch.instrumented === 0 ? undefined : patch.covered / patch.instrumented;
  const ratioBelowBar = ratio !== undefined && ratio + COVERAGE_RATIO_EPSILON < baselineRatio;
  if (unreported.length === 0 && !ratioBelowBar) {
    return {
      stage: {
        stage,
        status: 'pass',
        detail: withNote(
          measured,
          ratio === undefined
            ? 'no instrumentable changed lines'
            : `patch coverage ${pct(ratio)} (baseline ${pct(baselineRatio)})`,
        ),
      },
      ...(ratchet ? { ratchet } : {}),
    };
  }
  // Both are evaluated, never short-circuited: a merge that hides files AND
  // drops patch coverage must record both, or the ledger understates what was
  // accepted while the baseline ratchets anyway.
  const problems: string[] = [];
  const files = new Set<string>();
  if (unreported.length > 0) {
    problems.push(
      `${unreported.length} changed source file(s) never reached the coverage report — no test loads them, or coverage config excludes them: ${samples(
        unreported.map(quotePath),
      )}`,
    );
    for (const file of unreported) files.add(file);
  }
  if (ratio !== undefined && ratioBelowBar) {
    problems.push(
      `patch coverage ${pct(ratio)} below repo baseline ${pct(baselineRatio)} (uncovered: ${samples(
        patch.uncovered.map((u) => `${quotePath(u.file)}:${u.line}`),
      )})`,
    );
    for (const u of patch.uncovered) files.add(u.file);
  }
  return {
    stage: { stage, status: 'flagged', detail: withNote(measured, problems.join('; ')) },
    flag: {
      description: `Coverage gap (${
        problems.length === 2
          ? 'unreported files and patch coverage'
          : unreported.length > 0
            ? 'unreported files'
            : `patch coverage ${pct(ratio as number)} below baseline ${pct(baselineRatio)}`
      }) merged from session ${sessionId}`,
      files: [...files].sort(),
    },
    ...(ratchet ? { ratchet } : {}),
  };
}
