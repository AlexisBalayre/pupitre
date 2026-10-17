import type { Database } from 'better-sqlite3';
import {
  brokenPackageManagerInstall,
  localContext,
  sanitizeReason,
} from '../adapters/capability.utils.js';
import type { Adapter, GateCommand, GateStage } from '../adapters/types/adapter.types.js';
import { appendBaselineHistory, hasBaselineHistoryEntry } from './baseline-history.repository.js';
import { measureCoverage, measureStaticDebt } from './debt.service.js';
import { runGit } from './git-diff.client.js';
import { GATE_COMMAND_TIMEOUT_MS, GATE_OUTPUT_TAIL_CHARS } from './merge-gate.constants.js';
import { projectId } from './paths.utils.js';
import { GateInterruptedError, runGateChild, sandboxLabel } from './sandbox.utils.js';
import {
  countProjectSessions,
  ensureProject,
  getProject,
  saveProjectBaseline,
  saveProjectOriginUrl,
} from './session.repository.js';
import type { DebtGap } from './types/debt.types.js';
import type { BaselineStageResult, InitReport, ProjectBaseline } from './types/init.types.js';

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
    const url = runGit(
      repoPath,
      ['config', '--get', 'remote.origin.url'],
      // Timed out like every other child pup runs: an `include.path` pointing at
      // a fifo is another thing a session can write into the shared config, and
      // an untimed read would hang `pup init` and hang `--pr` before the lock.
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: GATE_COMMAND_TIMEOUT_MS },
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
 * that origin moved (`pup init --origin-moved`). Both are the operator's: a
 * session cannot reach `pup init` at all (decision 64).
 */
export type OriginRecording = 'record' | 're-record';

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
  const configured = readOriginUrl(repoPath);
  if (!configured) return undefined;
  const recorded = getProject(db, pid)?.origin_url ?? undefined;
  if (recorded === configured) return undefined;
  // Stored only if it survives the sanitizer the terminal messages use: a value
  // carrying control characters repaints whatever is printed around it, and no
  // remote URL anyone types needs them. Refused rather than sanitized, because
  // a sanitized URL is not the one the gate would compare against.
  const clean = sanitizeReason(configured);
  if (clean !== configured) {
    return (
      `origin is configured as ${clean}, which is not a URL anyone could have typed — control ` +
      'characters, newlines or over 300 of them. Not recorded: clear it from the config and ' +
      're-run, and treat the session that wrote it as compromised.'
    );
  }
  // The first record is trust-on-first-use, and it is only honest while nothing
  // has had the chance to write the config first. A project that already ran
  // sessions before this was recorded — every project set up before the column
  // existed — has had exactly that chance, so the operator confirms the value.
  if (recorded === undefined && recording === 'record' && countProjectSessions(db, pid) > 0) {
    return (
      `origin is configured as ${clean}, and sessions have already run here, so the shared ` +
      'config it comes from has been writable by something other than you. Not recorded: ' +
      'confirm it with `pup init --origin-moved`.'
    );
  }
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

