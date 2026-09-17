import { execFileSync } from 'node:child_process';
import type { Database } from 'better-sqlite3';
import {
  brokenPackageManagerInstall,
  isUnavailable,
  localContext,
  sanitizeReason,
} from '../adapters/capability.utils.js';
import type { Adapter, DeadExport } from '../adapters/types/adapter.types.js';
import { appendBaselineHistory, hasBaselineHistoryEntry } from './baseline-history.repository.js';
import { repoCoverageRatio } from './coverage.utils.js';
import { GIT_SAFE_CONFIG, scrubbedGitEnv } from './git-diff.client.js';
import {
  DUPLICATION_RULE_ID,
  GATE_COMMAND_TIMEOUT_MS,
  GATE_OUTPUT_TAIL_CHARS,
} from './merge-gate.constants.js';
import { projectId } from './paths.utils.js';
import { runGateChild, sandboxLabel } from './sandbox.utils.js';
import {
  ensureProject,
  getProject,
  saveProjectBaseline,
  saveProjectOriginUrl,
} from './session.repository.js';
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

/**
 * A stage died before measuring anything: the package manager it runs through
 * could not load from pup's toolchain cache. Stored, that FAIL becomes the bar
 * the next merge gates against (decision 55), so the capture stops instead.
 */
export class BrokenToolchainError extends Error {
  constructor(stage: string, installPath: string) {
    super(
      `${stage} could not load its package manager from the toolchain cache: ${installPath} is broken. ` +
        'No baseline stored — move that directory aside and re-run.',
    );
    this.name = 'BrokenToolchainError';
  }
}

/**
 * Origin's URL exactly as the config stores it, `undefined` when the repo has
 * no origin. `config --get`, never `remote get-url`, which applies the
 * `url.<base>.insteadOf` rewrites a session can write into the shared config
 * (decision 54). The value `pup init` records and the value the merge gate
 * compares against it are both read through this one function, so the two
 * cannot come to read the same config differently (decision 56). stderr is
 * captured rather than inherited: a path that is no repo at all is an answer
 * here, not something to print.
 */
export function readOriginUrl(repoPath: string): string | undefined {
  try {
    const url = execFileSync(
      'git',
      [...GIT_SAFE_CONFIG, '-C', repoPath, 'config', '--get', 'remote.origin.url'],
      { encoding: 'utf8', env: scrubbedGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    return url || undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a `pup init` run may do to the recorded push target (decision 56):
 * `'record'` writes it when nothing is recorded yet and reports a value that
 * disagrees rather than overwriting it, `'re-record'` is the operator's word
 * that origin moved (`pup init --origin-moved`), and `'skip'` is a session's
 * own `pup init` — the record is what the gate holds a session's merge to, so
 * a session must not be able to nominate it.
 */
export type OriginRecording = 'record' | 're-record' | 'skip';

/**
 * Store origin's URL as this checkout has it, and return the finding when it
 * disagrees with what is already recorded. Recorded once at setup, from the
 * checkout the operator trusts, because the config the gate reads at merge
 * time is shared with every session's worktree and a session can rewrite it
 * (decision 56). A repo with no origin records nothing: `pup merge --pr`
 * refuses on the missing remote before it ever asks about the target.
 */
function recordOriginUrl(
  db: Database,
  pid: string,
  repoPath: string,
  recording: OriginRecording,
): string | undefined {
  if (recording === 'skip') return undefined;
  const configured = readOriginUrl(repoPath);
  if (!configured) return undefined;
  const recorded = getProject(db, pid)?.origin_url ?? undefined;
  if (recorded === configured) return undefined;
  if (recorded === undefined || recording === 're-record') {
    saveProjectOriginUrl(db, pid, configured);
    return undefined;
  }
  return (
    `origin is configured as ${sanitizeReason(configured)}, but the recorded push target is ` +
    `${sanitizeReason(recorded)} — \`pup merge --pr\` refuses while the two disagree. The shared ` +
    'config is session-writable, so a change you did not make is a session that made it; ' +
    're-record it with `pup init --origin-moved` only if origin really moved.'
  );
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
  recording: OriginRecording = 'record',
): InitReport {
  const detected = adapters.filter((a) => a.detect(repoPath));
  if (detected.length === 0) throw new NoAdapterError(repoPath);

  const pid = projectId(repoPath);
  ensureProject(db, pid, repoPath);

  const stages: BaselineStageResult[] = [];
  const findings: string[] = [];
  // Before the stages, so the push target is recorded even on a run that ends
  // in a broken-toolchain refusal (decision 55): it is not a bar, and setup is
  // exactly when the checkout is the one the operator trusts.
  const originFinding = recordOriginUrl(db, pid, repoPath, recording);
  if (originFinding) findings.push(originFinding);
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
  // Checked before the debt capabilities too: they run the same package
  // manager, and would only spend minutes failing the same way.
  for (const { stage, status, detail } of stages) {
    const installPath = status === 'fail' ? brokenPackageManagerInstall(detail ?? '') : undefined;
    if (installPath) throw new BrokenToolchainError(stage, installPath);
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
