import type { Database } from 'better-sqlite3';
import { sanitizeReason } from '../adapters/capability.utils.js';
import type { Adapter } from '../adapters/types/adapter.types.js';
import { COVERAGE, DEAD_CODE } from './debt.service.js';
import { measureBaseline, persistBaseline } from './init.service.js';
import { COVERAGE_RATIO_EPSILON } from './merge-gate.constants.js';
import { projectId } from './paths.utils.js';
import { getProject } from './session.repository.js';
import type {
  AuditOutcome,
  DebtMetric,
  DebtTransition,
  StageDelta,
  StageTransition,
} from './types/audit.types.js';
import type { DebtGap } from './types/debt.types.js';
import type {
  BaselineStageStatus,
  DebtBaseline,
  MeasuredBaseline,
  ProjectBaseline,
} from './types/init.types.js';
import type { TaskId, TaskSpec } from './types/profile.types.js';

function classifyDelta(before: BaselineStageStatus, after: BaselineStageStatus): StageDelta {
  if (before === after) return 'unchanged';
  if (before === 'pass') return 'regressed';
  if (after === 'pass') return 'improved';
  return 'changed';
}

function compareBaselines(previous: ProjectBaseline, fresh: ProjectBaseline): StageTransition[] {
  return fresh.stages.map((stage) => {
    // A stage absent from the old baseline was never measured — same as skipped.
    const before = previous.stages.find((s) => s.stage === stage.stage)?.status ?? 'skipped';
    return {
      stage: stage.stage,
      before,
      after: stage.status,
      delta: classifyDelta(before, stage.status),
    };
  });
}

/** `worseDirection: 'higher'` for a count that should shrink, `'lower'` for a ratio that should grow. */
function classifyDebtDelta(
  before: number,
  after: number,
  worseDirection: 'higher' | 'lower',
  epsilon = 0,
): StageDelta {
  if (Math.abs(after - before) <= epsilon) return 'unchanged';
  const rose = after > before;
  return rose === (worseDirection === 'higher') ? 'regressed' : 'improved';
}

/**
 * Old -> new for each debt metric measured on both sides (docs/09 decision 34)
 * — `pup audit` used to refresh these numbers silently, so a rise like 182 ->
 * 196 duplicated lines never showed up anywhere but the raw baseline row.
 */
function compareDebt(
  previous: DebtBaseline | undefined,
  fresh: DebtBaseline | undefined,
): DebtTransition[] {
  const transitions: DebtTransition[] = [];
  const push = (
    metric: DebtMetric,
    before: number | undefined,
    after: number | undefined,
    worseDirection: 'higher' | 'lower',
    epsilon = 0,
  ): void => {
    if (before === undefined || after === undefined) return;
    transitions.push({
      metric,
      before,
      after,
      delta: classifyDebtDelta(before, after, worseDirection, epsilon),
    });
  };
  push('deadExports', previous?.deadExports?.length, fresh?.deadExports?.length, 'higher');
  // Two counts produced by different rules have nothing to diff — reporting the
  // rule change as an improvement would mask a real rise underneath it, the same
  // reason decision 34 leaves out a metric missing from either side.
  if (previous?.duplicationRule === fresh?.duplicationRule) {
    push('duplicatedLines', previous?.duplicatedLines, fresh?.duplicatedLines, 'higher');
  }
  push(
    'coverageRatio',
    previous?.coverageRatio,
    fresh?.coverageRatio,
    'lower',
    COVERAGE_RATIO_EPSILON,
  );
  return transitions;
}

const DEBT_METRIC_LABELS: Record<DebtMetric, string> = {
  deadExports: 'dead-code',
  duplicatedLines: 'duplication',
  coverageRatio: 'coverage',
};

function formatDebtValue(metric: DebtMetric, value: number): string {
  return metric === 'coverageRatio' ? `${Math.round(value * 1000) / 10}%` : String(value);
}

/** One printable "label  before -> after  MARKER" line per debt transition; cli just prints it. */
export function formatDebtTransition(t: DebtTransition): string {
  const label = DEBT_METRIC_LABELS[t.metric];
  const move = `${formatDebtValue(t.metric, t.before)} -> ${formatDebtValue(t.metric, t.after)}`;
  const marker = t.delta === 'unchanged' ? '' : `  ${t.delta.toUpperCase()}`;
  return `${label.padEnd(8)} ${move.padEnd(16)}${marker}`;
}

