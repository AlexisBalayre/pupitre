import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globToRegExp, globToRegExpSource } from '../core/glob.utils.js';
import { runGateChild } from '../core/sandbox.utils.js';
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

/**
 * Where pytest looks for `python_files`, in its own precedence order. The first
 * entry that claims the config wins, whether or not it sets this key.
 *
 * `pytest.ini` claims it by *existing*, even empty — that is pytest's own rule,
 * and modelling it as "carries `[pytest]`" is a parser differential the session
 * writes both sides of: an empty `pytest.ini` beside a `pyproject.toml` sends
 * pytest to the defaults while pup reads the pyproject, so a file the trusted
 * checkout calls a test is one pytest never collects, never runs, never covers.
 */
const PYTEST_CONFIGS: ReadonlyArray<[file: string, section: string, claimsByPresence: boolean]> = [
  ['pytest.ini', '[pytest]', true],
  ['pyproject.toml', '[tool.pytest.ini_options]', false],
  ['tox.ini', '[pytest]', false],
  ['setup.cfg', '[tool:pytest]', false],
];

/** pytest's built-in `python_files`, used when no config file redefines it. */
const PYTEST_DEFAULT_FILE_PATTERNS = ['test_*.py', '*_test.py'];

/**
 * A module name no naming convention should claim, carrying every character a
 * blanket can key on. A convention anchors at one end (`test_*.py`), so it
 * cannot match this; anything shaped "contains an X" must. A canary of ordinary
 * letters is not enough — the adversary reads it, and `*_*.py` matches nearly
 * all snake_case Python while missing any canary without an underscore.
 * The `.py` suffix is load-bearing: without it `*.py` would not match.
 */
const PYTEST_PATTERN_CANARY = 'zz_0123456789-abcdefghijklmnopqrstuvwxyz.py';

/**
 * Patterns honoured from one declaration. Nothing else bounds the list: it can
 * be one very long line, which the diff-size stage counts as a single changed
 * line, and each pattern costs a regex compile per changed file inside the
 * merge lock — a lock with no TTL, released by a `finally` a Ctrl-C'd process
 * never reaches.
 */
const PYTEST_MAX_PATTERNS = 64;

/**
 * Wildcards allowed in one pattern. Real conventions use one (`test_*.py`);
 * two covers `test_*_*.py`. The cap is a backtracking budget, not style:
 * `globToRegExp` maps `*` to `[^/]*`, and against a 254-character basename
 * `*a*a*a*a*b.py` runs for 41s, growing about 8x per added wildcard.
 */
const PYTEST_PATTERN_MAX_WILDCARDS = 2;

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

