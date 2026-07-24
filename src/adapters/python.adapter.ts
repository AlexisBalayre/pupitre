import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter, GateCommand, GateStage } from './types/adapter.types.js';

const PYTHON_MANIFESTS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'];

/** Regex for `compileall -x`: matches full paths, so venvs and vendored trees are skipped. */
const COMPILEALL_EXCLUDE = String.raw`\.venv|venv|node_modules|\.git|\.worktrees`;

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
 * Python toolchain (docs/06), v1 gate surface only: detect + build/test/lint.
 * depGraph and the debt capabilities are absent, so the code map and debt-delta
 * stages degrade to "not measured" until a later slice adds them. Config is
 * probed as raw text — the stack has no TOML parser (docs/08 gates new
 * dependencies), and a stray mention only ever adds a stage the repo's own
 * toolchain must then pass.
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
};
