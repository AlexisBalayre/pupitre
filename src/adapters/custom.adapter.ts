import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { scrubbedGitEnv } from '../core/git-diff.client.js';
import {
  CUSTOM_ADAPTER_CONFIG_PATH,
  CUSTOM_COMMAND_TIMEOUT_MS,
} from './custom-adapter.constants.js';
import { CustomAdapterCommandError, CustomAdapterConfigError } from './custom-adapter.errors.js';
import type {
  Adapter,
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
  cwd: string,
  stdin?: string,
): TOutput {
  let stdout: string;
  try {
    stdout = execFileSync('sh', ['-c', command], {
      cwd,
      encoding: 'utf8',
      timeout: CUSTOM_COMMAND_TIMEOUT_MS,
      input: stdin,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: scrubbedGitEnv(),
    });
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    throw new CustomAdapterCommandError(
      capability,
      command,
      (failure.stderr ?? failure.message ?? 'command failed').trim().slice(0, 200),
    );
  }
  try {
    return JSON.parse(stdout) as TOutput;
  } catch {
    throw new CustomAdapterCommandError(
      capability,
      command,
      `stdout is not valid JSON: ${stdout.trim().slice(0, 200)}`,
    );
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
  if (config.depGraph) {
    const command = config.depGraph;
    adapter.depGraph = (path: string) => runJson<DepGraph>('depGraph', command, path);
  }
  if (config.deadCode) {
    const command = config.deadCode;
    adapter.deadCode = (path: string) => runJson<DeadExport[]>('deadCode', command, path);
  }
  if (config.duplication) {
    const command = config.duplication;
    adapter.duplication = (path: string) =>
      runJson<DuplicationReport>('duplication', command, path);
  }
  if (config.complexity) {
    const command = config.complexity;
    adapter.complexity = (path: string, files: string[]) =>
      runJson<FileComplexity[]>('complexity', command, path, JSON.stringify(files));
  }
  if (config.coverage) {
    const command = config.coverage;
    adapter.coverage = (path: string) => {
      // The coverage contract already has an "unavailable" channel — use it.
      try {
        return runJson<CoverageReport>('coverage', command, path);
      } catch {
        return undefined;
      }
    };
  }
  return adapter;
}
