import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateChildEnv } from '../core/gate-env.utils.js';
import { failureSummary } from './capability.utils.js';
import { coveragePyToCoverageReport } from './python-coverage.utils.js';
import {
  DEBT_COMMAND_MAX_BUFFER_BYTES,
  DEBT_COMMAND_TIMEOUT_MS,
  VULTURE_DEAD_CODE_EXIT,
} from './python-debt.constants.js';
import { parseVultureOutput } from './python-debt.utils.js';
import type {
  Adapter,
  CapabilityContext,
  CapabilityUnavailable,
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

/** Vulture reads this section from its working directory's pyproject.toml. */
const VULTURE_SECTION = '[tool.vulture]';

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

/**
 * pytest's own discovery conventions, which coverage.py omits from its report
 * by default — the gate must not expect a test file to be covered.
 */
function isPythonTestFile(file: string): boolean {
  const name = file.split('/').at(-1) ?? '';
  return name.startsWith('test_') || name.endsWith('_test.py') || name === 'conftest.py';
}

/** Raw-text probe across the config files a Python tool can be declared in. */
function declaresTool(repoPath: string, tool: string): boolean {
  return PYTHON_CONFIGS.some((name) => readIfPresent(repoPath, name).includes(tool));
}

/**
 * The `[tool.vulture]` block's body, for comparing two checkouts' config. Text,
 * not parsed: the stack has no TOML parser (docs/08 gates new dependencies) and
 * this only ever has to answer "did the worktree change it?", where any
 * difference — including one that reformats without changing meaning — is
 * answered conservatively by declining to measure.
 */
function vultureSection(repoPath: string): string {
  const toml = readIfPresent(repoPath, 'pyproject.toml');
  const start = toml.indexOf(VULTURE_SECTION);
  if (start === -1) return '';
  const body = toml.slice(start + VULTURE_SECTION.length);
  const nextSection = body.search(/^\s*\[/m);
  return (nextSection === -1 ? body : body.slice(0, nextSection)).trim();
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
 * a reason, so those stages degrade to "not measured" and say why; depGraph,
 * duplication, and complexity are still absent and degrade the same way as an
 * adapter that never had them. Config is probed
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

  deadCode({ measurePath, configPath }: CapabilityContext): DeadExport[] | CapabilityUnavailable {
    if (!declaresTool(configPath, 'vulture')) {
      return { unavailable: `no vulture declared in ${PYTHON_CONFIGS.join(', ')}` };
    }
    // vulture reads [tool.vulture] from its working directory, and the scan has
    // to run in the worktree for relative paths and excludes to mean what they
    // do today — so the trusted checkout cannot simply supply the config. What
    // it can do is refuse: a worktree that rewrites the section controls
    // `paths`, `ignore_names` and `min_confidence`, which turns the scan into a
    // guaranteed-empty measurement — a PASS plus a ratcheted-to-nothing
    // baseline, strictly worse than the skip decision 25 accepted. Fully
    // trusting the config needs a TOML parser (docs/08 gates the dependency).
    const trustedSection = vultureSection(configPath);
    if (vultureSection(measurePath) !== trustedSection) {
      return {
        unavailable:
          'the worktree changes [tool.vulture]; refusing to trust a scan it configures itself',
      };
    }
    // A [tool.vulture] section owns paths and excludes; otherwise scan the repo
    // with the same skips as compileall.
    const args = trustedSection ? [] : ['.', `--exclude=${VULTURE_EXCLUDE}`];
    try {
      return parseVultureOutput(
        runCapability(measurePath, [...capabilityRunnerPrefix(configPath), 'vulture', ...args]),
        measurePath,
      );
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      if (failure.status === VULTURE_DEAD_CODE_EXIT) {
        return parseVultureOutput(failure.stdout ?? '', measurePath);
      }
      // Declared but unusable — not measured, never silently passed.
      return { unavailable: `vulture failed: ${failureSummary(error)}` };
    }
  },

  coverableFiles({ measurePath }: CapabilityContext, files: string[]): string[] {
    return files.filter(
      (file) =>
        file.endsWith('.py') && !isPythonTestFile(file) && existsSync(join(measurePath, file)),
    );
  },

  coverage({ measurePath, configPath }: CapabilityContext): CoverageReport | CapabilityUnavailable {
    if (!declaresTool(configPath, 'pytest-cov')) {
      return { unavailable: `no pytest-cov declared in ${PYTHON_CONFIGS.join(', ')}` };
    }
    const outDir = mkdtempSync(join(tmpdir(), 'pup-coverage-'));
    const reportPath = join(outDir, 'coverage.json');
    try {
      runCapability(measurePath, [
        ...capabilityRunnerPrefix(configPath),
        'pytest',
        '--cov',
        `--cov-report=json:${reportPath}`,
      ]);
      const raw = JSON.parse(readFileSync(reportPath, 'utf8')) as CoveragePyReport;
      return coveragePyToCoverageReport(raw, measurePath);
    } catch (error) {
      // A failed instrumented run (crash, timeout, failing tests) degrades to
      // "not measured" — the plain test stage has already gated correctness.
      return { unavailable: `instrumented pytest run failed: ${failureSummary(error)}` };
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  },
};
