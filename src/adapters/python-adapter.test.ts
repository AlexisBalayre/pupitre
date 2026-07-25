import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localContext } from './capability.utils.js';
import { pythonAdapter } from './python.adapter.js';

function makeRepo(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-py-')));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe('pythonAdapter', () => {
  it('detects a repo with a pyproject.toml', () => {
    expect(pythonAdapter.detect(makeRepo({ 'pyproject.toml': '[project]\nname = "x"\n' }))).toBe(
      true,
    );
  });

  it('detects a repo with only a requirements.txt', () => {
    expect(pythonAdapter.detect(makeRepo({ 'requirements.txt': 'requests\n' }))).toBe(true);
  });

  it('does not detect a repo without python manifests', () => {
    expect(pythonAdapter.detect(makeRepo({ 'package.json': '{}' }))).toBe(false);
  });

  it('emits only the compileall build check when nothing else is configured', () => {
    const repo = makeRepo({ 'requirements.txt': 'requests\n' });

    const commands = pythonAdapter.gateCommands(repo);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      stage: 'build',
      command: 'python3',
      args: expect.arrayContaining(['-m', 'compileall']),
    });
  });

  it('runs every stage through `uv run` when a uv.lock is present', () => {
    const repo = makeRepo({
      'pyproject.toml': [
        '[project]',
        'dependencies = ["requests"]',
        '[dependency-groups]',
        'dev = ["pytest", "ruff"]',
        '',
      ].join('\n'),
      'uv.lock': '',
    });

    expect(pythonAdapter.gateCommands(repo)).toEqual([
      {
        stage: 'build',
        command: 'uv',
        args: expect.arrayContaining(['run', 'python', '-m', 'compileall']),
      },
      { stage: 'test', command: 'uv', args: ['run', 'pytest'] },
      { stage: 'lint', command: 'uv', args: ['run', 'ruff', 'check', '.'] },
    ]);
  });

  it('runs configured stages through `poetry run` when a poetry.lock is present', () => {
    const repo = makeRepo({
      'pyproject.toml': '[tool.poetry]\nname = "x"\n[tool.pytest.ini_options]\n',
      'poetry.lock': '',
    });

    const commands = pythonAdapter.gateCommands(repo);

    expect(commands).toContainEqual({ stage: 'test', command: 'poetry', args: ['run', 'pytest'] });
  });

  it('resolves pytest and ruff from standalone config files', () => {
    const repo = makeRepo({
      'requirements.txt': 'requests\n',
      'pytest.ini': '[pytest]\n',
      'ruff.toml': '',
    });

    const stages = pythonAdapter.gateCommands(repo).map((c) => c.stage);

    expect(stages).toEqual(['build', 'test', 'lint']);
  });

  it('reports dead code as unmeasured, naming the tool, when no config declares vulture', () => {
    const repo = makeRepo({ 'requirements.txt': 'requests\n' });

    expect(pythonAdapter.deadCode?.(localContext(repo))).toEqual({
      unavailable: expect.stringContaining('vulture'),
    });
  });

  it('reports coverage as unmeasured, naming the tool, when no config declares pytest-cov', () => {
    const repo = makeRepo({ 'pyproject.toml': '[project]\ndependencies = ["pytest"]\n' });

    expect(pythonAdapter.coverage?.(localContext(repo))).toEqual({
      unavailable: expect.stringContaining('pytest-cov'),
    });
  });

  it('refuses to measure when the worktree rewrites the vulture config it would run under', () => {
    // vulture reads [tool.vulture] from its working directory, so a worktree
    // section could aim the scan at an empty path — a PASS on a fake empty
    // measurement, which would then ratchet the baseline to nothing.
    const configRepo = makeRepo({
      'pyproject.toml':
        '[project]\ndependencies = ["vulture"]\n\n[tool.vulture]\npaths = ["src"]\n',
    });
    const measureRepo = makeRepo({
      'pyproject.toml':
        '[project]\ndependencies = ["vulture"]\n\n[tool.vulture]\npaths = ["docs"]\n',
    });

    const result = pythonAdapter.deadCode?.({
      measurePath: measureRepo,
      configPath: configRepo,
    });

    expect(result).toEqual({ unavailable: expect.stringContaining('[tool.vulture]') });
  });

  it('measures when both checkouts carry the same vulture config', () => {
    const section = '[project]\ndependencies = ["vulture"]\n\n[tool.vulture]\npaths = ["src"]\n';
    const configRepo = makeRepo({ 'pyproject.toml': section });
    const measureRepo = makeRepo({ 'pyproject.toml': section });

    const result = pythonAdapter.deadCode?.({
      measurePath: measureRepo,
      configPath: configRepo,
    });

    // vulture is absent from the fixture, so the run fails — but it ran.
    expect(result).toEqual({ unavailable: expect.stringContaining('vulture failed') });
  });

  it('reads tool declarations from the config checkout, not the one being measured', () => {
    // The session's own manifest must not be able to silence a debt stage: it
    // drops vulture from its copy, the trusted checkout still declares it.
    const configRepo = makeRepo({ 'requirements.txt': 'vulture\n' });
    const measureRepo = makeRepo({ 'requirements.txt': 'requests\n' });

    const result = pythonAdapter.deadCode?.({
      measurePath: measureRepo,
      configPath: configRepo,
    });

    // vulture is not installed in the fixture, so the run fails — but it ran,
    // rather than being skipped as undeclared.
    expect(result).toEqual({ unavailable: expect.stringContaining('vulture failed') });
  });
});
