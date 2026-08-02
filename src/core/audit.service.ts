import type { Database } from 'better-sqlite3';
import type { Adapter } from '../adapters/types/adapter.types.js';
import { initProject } from './init.service.js';
import { COVERAGE_RATIO_EPSILON } from './merge-gate.constants.js';
import { projectId } from './paths.utils.js';
import { getProject } from './session.repository.js';
import type {
  AuditReport,
  DebtMetric,
  DebtTransition,
  StageDelta,
  StageTransition,
} from './types/audit.types.js';
import type { BaselineStageStatus, DebtBaseline, ProjectBaseline } from './types/init.types.js';
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
  push('duplicatedLines', previous?.duplicatedLines, fresh?.duplicatedLines, 'higher');
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
 * `pup audit` (no --sweep): re-run the baseline stages exactly like `pup init`,
 * diff against the previously stored baseline, and refresh it. First run (no
 * stored baseline) degenerates to plain init: no transitions to report.
 */
export function auditProject(
  db: Database,
  repoPath: string,
  adapters: Adapter[],
  gateEnv?: string[],
): AuditReport {
  const row = getProject(db, projectId(repoPath));
  const previous = row?.baseline ? (JSON.parse(row.baseline) as ProjectBaseline) : null;
  const report = initProject(db, repoPath, adapters, gateEnv);
  const transitions = previous ? compareBaselines(previous, report.baseline) : [];
  const debtTransitions = previous ? compareDebt(previous.debt, report.baseline.debt) : [];
  return {
    projectId: report.projectId,
    previous,
    baseline: report.baseline,
    transitions,
    debtTransitions,
    hasRegression:
      transitions.some((t) => t.delta === 'regressed') ||
      debtTransitions.some((t) => t.delta === 'regressed'),
    findings: report.findings,
    sandbox: report.sandbox,
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
