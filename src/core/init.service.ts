import type { Database } from 'better-sqlite3';
import { isUnavailable, localContext, sanitizeReason } from '../adapters/capability.utils.js';
import type { Adapter, DeadExport } from '../adapters/types/adapter.types.js';
import { appendBaselineHistory, hasBaselineHistoryEntry } from './baseline-history.repository.js';
import { repoCoverageRatio } from './coverage.utils.js';
import {
  DUPLICATION_RULE_ID,
  GATE_COMMAND_TIMEOUT_MS,
  GATE_OUTPUT_TAIL_CHARS,
} from './merge-gate.constants.js';
import { projectId } from './paths.utils.js';
import { runGateChild, sandboxLabel } from './sandbox.utils.js';
import { ensureProject, getProject, saveProjectBaseline } from './session.repository.js';
import type {
  BaselineStageResult,
  DebtBaseline,
  InitReport,
  ProjectBaseline,
} from './types/init.types.js';

export class NoAdapterError extends Error {
  constructor(repoPath: string) {
    super(
      `No adapter detected for ${repoPath} (supported stacks: TypeScript, Python, or a .pupitre/adapter.yml).`,
    );
    this.name = 'NoAdapterError';
  }
}

function runBaselineStage(
  repoPath: string,
  stage: string,
  command: { command: string; args: string[] },
  gateEnv?: string[],
): BaselineStageResult {
  const start = Date.now();
  try {
    // Main is "trusted" only in the sense that the gate let it in — these are
    // still the scripts a session wrote, one merge earlier, so they run under
    // the same seam as a gate stage (decisions 28, 36).
    runGateChild(command.command, command.args, {
      cwd: repoPath,
      repoPath,
      gateEnv,
      timeout: GATE_COMMAND_TIMEOUT_MS,
    });
    return { stage, status: 'pass', durationMs: Date.now() - start };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim();
    return {
      stage,
      status: 'fail',
      detail: (output || (failure.message ?? 'command failed')).slice(-GATE_OUTPUT_TAIL_CHARS),
      durationMs: Date.now() - start,
    };
  }
}

/**
 * `pup init`, v1 slim: detect adapters, run the gate stages once against the
 * main checkout, and store the result as the project baseline (docs/07 phases
 * 1-2, mechanical parts only). Day one blocks nothing — a failing baseline is
 * recorded, not enforced — but the findings tell the human what the v1 gate
 * WILL hard-fail on before any session runs. Re-running refreshes the baseline.
 */
export function initProject(
  db: Database,
  repoPath: string,
  adapters: Adapter[],
  gateEnv?: string[],
): InitReport {
  const detected = adapters.filter((a) => a.detect(repoPath));
  if (detected.length === 0) throw new NoAdapterError(repoPath);

  const pid = projectId(repoPath);
  ensureProject(db, pid, repoPath);

  const stages: BaselineStageResult[] = [];
  const findings: string[] = [];
  const commands = detected.flatMap((a) => a.gateCommands(repoPath));
  for (const stage of ['build', 'test', 'lint'] as const) {
    const command = commands.find((c) => c.stage === stage);
    if (!command) {
      stages.push({ stage, status: 'skipped', detail: 'no command available', durationMs: 0 });
      findings.push(
        `No ${stage} command resolved — the gate will report this stage as "not measured".`,
      );
      continue;
    }
    const result = runBaselineStage(repoPath, stage, command, gateEnv);
    stages.push(result);
    if (result.status === 'fail') {
      findings.push(
        `${stage} fails at baseline — the v1 gate hard-fails this stage, so no session can merge until it passes on ${repoPath}.`,
      );
    }
  }

  const debt: DebtBaseline = {};
  const ctx = localContext(repoPath, gateEnv);
  // A capability that could not measure says why (decision 29); that reason is
  // the whole point of running init before any session does.
  // Sanitized here, not at the producer: a custom adapter's reason is parsed
  // JSON that never passed through failureSummary (decision 29).
  const reportUnavailable = (adapterId: string, stage: string, reason: string): void => {
    findings.push(
      `${adapterId}: ${stage} not measured — ${sanitizeReason(reason)}. The gate will skip that stage until it is fixed.`,
    );
  };

  const deadCodeResults = detected.map((a) => ({ id: a.id, result: a.deadCode?.(ctx) }));
  for (const { id, result } of deadCodeResults) {
    if (result && isUnavailable(result)) reportUnavailable(id, 'dead code', result.unavailable);
  }
  const measured = deadCodeResults
    .map(({ result }) => result)
    .filter((r): r is DeadExport[] => r !== undefined && !isUnavailable(r));
  // Counting adapters that measured, not findings: an unavailable capability
  // must leave the bar unset (a baseline of [] would read as "0 dead exports"
  // and flag every later finding), while one that found nothing still stores [].
  if (measured.length > 0) {
    debt.deadExports = measured.flat();
  }
  if (detected.some((a) => a.duplication)) {
    debt.duplicatedLines = detected.reduce(
      (sum, a) => sum + (a.duplication?.(ctx).duplicatedLines ?? 0),
      0,
    );
    // Stamped with the number so the gate can tell a comparable bar from one
    // counted under an older rule (decision 39).
    debt.duplicationRule = DUPLICATION_RULE_ID;
  }
  const coverageAdapter = detected.find((a) => a.coverage);
  const coverageResult = coverageAdapter?.coverage?.(ctx);
  if (coverageAdapter && coverageResult && isUnavailable(coverageResult)) {
    reportUnavailable(coverageAdapter.id, 'coverage', coverageResult.unavailable);
  }
  const coverageReport =
    coverageResult && !isUnavailable(coverageResult) ? coverageResult : undefined;
  const coverageRatio = coverageReport ? repoCoverageRatio(coverageReport) : undefined;
  if (coverageRatio !== undefined) debt.coverageRatio = coverageRatio;

  const baseline: ProjectBaseline = {
    capturedAt: new Date().toISOString(),
    adapters: detected.map((a) => a.id),
    stages,
    ...(Object.keys(debt).length > 0 ? { debt } : {}),
  };
  // History (decision 38): every capture appends its own row before the
  // overwrite, so the only stored baseline with no row is one written before
  // the table existed — seed it here or the overwrite discards it for good.
  const storedBaseline = getProject(db, pid)?.baseline;
  if (storedBaseline) {
    const previous = JSON.parse(storedBaseline) as ProjectBaseline;
    if (!hasBaselineHistoryEntry(db, pid, previous.capturedAt)) {
      appendBaselineHistory(db, {
        projectId: pid,
        capturedAt: previous.capturedAt,
        stages: previous.stages,
        debt: previous.debt,
      });
    }
  }
  appendBaselineHistory(db, {
    projectId: pid,
    capturedAt: baseline.capturedAt,
    stages: baseline.stages,
    debt: baseline.debt,
  });
  saveProjectBaseline(db, pid, baseline.adapters, JSON.stringify(baseline));
  return { projectId: pid, baseline, findings, sandbox: sandboxLabel() };
}