/**
 * Whether a gap would drop a figure the stored baseline has: one it did not
 * record at its own capture. A metric that has never measured (no coverage
 * runner declared, no vulture beside the TS adapter) gaps on every run, and
 * refusing for it would block the audit for good while protecting a figure
 * the baseline never had. A baseline from before gaps were recorded is judged
 * by the figures it holds instead, which cannot tell a second adapter's share
 * apart; the refusal names `pup init` as the way to put a metric that never
 * measured here on record.
 */
function isNewGap(previous: ProjectBaseline, gap: DebtGap): boolean {
  // An adapter the stored capture did not run added no share to its flat
  // `deadExports`; coverage is taken from the first adapter offering it, so a
  // newcomer there can really drop the figure.
  if (gap.capability === DEAD_CODE && !previous.adapters.includes(gap.adapterId)) return false;
  if (previous.gaps === undefined) return holdsLegacyFigure(previous.debt, gap.capability);
  return !previous.gaps.some(
    (g) => g.adapterId === gap.adapterId && g.capability === gap.capability,
  );
}

function holdsLegacyFigure(debt: DebtBaseline | undefined, capability: string): boolean {
  if (capability === COVERAGE) return debt?.coverageRatio !== undefined;
  if (capability === DEAD_CODE) return debt?.deadExports !== undefined;
  return true;
}

/**
 * `pup audit` (no --sweep): re-run the baseline stages exactly like `pup init`,
 * diff against the previously stored baseline, and refresh it. First run (no
 * stored baseline) degenerates to plain init: no transitions to report.
 *
 * A debt metric the adapter could not measure, where the stored baseline holds
 * a figure for it, keeps that baseline and its history whole: refreshing would
 * stamp a bar with no figure, which the next gate compares against as if the
 * metric had never existed. The project row and its origin url are recorded
 * before that decision; only the baseline and its history row are held back.
 */
export function auditProject(
  db: Database,
  repoPath: string,
  adapters: Adapter[],
  gateEnv?: string[],
  onRegression: 'refresh' | 'keep' = 'refresh',
): Promise<AuditOutcome> {
  const row = getProject(db, projectId(repoPath));
  const previous = row?.baseline ? (JSON.parse(row.baseline) as ProjectBaseline) : null;
  // Not async, so measureBaseline's refusals still throw (see there).
  return measureBaseline(db, repoPath, adapters, gateEnv).then((report) =>
    judgeAudit(db, previous, report, onRegression),
  );
}

function judgeAudit(
  db: Database,
  previous: ProjectBaseline | null,
  report: MeasuredBaseline,
  onRegression: 'refresh' | 'keep',
): AuditOutcome {
  const unmeasured = previous
    ? report.gaps
        .filter((gap) => isNewGap(previous, gap))
        .map(
          (gap) =>
            `${sanitizeReason(gap.adapterId)}: ${gap.capability} not measured — ${sanitizeReason(gap.reason)}`,
        )
    : [];
  const transitions = previous ? compareBaselines(previous, report.baseline) : [];
  const debtTransitions = previous ? compareDebt(previous.debt, report.baseline.debt) : [];
  const hasRegression =
    transitions.some((t) => t.delta === 'regressed') ||
    debtTransitions.some((t) => t.delta === 'regressed');
  const heldOnRegression = hasRegression && onRegression === 'keep';
  if (unmeasured.length === 0 && !heldOnRegression) {
    persistBaseline(db, report.projectId, report.baseline);
  }
  return {
    projectId: report.projectId,
    previous,
    baseline: report.baseline,
    transitions,
    debtTransitions,
    hasRegression,
    findings: report.findings,
    sandbox: report.sandbox,
    unmeasured,
    heldOnRegression,
  };
}

/**
 * Task spec for a `pup audit --sweep` session (docs/02): deletion-only — the
 * agent hunts dead code, unused exports, and unused dependencies, and removes
 * them. The gate's build/test/lint stages are the safety net, so the scope is
 * the whole repo rather than a curated glob list.
 */
export function buildSweepTask(id: TaskId, findings: string[]): TaskSpec {
  const context = findings.length
    ? `\n\nAudit findings to keep in mind (do not fix these, they are context):\n${findings
        .map((finding) => `- ${finding}`)
        .join('\n')}`
    : '';
  return {
    id,
    goal:
      'Deletion-only sweep: find and remove dead code, unused exports, unused files, and ' +
      'unused dependencies. Do not add features, rename, or refactor behaviour. Prefer tools ' +
      `like knip, ts-prune, or depcheck to find candidates, then verify each before deleting.${context}`,
    scopeIn: ['**/*'],
    acceptance: [
      'only remove code, files, and dependencies — no new functionality or renames',
      'build, tests, and lint pass after every deletion',
      'each deletion is independently justified in the commit message',
    ],
  };
}
