import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateChildEnv } from '../core/gate-env.utils.js';
import { coveragePyToCoverageReport } from './python-coverage.utils.js';
import {
  DEBT_COMMAND_MAX_BUFFER_BYTES,
  DEBT_COMMAND_TIMEOUT_MS,
  VULTURE_DEAD_CODE_EXIT,
} from './python-debt.constants.js';
import { parseVultureOutput } from './python-debt.utils.js';
import type {
  Adapter,
  CoverageReport,
  DeadExport,
  GateCommand,
  GateStage,
} from './types/adapter.types.js';
import type { CoveragePyReport } from './types/coverage-py.types.js';

const PYTHON_MANIFESTS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'];
const PYTHON_CONFIGS = ['pyproject.toml', 'setup.cfg', 'requirements.txt'];

/** Regex for `compileall -x`: matches full paths, so venvs and vendored trees are skipped. */
const COMPILEALL_EXCLUDE = String.raw`\.venv|venv|node_modules|\.git|\.worktrees`;

/** fnmatch patterns for `vulture --exclude`, mirroring the compileall skips. */
const VULTURE_EXCLUDE = '.venv,venv,node_modules,.worktrees';

function readIfPresent(repoPath: string, name: string): string {
  const path = join(repoPath, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Lockfile-driven runner prefix, mirroring packageManager() on the TS side. */
function runnerPrefix(repoPath: string): string[] {
  if (existsSync(join(repoPath, 'uv.lock'))) return ['uv', 'run'];
  if (existsSync(join(repoPath, 'poetry.lock'))) return ['poetry', 'run'];
  return [];
}

function toCommand(stage: GateStage, words: string[]): GateCommand {
  const [command, ...args] = words;
  return { stage, command: command as string, args };
}

/** Raw-text probe across the config files a Python tool can be declared in. */
function declaresTool(repoPath: string, tool: string): boolean {
  return PYTHON_CONFIGS.some((name) => readIfPresent(repoPath, name).includes(tool));
}

/**
 * Capability runs measure, they must not mutate: `uv run` syncs (installs
 * session-declared packages) by default, so a worktree-planted lockfile would
 * otherwise turn a measurement into arbitrary package execution.
 */
function capabilityRunnerPrefix(repoPath: string): string[] {
  const prefix = runnerPrefix(repoPath);
  return prefix[0] === 'uv' ? [...prefix, '--no-sync'] : prefix;
}

function runCapability(repoPath: string, words: string[]): string {
  const [command, ...args] = words;
  return execFileSync(command as string, args, {
    cwd: repoPath,
    encoding: 'utf8',
    timeout: DEBT_COMMAND_TIMEOUT_MS,
    maxBuffer: DEBT_COMMAND_MAX_BUFFER_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Tool and config both come from the repo being measured, so the child
    // gets an allowlist rather than the operator's shell (decision 28).
    env: gateChildEnv(),
  });
}

/**
 * Python toolchain (docs/06): detect + build/test/lint, plus the shelled-out
 * debt capabilities the repo's own config declares — vulture for dead code,
 * pytest-cov for coverage (decision 25). An undeclared or failing tool returns
 * undefined, so those stages degrade to "not measured"; depGraph, duplication,
 * and complexity are still absent and degrade the same way. Config is probed
 * as raw text — the stack has no TOML parser (docs/08 gates new dependencies),
 * and a stray mention only ever adds a stage the repo's own toolchain must
 * then pass.
 */
export const pythonAdapter: Adapter = {
  id: 'python',

  detect(repoPath: string): boolean {
    return PYTHON_MANIFESTS.some((name) => existsSync(join(repoPath, name)));
  },

  gateCommands(repoPath: string): GateCommand[] {
    const prefix = runnerPrefix(repoPath);
    const pyproject = readIfPresent(repoPath, 'pyproject.toml');
    const setupCfg = readIfPresent(repoPath, 'setup.cfg');
    const commands: GateCommand[] = [];

    // "Build" for Python is a syntax check: byte-compile everything outside
    // virtualenvs. Bare invocations use python3 (macOS ships no `python`);
    // uv/poetry environments alias it themselves.
    const python = prefix.length > 0 ? 'python' : 'python3';
    commands.push(
      toCommand('build', [
        ...prefix,
        python,
        '-m',
        'compileall',
        '-q',
        '.',
        '-x',
        COMPILEALL_EXCLUDE,
      ]),
    );

    const hasPytest =
      existsSync(join(repoPath, 'pytest.ini')) ||
      pyproject.includes('pytest') ||
      setupCfg.includes('[tool:pytest]');
    if (hasPytest) commands.push(toCommand('test', [...prefix, 'pytest']));

    const hasRuff =
      existsSync(join(repoPath, 'ruff.toml')) ||
      existsSync(join(repoPath, '.ruff.toml')) ||
      pyproject.includes('ruff');
    if (hasRuff) commands.push(toCommand('lint', [...prefix, 'ruff', 'check', '.']));

    return commands;
  },

  deadCode(repoPath: string): DeadExport[] | undefined {
    if (!declaresTool(repoPath, 'vulture')) return undefined;
    // A [tool.vulture] section owns paths and excludes; otherwise scan the repo
    // with the same skips as compileall.
    const args = readIfPresent(repoPath, 'pyproject.toml').includes('[tool.vulture]')
      ? []
      : ['.', `--exclude=${VULTURE_EXCLUDE}`];
    try {
      return parseVultureOutput(
        runCapability(repoPath, [...capabilityRunnerPrefix(repoPath), 'vulture', ...args]),
        repoPath,
      );
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      if (failure.status === VULTURE_DEAD_CODE_EXIT) {
        return parseVultureOutput(failure.stdout ?? '', repoPath);
      }
      // Tool missing or crashed — not measured, never silently passed.
      return undefined;
    }
  },

  coverage(repoPath: string): CoverageReport | undefined {
    if (!declaresTool(repoPath, 'pytest-cov')) return undefined;
    const outDir = mkdtempSync(join(tmpdir(), 'pup-coverage-'));
    const reportPath = join(outDir, 'coverage.json');
    try {
      runCapability(repoPath, [
        ...capabilityRunnerPrefix(repoPath),
        'pytest',
        '--cov',
        `--cov-report=json:${reportPath}`,
      ]);
      const raw = JSON.parse(readFileSync(reportPath, 'utf8')) as CoveragePyReport;
      return coveragePyToCoverageReport(raw, repoPath);
    } catch {
      // A failed instrumented run (crash, timeout, failing tests) degrades to
      // "not measured" — the plain test stage has already gated correctness.
      return undefined;
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  },
};
