import { execFileSync } from 'node:child_process';
import type { Database } from 'better-sqlite3';
import type { Adapter } from '../adapters/types/adapter.types.js';
import { scrubbedGitEnv } from './git-diff.client.js';
import { GATE_COMMAND_TIMEOUT_MS, GATE_OUTPUT_TAIL_CHARS } from './merge-gate.constants.js';
import { projectId } from './paths.utils.js';
import { ensureProject, saveProjectBaseline } from './session.repository.js';
import type {
  BaselineStageResult,
  DebtBaseline,
  InitReport,
  ProjectBaseline,
} from './types/init.types.js';

export class NoAdapterError extends Error {
  constructor(repoPath: string) {
    super(`No adapter detected for ${repoPath} (v1 supports TypeScript only).`);
    this.name = 'NoAdapterError';
  }
}

function runBaselineStage(
  repoPath: string,
  stage: string,
  command: { command: string; args: string[] },
): BaselineStageResult {
  const start = Date.now();
  try {
    execFileSync(command.command, command.args, {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: GATE_COMMAND_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: scrubbedGitEnv(),
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
export function initProject(db: Database, repoPath: string, adapters: Adapter[]): InitReport {
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
    const result = runBaselineStage(repoPath, stage, command);
    stages.push(result);
    if (result.status === 'fail') {
      findings.push(
        `${stage} fails at baseline — the v1 gate hard-fails this stage, so no session can merge until it passes on ${repoPath}.`,
      );
    }
  }

  const debt: DebtBaseline = {};
  if (detected.some((a) => a.deadCode)) {
    debt.deadExports = detected.flatMap((a) => a.deadCode?.(repoPath) ?? []);
  }
  if (detected.some((a) => a.duplication)) {
    debt.duplicatedLines = detected.reduce(
      (sum, a) => sum + (a.duplication?.(repoPath).duplicatedLines ?? 0),
      0,
    );
  }

  const baseline: ProjectBaseline = {
    capturedAt: new Date().toISOString(),
    adapters: detected.map((a) => a.id),
    stages,
    ...(debt.deadExports !== undefined || debt.duplicatedLines !== undefined ? { debt } : {}),
  };
  saveProjectBaseline(db, pid, baseline.adapters, JSON.stringify(baseline));
  return { projectId: pid, baseline, findings };
}
