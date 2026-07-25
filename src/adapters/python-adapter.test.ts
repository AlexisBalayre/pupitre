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

  it('expects coverage only for modules, following pytest naming for what is a test', () => {
    const repo = makeRepo({
      'app.py': 'x = 1\n',
      'test_app.py': 'def test_x(): pass\n',
      'app_test.py': 'def test_x(): pass\n',
      'conftest.py': '',
      'README.md': '# docs\n',
    });

    const coverable = pythonAdapter.coverableFiles?.(localContext(repo), [
      'app.py',
      'test_app.py',
      'app_test.py',
      'conftest.py',
      'README.md',
    ]);

    expect(coverable).toEqual(['app.py']);
  });

  it('expects coverage for a test-named file the worktree stopped treating as a test', () => {
    // The escape decision 30 left open: pytest's python_files is redefinable, so
    // narrowing it in the worktree turns test_payments.py into ordinary module
    // code pytest never collects, never covers — and which pup, following the
    // defaults, would exempt from the coverage expectation entirely.
    const configRepo = makeRepo({ 'pyproject.toml': '[project]\nname = "x"\n' });
    const measureRepo = makeRepo({
      'pyproject.toml':
        '[project]\nname = "x"\n\n[tool.pytest.ini_options]\npython_files = ["check_*.py"]\n',
      'test_payments.py': 'RATE = 0.2\n',
    });

    const coverable = pythonAdapter.coverableFiles?.(
      { measurePath: measureRepo, configPath: configRepo },
      ['test_payments.py'],
    );

    expect(coverable).toEqual(['test_payments.py']);
  });

  it('exempts a test file both checkouts agree on under a custom python_files', () => {
    const pyproject =
      '[project]\nname = "x"\n\n[tool.pytest.ini_options]\npython_files = ["check_*.py"]\n';
    const configRepo = makeRepo({ 'pyproject.toml': pyproject });
    const measureRepo = makeRepo({
      'pyproject.toml': pyproject,
      'check_app.py': 'def check_x(): pass\n',
      'app.py': 'x = 1\n',
    });

    const coverable = pythonAdapter.coverableFiles?.(
      { measurePath: measureRepo, configPath: configRepo },
      ['check_app.py', 'app.py'],
    );

    expect(coverable).toEqual(['app.py']);
  });

  it('reads python_files spread across a multi-line TOML array', () => {
    const pyproject = [
      '[tool.pytest.ini_options]',
      'python_files = [',
      '    "check_*.py",',
      '    "*_check.py",',
      ']',
      '',
      '[tool.other]',
      'python_files = ["never_*.py"]',
    ].join('\n');
    const repo = makeRepo({
      'pyproject.toml': pyproject,
      'check_app.py': '',
      'app_check.py': '',
      'never_app.py': '',
    });

    const coverable = pythonAdapter.coverableFiles?.(localContext(repo), [
      'check_app.py',
      'app_check.py',
      'never_app.py',
    ]);

    expect(coverable).toEqual(['never_app.py']);
  });

  it('ignores a blanket python_files even when both checkouts carry it', () => {
    // Otherwise one merged pyproject.toml edit, in a PR touching no .py file
    // and so passing the coverage stage as a skip, exempts every module from
    // then on and switches decision 30's check off for good.
    const pyproject = '[tool.pytest.ini_options]\npython_files = ["*.py"]\n';
    const configRepo = makeRepo({ 'pyproject.toml': pyproject });
    const measureRepo = makeRepo({ 'pyproject.toml': pyproject, 'payments.py': 'RATE = 0.2\n' });

    const coverable = pythonAdapter.coverableFiles?.(
      { measurePath: measureRepo, configPath: configRepo },
      ['payments.py'],
    );

    expect(coverable).toEqual(['payments.py']);
  });

  it('ignores a python_files pattern built to backtrack, rather than running it', () => {
    // globToRegExp maps `*` to `[^/]*`; unbudgeted, this pattern against this
    // basename runs for ~41s inside the merge lock, whose release is a
    // `finally` that a Ctrl-C'd process never reaches.
    const name = `test_${'a'.repeat(246)}.py`;
    const configRepo = makeRepo({ 'pyproject.toml': '[project]\nname = "x"\n' });
    const measureRepo = makeRepo({
      'pyproject.toml': '[tool.pytest.ini_options]\npython_files = ["*a*a*a*a*b.py"]\n',
      [name]: 'RATE = 0.2\n',
    });

    const started = Date.now();
    const coverable = pythonAdapter.coverableFiles?.(
      { measurePath: measureRepo, configPath: configRepo },
      [name],
    );

    expect(coverable).toEqual([name]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('budgets wildcards the compiled pattern really has, not the ones it shows', () => {
    // globToRegExpSource swaps globstars for NUL-delimited sentinels before
    // expanding them, so a pattern carrying those sentinels literally shows no
    // `*` to a textual count while compiling to four. Picking letters the
    // canary lacks gets it past the blanket check too, leaving a targeted
    // exemption for exactly the file being hidden.
    const s = '\u0000g\u0000';
    const pyproject = `[tool.pytest.ini_options]\npython_files = ["${s}m${s}e${s}t${s}s.py"]\n`;
    const configRepo = makeRepo({ 'pyproject.toml': pyproject });
    const measureRepo = makeRepo({ 'pyproject.toml': pyproject, 'payments.py': 'RATE = 0.2\n' });

    const coverable = pythonAdapter.coverableFiles?.(
      { measurePath: measureRepo, configPath: configRepo },
      ['payments.py'],
    );

    expect(coverable).toEqual(['payments.py']);
  });

  it('follows pytest in letting an empty pytest.ini outrank pyproject.toml', () => {
    // pytest.ini wins by existing, even empty, so pytest reverts to its default
    // python_files while pup, reading the pyproject both checkouts share, would
    // agree the file is a test. Nothing collects check_payments.py, nothing
    // covers it, and the two checkouts never visibly disagree.
    const pyproject = '[tool.pytest.ini_options]\npython_files = ["check_*.py"]\n';
    const configRepo = makeRepo({ 'pyproject.toml': pyproject });
    const measureRepo = makeRepo({
      'pyproject.toml': pyproject,
      'pytest.ini': '',
      'check_payments.py': 'RATE = 0.2\n',
    });

    const coverable = pythonAdapter.coverableFiles?.(
      { measurePath: measureRepo, configPath: configRepo },
      ['check_payments.py'],
    );

    expect(coverable).toEqual(['check_payments.py']);
  });

  it('ignores a near-blanket that merely dodges one canary character', () => {
    // `*_*.py` claims nearly all snake_case Python while matching no canary
    // built from ordinary letters, so the blanket check has to key on the
    // whole character class a pattern could exploit, not one sample name.
    const pyproject = '[tool.pytest.ini_options]\npython_files = ["*_*.py"]\n';
    const configRepo = makeRepo({ 'pyproject.toml': pyproject });
    const measureRepo = makeRepo({
      'pyproject.toml': pyproject,
      'payment_service.py': 'RATE = 0.2\n',
    });

    const coverable = pythonAdapter.coverableFiles?.(
      { measurePath: measureRepo, configPath: configRepo },
      ['payment_service.py'],
    );

    expect(coverable).toEqual(['payment_service.py']);
  });

  it('ignores a python_files that just names the modules it wants exempted', () => {
    const pyproject =
      '[tool.pytest.ini_options]\npython_files = ["test_*.py", "payments.py", "billing.py"]\n';
    const configRepo = makeRepo({ 'pyproject.toml': pyproject });
    const measureRepo = makeRepo({
      'pyproject.toml': pyproject,
      'payments.py': 'RATE = 0.2\n',
      'billing.py': 'RATE = 0.3\n',
    });

    const coverable = pythonAdapter.coverableFiles?.(
      { measurePath: measureRepo, configPath: configRepo },
      ['payments.py', 'billing.py'],
    );

    expect(coverable).toEqual(['payments.py', 'billing.py']);
  });

  it('exempts conftest.py whatever python_files says, as pytest does', () => {
    const configRepo = makeRepo({ 'pyproject.toml': '[project]\nname = "x"\n' });
    const measureRepo = makeRepo({
      'pytest.ini': '[pytest]\npython_files = check_*.py\n',
      'conftest.py': '',
    });

    const coverable = pythonAdapter.coverableFiles?.(
      { measurePath: measureRepo, configPath: configRepo },
      ['conftest.py'],
    );

    expect(coverable).toEqual([]);
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
