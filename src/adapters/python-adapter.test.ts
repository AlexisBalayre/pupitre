import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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

  it('reports dead code as unmeasured when no config declares vulture', () => {
    const repo = makeRepo({ 'requirements.txt': 'requests\n' });

    expect(pythonAdapter.deadCode?.(repo)).toBeUndefined();
  });

  it('reports coverage as unmeasured when no config declares pytest-cov', () => {
    const repo = makeRepo({ 'pyproject.toml': '[project]\ndependencies = ["pytest"]\n' });

    expect(pythonAdapter.coverage?.(repo)).toBeUndefined();
  });
});