async function runBaselineStage(
  repoPath: string,
  stage: string,
  command: { command: string; args: string[]; writablePaths?: string[] },
  gateEnv?: string[],
): Promise<BaselineStageResult> {
  const start = Date.now();
  try {
    // Main is "trusted" only in the sense that the gate let it in — these are
    // still the scripts a session wrote, one merge earlier, so they run under
    // the same seam as a gate stage (decisions 28, 36).
    await runGateChild(command.command, command.args, {
      cwd: repoPath,
      repoPath,
      ...(command.writablePaths ? { writablePaths: command.writablePaths } : {}),
      gateEnv,
      timeout: GATE_COMMAND_TIMEOUT_MS,
    });
    return { stage, status: 'pass', durationMs: Date.now() - start };
  } catch (error) {
    if (error instanceof GateInterruptedError) throw error;
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

/** A baseline measured but not yet stored, with the debt capabilities that could not measure. */
export interface MeasuredBaseline extends InitReport {
  gaps: DebtGap[];
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
): Promise<InitReport> {
  // Not async, so measureBaseline's refusals still throw (see there).
  return measureBaseline(db, repoPath, adapters, gateEnv, recording).then(
    ({ projectId: pid, baseline, findings, sandbox }) => {
      persistBaseline(db, pid, baseline);
      return { projectId: pid, baseline, findings, sandbox };
    },
  );
}

/**
 * Everything `pup init` does short of storing the baseline, so `pup audit` can
 * look at what was measured before it decides whether to store it. Not async:
 * the refusals before anything runs throw rather than reject, as they always
 * have, because the CLI's no-adapter guard catches a throw; the stages are the
 * promise.
 */
export function measureBaseline(
  db: Database,
  repoPath: string,
  adapters: Adapter[],
  gateEnv?: string[],
  recording: OriginRecording = 'record',
): Promise<MeasuredBaseline> {
  // Before anything runs, so a platform pup cannot confine and the operator has
  // not declared refuses whole, not after half a baseline (decision 78).
  const sandbox = sandboxLabel();
  const detected = adapters.filter((a) => a.detect(repoPath));
  if (detected.length === 0) throw new NoAdapterError(repoPath);

  const pid = projectId(repoPath);
  ensureProject(db, pid, repoPath);

  const findings: string[] = [];
  // Before the stages, so the push target is recorded even on a run that ends
  // in a broken-toolchain refusal (decision 55): it is not a bar, and setup is
  // exactly when the checkout is the one the operator trusts.
  const originFinding = recordOriginUrl(db, pid, repoPath, recording);
  if (originFinding) findings.push(originFinding);
  return measureStages(repoPath, detected, gateEnv, findings).then((baseline) => ({
    projectId: pid,
    baseline: baseline.baseline,
    findings,
    sandbox,
    gaps: baseline.gaps,
  }));
}

/** The baseline stages and debt capabilities, onto `findings`. */
async function measureStages(
  repoPath: string,
  detected: Adapter[],
  gateEnv: string[] | undefined,
  findings: string[],
): Promise<{ baseline: ProjectBaseline; gaps: DebtGap[] }> {
  const ctx = localContext(repoPath, gateEnv);
  const commands = detected.flatMap((adapter) =>
    adapter.gateCommands(repoPath).map((command) => ({ ...command, adapter })),
  );
  const run = (
    stage: GateStage,
    command: (Omit<GateCommand, 'stage'> & { writablePaths?: string[] }) | undefined,
  ): Promise<BaselineStageResult> | undefined =>
    command && runBaselineStage(repoPath, stage, command, gateEnv);
  const commandFor = (stage: GateStage) => commands.find((c) => c.stage === stage);

  // Build first and alone: the test run and lint read what it produced.
  const build = await run('build', commandFor('build'));
  if (build) assertToolchain([build]);
  // One instrumented run answers for the test stage and for coverage when the
  // adapter whose test command it is measures coverage too (decision 95).
  const test = commandFor('test');
  const coverageAdapter = detected.find((a) => a.coverage);
  const covered =
    test && test.adapter === coverageAdapter ? test.adapter.coveredTest?.(ctx) : undefined;
  try {
    // Lint and the static debt capabilities only read the checkout, so they
    // run alongside the test run; each settles before anything is read, so no
    // child outlives a refusal (decision 95).
    const running = [
      run('test', covered ?? test),
      run('lint', commandFor('lint')),
      measureStaticDebt(detected, ctx),
    ] as const;
    const settled = await Promise.allSettled(running);
    const interrupted = settled.find(
      (outcome) => outcome.status === 'rejected' && outcome.reason instanceof GateInterruptedError,
    );
    if (interrupted?.status === 'rejected') throw interrupted.reason;
    const [tested, linted, staticDebt] = await Promise.all(running);

    const stages: BaselineStageResult[] = [];
    for (const [stage, result] of [
      ['build', build],
      ['test', tested],
      ['lint', linted],
    ] as const) {
      if (!result) {
        stages.push({ stage, status: 'skipped', detail: 'no command available', durationMs: 0 });
        findings.push(
          `No ${stage} command resolved — the gate will report this stage as "not measured".`,
        );
        continue;
      }
      stages.push(result);
      if (result.status === 'fail') {
        findings.push(
          `${stage} fails at baseline — the v1 gate hard-fails this stage, so no session can merge until it passes on ${repoPath}.`,
        );
      }
    }
    // Checked before coverage too: an unfolded coverage run goes through the
    // same package manager, and would only spend minutes failing the same way.
    assertToolchain(stages);

    // The gate measures the same way, through the same module, or the bar
    // stored here and the bar merges are compared against drift apart
    // (decision 72). A failed instrumented run wrote no coverage worth reading.
    const folded = !covered
      ? undefined
      : tested?.status === 'pass'
        ? covered.report()
        : { unavailable: 'the instrumented test run failed, so its coverage is not read' };
    const { debt, gaps } = await measureCoverage(staticDebt, detected, ctx, folded);
    // A capability that could not measure says why (decision 29); that reason is
    // the whole point of running init before any session does.
    // Sanitized here, not at the producer: a custom adapter's reason is parsed
    // JSON that never passed through failureSummary (decision 29).
    for (const gap of gaps) {
      findings.push(
        `${sanitizeReason(gap.adapterId)}: ${gap.capability} not measured — ${sanitizeReason(gap.reason)}. ` +
          'The gate will skip that stage until it is fixed.',
      );
    }

    const baseline: ProjectBaseline = {
      capturedAt: new Date().toISOString(),
      adapters: detected.map((a) => a.id),
      stages,
      ...(Object.keys(debt).length > 0 ? { debt } : {}),
      gaps: gaps.map(({ adapterId, capability }) => ({ adapterId, capability })),
    };
    return { baseline, gaps };
  } finally {
    covered?.dispose();
  }
}

/**
 * Refuse a capture whose stage died loading the package manager rather than
 * measuring anything: stored, that FAIL would be the bar (decision 55).
 */
function assertToolchain(stages: BaselineStageResult[]): void {
  for (const { stage, status, detail } of stages) {
    const installPath = status === 'fail' ? brokenPackageManagerInstall(detail ?? '') : undefined;
    if (installPath) throw new BrokenToolchainError(stage, installPath);
  }
}

/**
 * Store a measured baseline as the project's bar, with its history row. The one
 * place that appends history (decision 38), shared by init and the audit, which
 * calls it only once every metric the stored baseline holds has measured.
 */
export function persistBaseline(db: Database, pid: string, baseline: ProjectBaseline): void {
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
}