/** The body of `section` in `text`, up to the next section header. */
function sectionBody(text: string, section: string): string | undefined {
  const start = text.indexOf(section);
  if (start === -1) return undefined;
  const body = text.slice(start + section.length);
  const next = body.search(/^\s*\[/m);
  return next === -1 ? body : body.slice(0, next);
}

/**
 * Whether a declared pattern is honoured at all. Both checks answer a way the
 * exemption rule can be turned against the gate, and both answer it by dropping
 * the pattern, which leaves more files coverable:
 *
 * - **Over-broad.** `*.py` exempts every module from the coverage expectation.
 *   The trusted side is only trusted one merge deep, so a PR touching no `.py`
 *   file can plant a blanket there and switch decision 30's check off for good,
 *   silently: the operator just sees a skipped stage.
 * - **Not a pattern at all.** A wildcard is required, so a declaration cannot
 *   enumerate the production modules it wants exempted by name.
 * - **Over-complex.** A worktree pattern is attacker-authored input to a regex.
 *   The spin happens inside the merge lock, which is released in a `finally` a
 *   killed process never reaches, so it wedges every later merge in the repo.
 *
 * The budget counts wildcards in the *compiled* source, not in the pattern
 * text. `globToRegExpSource` swaps globstars for NUL-delimited sentinels before
 * expanding them, so a pattern carrying those sentinels literally — nothing
 * stops one reaching here from a config file — shows no `*` to a textual count
 * while compiling to as many as it likes. Order matters too: the budget gates
 * the canary match, so the check cannot itself become the payload.
 */
function isDiscoveryConvention(pattern: string): boolean {
  const source = globToRegExpSource(pattern);
  const wildcards = source.match(/\*/g)?.length ?? 0;
  return (
    wildcards >= 1 &&
    wildcards <= PYTEST_PATTERN_MAX_WILDCARDS &&
    !new RegExp(source).test(PYTEST_PATTERN_CANARY)
  );
}

/**
 * `python_files` as the checkout declares it, or pytest's defaults when it does
 * not. Text, not parsed: the stack has no TOML parser (docs/08 gates new
 * dependencies), and both the INI form (`python_files = a.py b.py`) and the
 * TOML array form tokenise the same way once brackets and quotes are stripped.
 *
 * A declaration that yields no usable patterns stays empty rather than falling
 * back to the defaults. Every failure here should widen what counts as
 * coverable, since the caller exempts a file only when both checkouts call it
 * a test.
 */
function pytestFilePatterns(repoPath: string): string[] {
  for (const [file, section, claimsByPresence] of PYTEST_CONFIGS) {
    if (!existsSync(join(repoPath, file))) continue;
    const body = sectionBody(readIfPresent(repoPath, file), section);
    if (body === undefined) {
      if (claimsByPresence) return PYTEST_DEFAULT_FILE_PATTERNS;
      continue;
    }
    const declared = /^[^\S\n]*python_files[^\S\n]*=([^\n]*(?:\n[^\S\n]+[^\n]*)*)/m.exec(body);
    if (!declared) return PYTEST_DEFAULT_FILE_PATTERNS;
    return (declared[1] as string)
      .replace(/[[\],'"]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, PYTEST_MAX_PATTERNS)
      .filter(isDiscoveryConvention);
  }
  return PYTEST_DEFAULT_FILE_PATTERNS;
}

/**
 * pytest's discovery conventions, which coverage.py omits from its report — the
 * gate must not expect a test file to be covered. `conftest.py` is pytest's own
 * special case and is never matched against `python_files`.
 *
 * fnmatch character classes (`test_[ab].py`) fall through globToRegExp's
 * escaping and simply fail to match, which lands on the coverable side.
 */
function isPythonTestFile(file: string, patterns: string[]): boolean {
  const name = file.split('/').at(-1) ?? '';
  return name === 'conftest.py' || patterns.some((pattern) => globToRegExp(pattern).test(name));
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
  const body = sectionBody(readIfPresent(repoPath, 'pyproject.toml'), VULTURE_SECTION);
  return body?.trim() ?? '';
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

function runCapability(ctx: CapabilityContext, words: string[], outDir?: string): string {
  const [command, ...args] = words;
  // Tool and config both come from the repo being measured, so the child runs
  // under the same seam as a gate stage: env allowlist plus sandbox (decisions
  // 28, 36). A report directory is passed explicitly — the sandbox's
  // default-allow does not survive a TMPDIR that sits under HOME.
  return runGateChild(command as string, args, {
    cwd: ctx.measurePath,
    writablePaths: [ctx.configPath, ...(outDir ? [outDir] : [])],
    gateEnv: ctx.gateEnv,
    timeout: DEBT_COMMAND_TIMEOUT_MS,
    maxBuffer: DEBT_COMMAND_MAX_BUFFER_BYTES,
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

  deadCode(ctx: CapabilityContext): DeadExport[] | CapabilityUnavailable {
    const { measurePath, configPath } = ctx;
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
        runCapability(ctx, [...capabilityRunnerPrefix(configPath), 'vulture', ...args]),
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

  coverableFiles({ measurePath, configPath }: CapabilityContext, files: string[]): string[] {
    // Exempt only what both checkouts call a test. python_files is redefinable,
    // so a worktree that narrows it turns test_payments.py into module code
    // pytest never collects and never covers, which the trusted defaults alone
    // would still wave through (decision 31).
    const trusted = pytestFilePatterns(configPath);
    const measured = pytestFilePatterns(measurePath);
    return files.filter(
      (file) =>
        file.endsWith('.py') &&
        !(isPythonTestFile(file, trusted) && isPythonTestFile(file, measured)) &&
        existsSync(join(measurePath, file)),
    );
  },

  coverage(ctx: CapabilityContext): CoverageReport | CapabilityUnavailable {
    const { measurePath, configPath } = ctx;
    if (!declaresTool(configPath, 'pytest-cov')) {
      return { unavailable: `no pytest-cov declared in ${PYTHON_CONFIGS.join(', ')}` };
    }
    const outDir = mkdtempSync(join(tmpdir(), 'pup-coverage-'));
    const reportPath = join(outDir, 'coverage.json');
    try {
      runCapability(
        ctx,
        [
          ...capabilityRunnerPrefix(configPath),
          'pytest',
          '--cov',
          `--cov-report=json:${reportPath}`,
        ],
        outDir,
      );
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
