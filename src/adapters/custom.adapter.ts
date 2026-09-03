import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { runGateChild } from '../core/sandbox.utils.js';
import { failureSummary } from './capability.utils.js';
import {
  CUSTOM_ADAPTER_CONFIG_PATH,
  CUSTOM_COMMAND_TIMEOUT_MS,
} from './custom-adapter.constants.js';
import { CustomAdapterCommandError, CustomAdapterConfigError } from './custom-adapter.errors.js';
import type {
  Adapter,
  CapabilityContext,
  CoverageReport,
  DeadExport,
  DepGraph,
  DuplicationReport,
  FileComplexity,
  GateCommand,
  GateStage,
} from './types/adapter.types.js';
import type { CustomAdapterConfig } from './types/custom-adapter.types.js';

const GATE_STAGES: GateStage[] = ['build', 'test', 'lint'];
const CONFIG_KEYS = [
  'id',
  'build',
  'test',
  'lint',
  'depGraph',
  'deadCode',
  'duplication',
  'complexity',
  'coverage',
];

function runJson<TOutput>(
  capability: string,
  command: string,
  ctx: CapabilityContext,
  stdin?: string,
): TOutput {
  let stdout: string;
  try {
    // The command string comes from the trusted checkout, but it runs in the
    // session's worktree against the session's scripts — same seam, same
    // confinement as a gate stage (decisions 28, 36).
    stdout = runGateChild('sh', ['-c', command], {
      cwd: ctx.measurePath,
      repoPath: ctx.configPath,
      gateEnv: ctx.gateEnv,
      timeout: CUSTOM_COMMAND_TIMEOUT_MS,
      ...(stdin !== undefined ? { input: stdin } : {}),
    });
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    throw new CustomAdapterCommandError(
      capability,
      command,
      (failure.stderr ?? failure.message ?? 'command failed').trim().slice(0, 200),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CustomAdapterCommandError(
      capability,
      command,
      `stdout is not valid JSON: ${stdout.trim().slice(0, 200)}`,
    );
  }
  // Shape-checked, not just parsed: the command measures session-authored code,
  // and `{"unavailable": …}` now MEANS something to the gate, so a script that
  // emitted it — or `null`, which the `in` operator used to throw on — could
  // turn a measurement into a skipped stage (decision 29).
  if (!matchesShape(capability, parsed)) {
    throw new CustomAdapterCommandError(
      capability,
      command,
      `stdout is not a valid ${capability} result: ${stdout.trim().slice(0, 200)}`,
    );
  }
  return parsed as TOutput;
}

/** The JSON shape docs/06 promises for each capability's stdout. */
function matchesShape(capability: string, parsed: unknown): boolean {
  const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  switch (capability) {
    case 'deadCode':
    case 'complexity':
      return Array.isArray(parsed);
    case 'coverage':
      return isObject && 'files' in parsed;
    // Both numbers reach the operator's terminal, the fenced PR body and the
    // re-steer prompt through the stage detail, and this stdout is written by a
    // command the session controls — so the types are checked here, at the
    // boundary, not merely probed for presence (decision 29).
    case 'duplication': {
      if (!isObject || !Number.isFinite((parsed as DuplicationReport).duplicatedLines)) {
        return false;
      }
      // `blocks` is indexed unguarded when the stage flags; absent, it crashes
      // the gate mid-run instead of failing the capability here.
      if (!Array.isArray((parsed as DuplicationReport).blocks)) return false;
      const excluded = (parsed as DuplicationReport).excludedTestBlocks;
      return excluded === undefined || Number.isFinite(excluded);
    }
    case 'depGraph':
      return isObject && 'modules' in parsed && 'edges' in parsed;
    default:
      return false;
  }
}

function parseConfig(configPath: string): CustomAdapterConfig {
  const raw = parse(readFileSync(configPath, 'utf8')) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CustomAdapterConfigError('expected a mapping of capabilities to shell commands');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  const unknown = entries.map(([key]) => key).filter((key) => !CONFIG_KEYS.includes(key));
  if (unknown.length > 0) {
    // A typo'd key would otherwise silently drop a stage — loud beats lenient.
    throw new CustomAdapterConfigError(
      `unknown key(s) ${unknown.join(', ')} (valid: ${CONFIG_KEYS.join(', ')})`,
    );
  }
  for (const [key, value] of entries) {
    if (typeof value !== 'string') {
      throw new CustomAdapterConfigError(`"${key}" must be a shell command string`);
    }
  }
  return raw as CustomAdapterConfig;
}

/**
 * The docs/06 escape hatch: `.pupitre/adapter.yml` maps capabilities to shell
 * commands for stacks without a built-in plugin. Loaded from the trusted main
 * checkout; capability commands then run in whichever checkout the gate hands
 * them (same trust model as package.json scripts). Returns undefined when the
 * repo has no config; malformed config throws rather than degrading.
 */
export function loadCustomAdapter(repoPath: string): Adapter | undefined {
  const configPath = join(repoPath, CUSTOM_ADAPTER_CONFIG_PATH);
  if (!existsSync(configPath)) return undefined;
  const config = parseConfig(configPath);

  const adapter: Adapter = {
    id: config.id ?? 'custom',
    detect: (path: string) => existsSync(join(path, CUSTOM_ADAPTER_CONFIG_PATH)),
    gateCommands: (_repoPath: string): GateCommand[] =>
      GATE_STAGES.filter((stage) => config[stage]).map((stage) => ({
        stage,
        command: 'sh',
        args: ['-c', config[stage] as string],
      })),
  };
  // Commands come from `.pupitre/adapter.yml` in the trusted checkout (a
  // protected path), so there is nothing further to resolve from configPath —
  // they simply run against whichever checkout is being measured.
  if (config.depGraph) {
    const command = config.depGraph;
    adapter.depGraph = (ctx) => runJson<DepGraph>('depGraph', command, ctx);
  }
  if (config.deadCode) {
    const command = config.deadCode;
    adapter.deadCode = (ctx) => runJson<DeadExport[]>('deadCode', command, ctx);
  }
  if (config.duplication) {
    const command = config.duplication;
    adapter.duplication = (ctx) => runJson<DuplicationReport>('duplication', command, ctx);
  }
  if (config.complexity) {
    const command = config.complexity;
    adapter.complexity = (ctx, files: string[]) =>
      runJson<FileComplexity[]>('complexity', command, ctx, JSON.stringify(files));
  }
  if (config.coverage) {
    const command = config.coverage;
    adapter.coverage = (ctx) => {
      // The coverage contract already has an "unavailable" channel — use it,
      // and carry the reason rather than dropping it (decision 29).
      try {
        return runJson<CoverageReport>('coverage', command, ctx);
      } catch (error) {
        return { unavailable: `coverage command failed: ${failureSummary(error)}` };
      }
    };
  }
  return adapter;
}
