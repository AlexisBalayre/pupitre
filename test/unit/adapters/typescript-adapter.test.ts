import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

// The real mkdirSync and rmSync, wrapped so one test can make the report
// directory's creation fail and another can act midway through a removal.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync), rmSync: vi.fn(actual.rmSync) };
});

import { localContext } from '@src/adapters/capability.utils.js';
import { diskRoot } from '@src/adapters/root-files.utils.js';
import type { DeadExport, DuplicationReport } from '@src/adapters/types/adapter.types.js';
import type { IstanbulCoverageMap } from '@src/adapters/types/istanbul.types.js';
import { rootCoverageReport, typescriptAdapter } from '@src/adapters/typescript.adapter.js';
import { endSandboxRun, runGateChild, sandboxLabel } from '@src/core/sandbox.utils.js';
import { sh } from '@test/helpers/git.mock.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';

function makeRepo(files: Record<string, string>): string {
  const dir = tempDir('pup-adapter-');
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe('typescriptAdapter', () => {
  it('detects a repo with a typescript devDependency', () => {
    const repo = makeRepo({
      'package.json': JSON.stringify({ devDependencies: { typescript: '^5' } }),
    });
    expect(typescriptAdapter.detect(repo)).toBe(true);
  });

  it('does not detect a repo without package.json', () => {
    expect(typescriptAdapter.detect(makeRepo({}))).toBe(false);
  });

  it("resolves the repo's own scripts through the detected package manager", () => {
    const repo = makeRepo({
      'package.json': JSON.stringify({
        scripts: { build: 'tsc', test: 'vitest run', lint: 'biome check .' },
      }),
      'pnpm-lock.yaml': '',
    });
    expect(typescriptAdapter.gateCommands(repo)).toEqual([
      { stage: 'build', command: 'pnpm', args: ['run', 'build'] },
      { stage: 'test', command: 'pnpm', args: ['run', 'test'] },
      { stage: 'lint', command: 'pnpm', args: ['run', 'lint'] },
    ]);
  });

  it('falls back to tsc --noEmit for build and omits unmeasurable stages', () => {
    const repo = makeRepo({
      'package.json': JSON.stringify({ devDependencies: { typescript: '^5' } }),
      'tsconfig.json': '{}',
    });
    expect(typescriptAdapter.gateCommands(repo)).toEqual([
      { stage: 'build', command: 'npx', args: ['--no-install', 'tsc', '--noEmit'] },
    ]);
  });

  it('emits no build fallback when typescript is not a declared dependency', () => {
    const repo = makeRepo({
      'package.json': JSON.stringify({ private: true }),
      'tsconfig.json': '{}',
    });
    expect(typescriptAdapter.gateCommands(repo)).toEqual([]);
  });
});

// One run answers for the test stage and for coverage only when it is the run
// the test script makes (decision 95).
describe('typescriptAdapter.coveredTest', () => {
  const manifest = (scripts: Record<string, string>): string =>
    JSON.stringify({ scripts, devDependencies: { vitest: '^4', '@vitest/coverage-v8': '^4' } });
  /** A repo whose install left the vitest binary the folded run starts. */
  const installedRepo = (files: Record<string, string>): string => {
    const dir = makeRepo(files);
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '.bin', 'vitest'), '');
    return dir;
  };
  const coveredTestIn = (files: Record<string, string>) => {
    const run = typescriptAdapter.coveredTest?.(localContext(installedRepo(files)));
    run?.dispose();
    return run;
  };

  it.each(['vitest', 'vitest run', ' vitest run '])('folds a %j test script', (test) => {
    const run = coveredTestIn({ 'package.json': manifest({ test }) });

    expect(run?.command).toBe('npx');
    expect(run?.args.slice(0, 4)).toEqual(['--no-install', 'vitest', 'run', '--coverage.enabled']);
  });

  it.each<[string, Record<string, string>]>([
    ['a test script with flags', { 'package.json': manifest({ test: 'vitest run --bail=1' }) }],
    ['another runner', { 'package.json': manifest({ test: 'jest' }) }],
    ['a pretest script', { 'package.json': manifest({ test: 'vitest run', pretest: 'tsc' }) }],
    ['a posttest script', { 'package.json': manifest({ test: 'vitest', posttest: 'echo' }) }],
    [
      'no coverage provider',
      {
        'package.json': JSON.stringify({
          scripts: { test: 'vitest run' },
          devDependencies: { vitest: '^4' },
        }),
      },
    ],
    [
      'coverage thresholds in the vitest config',
      {
        'package.json': manifest({ test: 'vitest run' }),
        'vitest.config.ts': 'export default { test: { coverage: { thresholds: { lines: 80 } } } };',
      },
    ],
  ])('keeps the two runs apart for %s', (_, files) => {
    expect(coveredTestIn(files)).toBeUndefined();
  });

  it('keeps the two runs apart for an install with no vitest binary, as Plug-n-Play leaves', () => {
    const repo = makeRepo({ 'package.json': manifest({ test: 'vitest run' }) });

    expect(typescriptAdapter.coveredTest?.(localContext(repo))).toBeUndefined();
  });

  // The gate's test stage ran `pm run test` in the session's checkout, so a
  // session's own script or threshold is what the folded run must match.
  it.each<[string, Record<string, string>]>([
    ['a test script', { 'package.json': manifest({ test: 'vitest run && playwright test' }) }],
    ['a pretest script', { 'package.json': manifest({ test: 'vitest run', pretest: 'gen' }) }],
    [
      'coverage thresholds',
      {
        'package.json': manifest({ test: 'vitest run' }),
        'vitest.config.ts': 'export default { test: { coverage: { thresholds: { lines: 80 } } } };',
      },
    ],
    ['an unreadable manifest', { 'package.json': '{' }],
  ])('keeps the two runs apart when the session adds %s', (_, files) => {
    const configPath = makeRepo({ 'package.json': manifest({ test: 'vitest run' }) });
    const run = typescriptAdapter.coveredTest?.({ configPath, measurePath: installedRepo(files) });
    run?.dispose();

    expect(run).toBeUndefined();
  });

  // The session's build runs before the fold is decided and may leave a fifo
  // where its manifest was; opening it for a plain read would block pup.
  it('declines to fold, without blocking, when the session left a fifo for its manifest', () => {
    const configPath = makeRepo({ 'package.json': manifest({ test: 'vitest run' }) });
    const measurePath = installedRepo({});
    execFileSync('mkfifo', [join(measurePath, 'package.json')]);

    expect(typescriptAdapter.coveredTest?.({ configPath, measurePath })).toBeUndefined();
  });

  it('removes its own directory and throws when the report directory cannot be made', () => {
    const repo = installedRepo({ 'package.json': manifest({ test: 'vitest run' }) });
    let holder = '';
    vi.mocked(mkdirSync).mockImplementationOnce((path) => {
      holder = dirname(String(path));
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });

    expect(() => typescriptAdapter.coveredTest?.(localContext(repo))).toThrow('EACCES');
    expect(basename(holder)).toMatch(/^pup-coverage-/);
    expect(existsSync(holder)).toBe(false);
  });

  it('writes its report outside the checkout, in a directory dispose removes', () => {
    const repo = installedRepo({
      'package.json': manifest({ test: 'vitest run' }),
      'vitest.config.ts': "export default { test: { include: ['src/**/*.test.ts'] } };",
    });
    const run = typescriptAdapter.coveredTest?.(localContext(repo));
    const [outDir = ''] = run?.writablePaths ?? [];

    expect(existsSync(outDir)).toBe(true);
    expect(outDir.startsWith(repo)).toBe(false);
    // Before any run there is no report to read.
    expect(run?.report()).toEqual({
      unavailable: expect.stringContaining('instrumented vitest run failed'),
    });
    run?.dispose();
    expect(existsSync(outDir)).toBe(false);
  });

  // Asserts pup's own profile, so only where pup applied it rather than
  // running inside an outer one, as under its own gate.
  describe.runIf(sandboxLabel() === 'sandbox-exec (macOS)')('under the gate sandbox', () => {
    // A test worker never emits the `exit` that ends the run its children started.
    afterEach(() => {
      endSandboxRun();
    });
    /** A folded run's report directory, as vitest is handed it, and a child run with its grants. */
    const foldedRun = () => {
      const repo = installedRepo({ 'package.json': manifest({ test: 'vitest run' }) });
      const run = typescriptAdapter.coveredTest?.(localContext(repo));
      if (!run) throw new Error('expected a folded run');
      onTestFinished(() => run.dispose());
      const flag = '--coverage.reportsDirectory=';
      const reports = run.args.find((arg) => arg.startsWith(flag))?.slice(flag.length) ?? '';
      const child = (script: string, ...rest: string[]) =>
        runGateChild('sh', ['-c', script, 'sh', reports, ...rest], {
          cwd: repo,
          repoPath: repo,
          writablePaths: run.writablePaths,
        });
      return { run, reports, child };
    };

    // A failing first run removes its empty report directory (vitest's
    // `cleanAfterRun`), and the re-run's `clean` makes it again: that mkdir
    // was the gate's EPERM.
    it('lets the re-run of a failed test stage make its report directory again', async () => {
      const { reports, child } = foldedRun();

      await child('rm -r -f "$1"');
      expect(existsSync(reports)).toBe(false);
      await child('mkdir -p "$1/.tmp" && printf ok > "$1/coverage-final.json"');

      expect(readFileSync(join(reports, 'coverage-final.json'), 'utf8')).toBe('ok');
    });

    // The session's own test fails on purpose and its exit handler swaps the
    // report directory for a link; the re-run must not be granted the target.
    it('grants the re-run the report directory, not where a link left there points', async () => {
      const { child } = foldedRun();
      const target = tempDir('pup-link-target-');

      await child('rm -r -f "$1" && ln -s "$2" "$1"', target);
      await expect(child('printf x > "$1/escaped"')).rejects.toThrow(/Operation not permitted/);

      expect(existsSync(join(target, 'escaped'))).toBe(false);
    });

    it("cannot remove the directory holding the report, so its name stays the gate's", async () => {
      const { reports, child } = foldedRun();
      expect(basename(dirname(reports))).toMatch(/^pup-coverage-/);

      await expect(child('rm -r -f "$1" && rmdir "$(dirname "$1")"')).rejects.toThrow(
        /Operation not permitted/,
      );
      expect(existsSync(dirname(reports))).toBe(true);
    });

    // A stage's helper that left its group survives the kill, still under the
    // profile that granted `report`, and swaps it for a link to HOME while
    // dispose deletes the holder (decision 155).
    it('deletes the holder where a helper still holding the report grant plants no link', async () => {
      const { run, reports, child } = foldedRun();
      const target = tempDir('pup-link-target-');
      writeFileSync(join(target, 'keep'), 'x');
      const scratch = await child('printf %s "$TMPDIR"');
      const helper = child(
        'while [ ! -e "$TMPDIR/go" ]; do sleep 0.05; done; rm -r -f "$1"; mkdir -p "$(dirname "$1")"; ln -s "$2" "$1" && printf planted > "$TMPDIR/done" || printf refused > "$TMPDIR/done"',
        target,
      );
      vi.mocked(rmSync).mockImplementationOnce((path, options) => {
        writeFileSync(join(scratch, 'go'), '');
        const tick = new Int32Array(new SharedArrayBuffer(4));
        for (let waited = 0; !existsSync(join(scratch, 'done')) && waited < 10_000; waited += 50) {
          Atomics.wait(tick, 0, 0, 50);
        }
        rmSync(path, options);
      });

      run.dispose();
      await helper;

      expect(readFileSync(join(scratch, 'done'), 'utf8')).toBe('refused');
      expect(existsSync(dirname(reports))).toBe(false);
      expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('x');
    });
  });
});

// The diff-size split counts as test only what the test stage's vitest run
// collects, read from both checkouts (decision 143); what one config collects
// is vitest-config.utils.ts's, tested there.
describe('typescriptAdapter.testFiles', () => {
  const plainVitest = JSON.stringify({ scripts: { test: 'vitest run' } });

  // The run reads the user's own .npmrc, so the operator's would decide these.
  beforeEach(() => {
    vi.stubEnv('HOME', tempDir('pup-home-'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const configWith = (test: string): string =>
    `import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({\n  test: ${test},\n});\n`;

  it('collects only what the include names, so a .test.ts outside it is not a test', () => {
    const repo = makeRepo({
      'package.json': plainVitest,
      'vitest.config.ts': configWith("{ include: ['src/**/*.test.ts'] }"),
    });

    expect(
      typescriptAdapter.testFiles?.(localContext(repo), [
        'src/a.test.ts',
        'src/deep/b.test.ts',
        'scripts/x.test.ts',
        'src/a.ts',
      ]),
    ).toEqual(['src/a.test.ts', 'src/deep/b.test.ts']);
  });

  // Each row is the trusted checkout's, beside a measured one that collects the
  // file, so a row fails if its refusal is deleted.
  it.each([
    ['a test script that narrows the run', { test: 'vitest run src/core' }],
    ['another runner', { test: 'jest' }],
    ['a pretest script', { test: 'vitest run', pretest: 'node prep.js' }],
    ['a posttest script', { test: 'vitest run', posttest: 'node report.js' }],
  ])('collects nothing under %s', (_, scripts) => {
    const configPath = makeRepo({ 'package.json': JSON.stringify({ scripts }) });
    const measurePath = makeRepo({ 'package.json': plainVitest });

    expect(typescriptAdapter.testFiles?.({ configPath, measurePath }, ['src/a.test.ts'])).toEqual(
      [],
    );
  });

  it('collects nothing beside a manifest that cannot be read', () => {
    const repo = makeRepo({ 'package.json': '{ not json' });

    expect(typescriptAdapter.testFiles?.(localContext(repo), ['src/a.test.ts'])).toEqual([]);
  });

  // Vitest runs the branch's config, so its lists are read only where the rest
  // of it is the trusted one's; a config that runs code runs the same code.
  const runsCode = configWith(
    "{ include: ['src/**/*.test.ts'], maxWorkers: Math.max(2, availableParallelism()) }",
  ).replace(/^/, "import { availableParallelism } from 'node:os';\n");

  it.each([
    ['the same config, which runs code', runsCode, ['src/a.test.ts']],
    ['a config setting another key', runsCode.replace('maxWorkers', 'retry: 2, maxWorkers'), []],
    ['a config changing a value', runsCode.replace('Math.max(2', 'Math.max(1'), []],
    [
      'a config adding a setup file',
      runsCode.replace('maxWorkers', "setupFiles: ['./setup.ts'], maxWorkers"),
      [],
    ],
  ])('reads the branch checkout holding %s', (_, branchConfig, expected) => {
    const configPath = makeRepo({ 'package.json': plainVitest, 'vitest.config.ts': runsCode });
    const measurePath = makeRepo({ 'package.json': plainVitest, 'vitest.config.ts': branchConfig });

    expect(typescriptAdapter.testFiles?.({ configPath, measurePath }, ['src/a.test.ts'])).toEqual(
      expected,
    );
  });

  // The script runs under the branch's package-manager configs, which can have
  // it load a file of the branch's own, even where they are the target's.
  it.each([
    ['the same .npmrc on both sides', { '.npmrc': 'engine-strict=true\n' }, {}, ['src/a.test.ts']],
    ['an .npmrc only the branch commits', {}, { '.npmrc': 'engine-strict=true\n' }, []],
    [
      'an .npmrc the branch rewrites',
      { '.npmrc': 'engine-strict=true\n' },
      { '.npmrc': 'engine-strict=false\n' },
      [],
    ],
    ['an .env.yarn only the branch commits', {}, { '.env.yarn': 'CI=1\n' }, []],
    ['an .env only the branch commits', {}, { '.env': 'CI=1\n' }, []],
    [
      'an .npmrc on both sides substituting a token in a value',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: npm's own substitution, not a JS template
      { '.npmrc': '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n' },
      {},
      ['src/a.test.ts'],
    ],
    [
      'an .env on both sides naming a variable in a comment',
      { '.env.example': '# under $HOME\nVAULT="$HOME/notes"\n' },
      {},
      ['src/a.test.ts'],
    ],
    [
      'plainly keyed configs on both sides',
      {
        '.npmrc':
          'save-prefix=~\nregistry = https://registry.npmjs.org/\n@scope:registry=https://npm.example.com/\n[scope]\nfund=false\n',
        '.env': 'export CI=1\nNODE_ENV=test\n',
      },
      {},
      ['src/a.test.ts'],
    ],
    [
      'an .npmrc on both sides with plain array keys',
      { '.npmrc': 'public-hoist-pattern[]=*eslint*\nonly-built-dependencies[]=esbuild\n' },
      {},
      ['src/a.test.ts'],
    ],
    ["yarn's Plug'n'Play runtime on both sides", { '.pnp.cjs': 'module.exports = {};\n' }, {}, []],
    ["pnpm's hooks file on both sides", { '.pnpmfile.cjs': 'module.exports = {};\n' }, {}, []],
    [
      'a pnpm hooks file only the branch commits',
      {},
      { '.pnpmfile.mjs': "process.env.NODE_OPTIONS = '--import ./reg.mjs';\n" },
      [],
    ],
    ...[
      ['.npmrc', 'node-options=--import ./scripts/reg.mjs\n'],
      ['.npmrc', 'node_options=--import ./scripts/reg.mjs\n'],
      ['.npmrc', 'script-shell=./scripts/sh\n'],
      ['.yarnrc', 'yarn-path "./scripts/yarn.js"\n'],
      ['.yarnrc.yml', 'yarnPath: .yarn/releases/yarn.cjs\n'],
      ['.yarnrc.yml', 'plugins:\n  - path: .yarn/plugins/p.cjs\n'],
      ['.yarnrc.yml', 'injectEnvironmentFiles:\n  - .env.ci\n'],
      ['.env.yarn', 'NODE_OPTIONS=--import ./scripts/reg.mjs\n'],
      ['pnpm-workspace.yaml', 'nodeOptions: --import ./scripts/reg.mjs\n'],
      ['bunfig.toml', 'preload = ["./scripts/reg.ts"]\n'],
      ['.npmrc', 'pnpmfile=./scripts/hooks.cjs\n'],
      ['pnpm-workspace.yaml', 'globalPnpmfile: ./scripts/hooks.cjs\n'],
      ['.env', 'NODE_OPTIONS=--import ./scripts/reg.mjs\n'],
      ['.env.local', 'NODE_OPTIONS=--import ./scripts/reg.mjs\n'],
      // Keys that have npm read a config nothing here checks.
      ['.npmrc', 'globalconfig=./scripts/npmrc\n'],
      ['.env', 'NPM_CONFIG_GLOBALCONFIG=./scripts/npmrc\n'],
      ['.env', 'export npm_config_prefix=./scripts\n'],
      ['.env', '\u00A0NPM_CONFIG_PREFIX\u00A0=./scripts\n'],
      ['.env', 'DESTDIR=./scripts\n'],
      ['.env.local', 'export\tDESTDIR=./scripts\n'],
      // Escaped or substituted keys, which their package manager reads as the key.
      ['.yarnrc.yml', '"yarn\\u0050ath": .yarn/releases/yarn.cjs\n'],
      ['pnpm-workspace.yaml', '"node\\u004Fptions": --import ./scripts/reg.mjs\n'],
      ['bunfig.toml', '"pre\\u006Coad" = ["./scripts/reg.ts"]\n'],
      ['.npmrc', '"node\\u002doptions"=--import ./scripts/reg.mjs\n'],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: npm's own substitution, not a JS template
      ['.npmrc', '${KEY}=--import ./scripts/reg.mjs\n'],
      // Keys not plainly spelt, which ini reads through JSON and dotenv after a line break.
      ['.npmrc', ' "globalconfig"=./scripts/npmrc\n'],
      ['.npmrc', '[ "prefix" ]=./scripts\n'],
      ['.npmrc', '[ prefix ]\nfund=false\n'],
      ['.env', 'CI=1\u2028NPM_CONFIG_GLOBALCONFIG=./scripts/npmrc\n'],
      ['.env', 'CI=1\u2029"FOO BAR"=1\n'],
    ].map(
      ([name, text]) =>
        [`a target ${name} that runs a file`, { [name as string]: text }, {}, []] as const,
    ),
  ] as [string, Record<string, string>, Record<string, string>, string[]][])(
    'reads the package-manager configs of %s',
    (_, both, branchOnly, expected) => {
      const files = {
        'package.json': plainVitest,
        'vitest.config.ts': configWith("{ include: ['src/**/*.test.ts'] }"),
        ...both,
      };
      const configPath = makeRepo(files);
      const measurePath = makeRepo({ ...files, ...branchOnly });

      expect(typescriptAdapter.testFiles?.({ configPath, measurePath }, ['src/a.test.ts'])).toEqual(
        expected,
      );
    },
  );

  // Every manifest field but the dependency maps and the scripts may shape the
  // run, so the branch's must be the target's.
  it.each([
    ['a devDependency', { devDependencies: { zod: '^4' } }, ['src/a.test.ts']],
    ['another script', { scripts: { test: 'vitest run', lint: 'biome check' } }, ['src/a.test.ts']],
    ['a packageManager', { packageManager: 'yarn@4.5.0' }, []],
    ['a pnpm block', { pnpm: { executionEnv: { nodeVersion: '18.0.0' } } }, []],
    ['a module type', { type: 'module' }, []],
    ['subpath imports', { imports: { '#vitest': './fake.js' } }, []],
  ])('reads a branch manifest that adds %s', (_, fields, expected) => {
    const config = configWith("{ include: ['src/**/*.test.ts'] }");
    const configPath = makeRepo({ 'package.json': plainVitest, 'vitest.config.ts': config });
    const measurePath = makeRepo({
      'package.json': JSON.stringify({ scripts: { test: 'vitest run' }, ...fields }),
      'vitest.config.ts': config,
    });

    expect(typescriptAdapter.testFiles?.({ configPath, measurePath }, ['src/a.test.ts'])).toEqual(
      expected,
    );
  });

  // Every root entry shaped like a tool's config is compared whole, whichever
  // tool loads it by convention; a module one, or PostCSS's, loads by what it names.
  it.each([
    [
      'a postcss.config.mjs only the branch commits',
      {},
      { 'postcss.config.mjs': 'export default {};\n' },
      [],
    ],
    [
      'a tsconfig.json only the branch changes',
      { 'tsconfig.json': '{}\n' },
      { 'tsconfig.json': '{ "compilerOptions": { "jsx": "react-jsx" } }\n' },
      [],
    ],
    ['a .babelrc only the branch commits', {}, { '.babelrc': '{}\n' }, []],
    ['a browserslist only the branch commits', {}, { browserslist: 'defaults\n' }, []],
    [
      'a lockfile only the branch changes',
      { 'pnpm-lock.yaml': 'a\n' },
      { 'pnpm-lock.yaml': 'b\n' },
      [],
    ],
    [
      'a tool config only the branch commits',
      {},
      { 'tailwind.config.js': 'export default {};\n' },
      [],
    ],
    [
      'a README and a source file only the branch changes',
      {},
      { 'README.md': 'x\n', 'out.js': 'x\n' },
      ['src/a.test.ts'],
    ],
    ['a tsconfig.json on both sides', { 'tsconfig.json': '{}\n' }, {}, ['src/a.test.ts']],
    [
      'a .postcssrc.json on both sides',
      { '.postcssrc.json': '{ "plugins": { "./p.cjs": {} } }\n' },
      {},
      [],
    ],
    [
      'a postcss.config.js on both sides',
      { 'postcss.config.js': 'export default { plugins: {} };\n' },
      {},
      [],
    ],
    [
      'a postcss field on both sides',
      { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' }, postcss: {} }) },
      {},
      [],
    ],
    [
      'a tool config on both sides importing a file',
      { 'eslint.config.js': "import rules from './rules.js';\nexport default [rules];\n" },
      {},
      [],
    ],
    [
      'a tool config on both sides requiring a package',
      { '.eslintrc.cjs': "module.exports = require('x');\n" },
      {},
      [],
    ],
    [
      'a tool config on both sides that does not parse',
      { 'prettier.config.js': 'export default {\n' },
      {},
      [],
    ],
    [
      'a tool config on both sides importing a package',
      { 'eslint.config.js': "import js from '@eslint/js';\nexport default [js];\n" },
      {},
      ['src/a.test.ts'],
    ],
    // Named in another case, which a case-insensitive disk opens for the lower-case name.
    ['a .PostCSSrc on both sides', { '.PostCSSrc': '{}\n' }, {}, []],
    ['a Postcss.config.js only the branch commits', {}, { 'Postcss.config.js': 'x\n' }, []],
    ['a TSCONFIG.JSON only the branch commits', {}, { 'TSCONFIG.JSON': '{}\n' }, []],
  ] as [string, Record<string, string>, Record<string, string>, string[]][])(
    'reads the root configs of %s',
    (_, both, branchOnly, expected) => {
      const files = {
        'package.json': plainVitest,
        'vitest.config.ts': configWith("{ include: ['src/**/*.test.ts'] }"),
        ...both,
      };
      const configPath = makeRepo(files);
      const measurePath = makeRepo({ ...files, ...branchOnly });

      expect(typescriptAdapter.testFiles?.({ configPath, measurePath }, ['src/a.test.ts'])).toEqual(
        expected,
      );
    },
  );

  // A directory is read whole: lilconfig and cosmiconfig search `.config`.
  it.each([
    ['a .github directory only the branch changes', '.github', 'ci.yml', false, []],
    ['a .github directory on both sides', '.github', 'ci.yml', true, ['src/a.test.ts']],
    ['a .config directory on both sides', '.config', 'postcssrc.json', true, []],
  ] as [string, string, string, boolean, string[]][])(
    'reads the root of %s',
    (_, dir, file, shared, expected) => {
      const files = {
        'package.json': plainVitest,
        'vitest.config.ts': configWith("{ include: ['src/**/*.test.ts'] }"),
      };
      const configPath = makeRepo(files);
      const measurePath = makeRepo(files);
      for (const [repo, text] of [
        [configPath, 'a\n'],
        [measurePath, shared ? 'a\n' : 'b\n'],
      ] as const) {
        mkdirSync(join(repo, dir));
        writeFileSync(join(repo, dir, file), text);
      }

      expect(typescriptAdapter.testFiles?.({ configPath, measurePath }, ['src/a.test.ts'])).toEqual(
        expected,
      );
    },
  );

  // Vite redirects `@src/x` too, so an alias of a scope node_modules holds
  // hands its packages to the branch.
  it.each([
    ['no such scope', [], ['src/a.test.ts']],
    ['an @src scope', ['@src'], []],
  ])('reads an @src alias beside a trusted node_modules holding %s', (_, scopes, expected) => {
    const files = {
      'package.json': plainVitest,
      'vitest.config.ts':
        "import { defineConfig } from 'vitest/config';\n" +
        "export default defineConfig({ resolve: { alias: { '@src': './src' } }, test: { include: ['src/**/*.test.ts'] } });\n",
    };
    const configPath = makeRepo(files);
    for (const scope of scopes)
      mkdirSync(join(configPath, 'node_modules', scope), { recursive: true });

    expect(
      typescriptAdapter.testFiles?.({ configPath, measurePath: makeRepo(files) }, [
        'src/a.test.ts',
      ]),
    ).toEqual(expected);
  });

  // Vite's most common alias: a bare `@` redirects only `@/...`, which no package is named.
  it('reads a bare @ alias', () => {
    const files = {
      'package.json': plainVitest,
      'vitest.config.ts':
        "import { defineConfig } from 'vitest/config';\n" +
        "export default defineConfig({ resolve: { alias: { '@': './src' } }, test: { include: ['src/**/*.test.ts'] } });\n",
    };

    expect(
      typescriptAdapter.testFiles?.({ configPath: makeRepo(files), measurePath: makeRepo(files) }, [
        'src/a.test.ts',
      ]),
    ).toEqual(['src/a.test.ts']);
  });

  // Vitest then loads the first config in a directory above, which a session can write.
  it('collects nothing with no config at the root', () => {
    const repo = makeRepo({ 'package.json': plainVitest });

    expect(typescriptAdapter.testFiles?.(localContext(repo), ['src/a.test.ts'])).toEqual([]);
  });

  // APFS folds `ſ` onto `s`, so vitest opens the branch's file for vitest.config.ts.
  it('collects nothing where the branch root holds a name outside ASCII', () => {
    const files = {
      'package.json': plainVitest,
      'vite.config.ts': configWith("{ include: ['src/**/*.test.ts'] }"),
    };
    const configPath = makeRepo(files);
    const measurePath = makeRepo({ ...files, 'viteſt.config.ts': configWith('{}') });

    expect(typescriptAdapter.testFiles?.({ configPath, measurePath }, ['src/a.test.ts'])).toEqual(
      [],
    );
  });

  // The run reads the measured checkout's lists, so a branch that narrows them
  // leaves a file vitest never collects.
  it('collects only what both checkouts collect', () => {
    const configPath = makeRepo({
      'package.json': plainVitest,
      'vitest.config.ts': configWith("{ include: ['src/**/*.test.ts'], exclude: [] }"),
    });
    const measurePath = makeRepo({
      'package.json': plainVitest,
      'vitest.config.ts': configWith(
        "{ include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'], exclude: ['src/big.test.ts'] }",
      ),
    });

    expect(
      typescriptAdapter.testFiles?.({ configPath, measurePath }, [
        'src/a.test.ts',
        'src/big.test.ts',
        'scripts/x.test.ts',
      ]),
    ).toEqual(['src/a.test.ts']);
  });

  /** A repo with `files` committed; the repo and the commit's sha. */
  function committed(files: Record<string, string>): { repo: string; sha: string } {
    const repo = makeRepo(files);
    sh(repo, 'git', 'init', '-q');
    sh(repo, 'git', 'add', '-A');
    sh(repo, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    return { repo, sha: sh(repo, 'git', 'rev-parse', 'HEAD') };
  }

  /**
   * A gate context over one repo committing `target`, then `branch` over it,
   * paths nested and ignored ones included, read from the two commits.
   */
  function branched(
    target: Record<string, string>,
    branch: Record<string, string>,
  ): { configPath: string; configSha: string; measurePath: string; measureSha: string } {
    const repo = tempDir('pup-adapter-');
    const commit = (files: Record<string, string>): string => {
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(repo, name)), { recursive: true });
        writeFileSync(join(repo, name), text);
      }
      sh(repo, 'git', 'add', '-A', '-f');
      sh(
        repo,
        'git',
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'c',
      );
      return sh(repo, 'git', 'rev-parse', 'HEAD');
    };
    sh(repo, 'git', 'init', '-q');
    const configSha = commit(target);
    return { configPath: repo, configSha, measurePath: repo, measureSha: commit(branch) };
  }

  const plainRoot = () => ({
    'package.json': plainVitest,
    'vitest.config.ts': configWith("{ include: ['src/**/*.test.ts'] }"),
  });

  // The gate reads both sides from trees: a directory there is a tree entry,
  // and below the root node resolves a `node_modules` and tsconfck a tsconfig.
  it.each([
    ['a .config directory on both sides', { '.config/postcssrc.json': '{}\n' }, {}, []],
    [
      'a .github directory only the branch changes',
      { '.github/ci.yml': 'a\n' },
      { '.github/ci.yml': 'b\n' },
      [],
    ],
    ['a .github directory only the branch adds', {}, { '.github/ci.yml': 'a\n' }, []],
    ['a .github directory on both sides', { '.github/ci.yml': 'a\n' }, {}, ['src/a.test.ts']],
    [
      'a node_modules path below the root only the branch commits',
      {},
      { 'src/node_modules/x/index.js': 'x\n' },
      [],
    ],
    [
      'a Node_Modules path below the root on both sides',
      { 'lib/Node_Modules/x.js': 'x\n' },
      {},
      [],
    ],
    [
      'a nested tsconfig.json the branch changes',
      { 'web/tsconfig.json': '{}\n' },
      { 'web/tsconfig.json': '{ "compilerOptions": { "jsxImportSource": "./jsx" } }\n' },
      [],
    ],
    ['a nested jsconfig.json only the branch adds', {}, { 'web/jsconfig.json': '{}\n' }, []],
    [
      'a nested TSCONFIG.app.JSON only the branch adds',
      {},
      { 'web/TSCONFIG.app.JSON': '{}\n' },
      [],
    ],
    [
      'a nested tsconfig.json on both sides',
      { 'web/tsconfig.json': '{}\n' },
      {},
      ['src/a.test.ts'],
    ],
    // APFS folds `ſ` onto `s`, which no JavaScript case mapping reproduces.
    [
      'a tſconfig.json below the root only the branch adds',
      {},
      { 'src/tſconfig.json': '{ "compilerOptions": { "jsxImportSource": "x" } }\n' },
      [],
    ],
    [
      'a node_moduleſ path below the root only the branch commits',
      {},
      { 'src/node_moduleſ/x/jsx-runtime.js': 'x\n' },
      [],
    ],
    [
      'a name outside ASCII below the root on both sides',
      { 'docs/café.md': 'a\n' },
      {},
      ['src/a.test.ts'],
    ],
  ] as [string, Record<string, string>, Record<string, string>, string[]][])(
    'reads from the trees %s',
    (_, target, branch, expected) => {
      const ctx = branched({ ...plainRoot(), ...target }, branch);
      const files = ['src/a.test.ts', ...Object.keys(target), ...Object.keys(branch)];

      expect(typescriptAdapter.testFiles?.(ctx, files)).toEqual(expected);
    },
  );

  it('reads a nested tsconfig.json the branch deletes from the trees', () => {
    const ctx = branched({ ...plainRoot(), 'web/tsconfig.json': '{}\n' }, {});
    sh(ctx.configPath, 'git', 'rm', '-q', 'web/tsconfig.json');
    sh(
      ctx.configPath,
      'git',
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '-m',
      'rm',
    );
    const measureSha = sh(ctx.configPath, 'git', 'rev-parse', 'HEAD');

    expect(
      typescriptAdapter.testFiles?.({ ...ctx, measureSha }, ['src/a.test.ts', 'web/tsconfig.json']),
    ).toEqual([]);
  });

  // A directory the run reads is walked whole: what cannot be read, or is a
  // link, fails the check rather than read as empty or throw.
  it.each([
    ['untouched', () => {}, true],
    ['with .config unlistable', (repo: string) => chmodSync(join(repo, '.config'), 0o300), false],
    [
      'with a file under .github unreadable',
      (repo: string) => chmodSync(join(repo, '.github', 'ci.yml'), 0o000),
      false,
    ],
    [
      'with a file under .github made a link',
      (repo: string) => {
        rmSync(join(repo, '.github', 'ci.yml'));
        symlinkSync('../package.json', join(repo, '.github', 'ci.yml'));
      },
      false,
    ],
    [
      'with .config made a link to a copy',
      (repo: string) => {
        const copy = tempDir('pup-config-');
        writeFileSync(join(copy, 'postcssrc.json'), '{}\n');
        rmSync(join(repo, '.config'), { recursive: true });
        symlinkSync(copy, join(repo, '.config'));
      },
      false,
    ],
  ] as [string, (repo: string) => void, boolean][])(
    'checks the directories of a checkout %s',
    (_, change, intact) => {
      const ctx = branched(
        { ...plainRoot(), '.config/postcssrc.json': '{}\n', '.github/ci.yml': 'a\n' },
        {},
      );
      onTestFinished(() => {
        for (const path of ['.config', '.github/ci.yml']) {
          const at = join(ctx.measurePath, path);
          if (lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink() === false)
            chmodSync(at, 0o755);
        }
      });
      change(ctx.measurePath);

      expect(typescriptAdapter.testInputsIntact?.(ctx)).toBe(intact);
    },
  );

  // A tree lists a link by its target's text and a submodule by its commit; the
  // gate checks out the link unfollowed and the submodule as an empty directory.
  it.each([
    ['a link', (repo: string) => symlinkSync('pre-commit', join(repo, '.husky', 'hook'))],
    [
      'an uninitialised submodule',
      (repo: string) => {
        mkdirSync(join(repo, '.husky', 'sub'));
        const head = sh(repo, 'git', 'rev-parse', 'HEAD');
        sh(repo, 'git', 'update-index', '--add', '--cacheinfo', `160000,${head},.husky/sub`);
      },
    ],
  ] as [string, (repo: string) => void][])(
    'checks a dot directory holding %s the commit holds',
    (_, add) => {
      const ctx = branched({ ...plainRoot(), '.husky/pre-commit': 'npm test\n' }, {});
      add(ctx.measurePath);
      sh(ctx.measurePath, 'git', 'add', '-A', '-f');
      sh(
        ctx.measurePath,
        'git',
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '-m',
        'add',
      );
      const measureSha = sh(ctx.measurePath, 'git', 'rev-parse', 'HEAD');

      expect(typescriptAdapter.testInputsIntact?.({ ...ctx, measureSha })).toBe(true);
    },
  );

  // What a tree cannot hold, or a name `hash-object` cannot read back from its
  // input, refuses the directory's listing, and so the check.
  it.each([
    ['a FIFO', (dir: string) => execFileSync('mkfifo', [join(dir, 'pipe')]), 'pipe'],
    [
      'a file named across two lines',
      (dir: string) => writeFileSync(join(dir, 'a\nb'), 'x\n'),
      'a\nb',
    ],
  ] as [string, (dir: string) => void, string][])(
    'refuses a dot directory holding %s',
    (_, add, name) => {
      const ctx = branched({ ...plainRoot(), '.github/ci.yml': 'a\n' }, {});
      add(join(ctx.measurePath, '.github'));

      expect(() => diskRoot(ctx.measurePath, ctx.configPath).get('.github')?.()).toThrow(
        `${name} is not read: not a plain file or a link named on one line`,
      );
      expect(typescriptAdapter.testInputsIntact?.(ctx)).toBe(false);
    },
  );

  // A text read stops at 1 MiB; a root file is compared by object name.
  it.each([
    ['untouched', () => {}, true],
    [
      'rewritten',
      (lockfile: string) =>
        writeFileSync(lockfile, readFileSync(lockfile, 'utf8').replace('a', 'b')),
      false,
    ],
  ] as [string, (lockfile: string) => void, boolean][])(
    'checks a root lockfile over 1 MiB %s',
    (_, change, intact) => {
      const ctx = branched(
        { ...plainRoot(), 'package-lock.json': `{ "x": "${'a'.repeat(1 << 20)}" }\n` },
        {},
      );
      change(join(ctx.measurePath, 'package-lock.json'));

      expect(typescriptAdapter.testInputsIntact?.(ctx)).toBe(intact);
    },
  );

  // The gate's checkout is where the branch's build and tests ran, so its
  // config is read from the commit it was cut at, never from its disk.
  it('reads the measured config from the pinned sha, whatever the checkout holds', () => {
    const trusted = {
      'package.json': plainVitest,
      'vitest.config.ts': configWith("{ include: ['src/**/*.test.ts'], exclude: [] }"),
    };
    const { repo, sha } = committed(trusted);
    writeFileSync(
      join(repo, 'vitest.config.ts'),
      configWith("{ include: ['src/**/*.test.ts'], exclude: ['src/big.test.ts'] }"),
    );
    sh(repo, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'narrow');
    const narrowed = sh(repo, 'git', 'rev-parse', 'HEAD');
    sh(repo, 'git', 'reset', '-q', '--hard', sha);
    const ctx = {
      configPath: repo,
      configSha: sha,
      measurePath: makeRepo(trusted),
      measureSha: narrowed,
    };

    expect(typescriptAdapter.testFiles?.(ctx, ['src/a.test.ts', 'src/big.test.ts'])).toEqual([
      'src/a.test.ts',
    ]);
  });

  // A session can write the main checkout's disk too, so the trusted config
  // is the target commit's.
  it("reads the trusted config from the target sha, whatever the main checkout's disk holds", () => {
    const narrow = configWith("{ include: ['src/**/*.test.ts'] }");
    const { repo, sha } = committed({ 'package.json': plainVitest, 'vitest.config.ts': narrow });
    const wide = configWith("{ include: ['**/*.test.ts'] }");
    writeFileSync(join(repo, 'vitest.config.ts'), wide);
    sh(repo, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'widen');
    const branch = sh(repo, 'git', 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'vitest.config.ts'), wide);
    const ctx = { configPath: repo, configSha: sha, measurePath: repo, measureSha: branch };

    expect(typescriptAdapter.testFiles?.(ctx, ['src/a.test.ts', 'scripts/x.test.ts'])).toEqual([
      'src/a.test.ts',
    ]);
  });

  // Each row is what a branch's code may leave in the checkout before or while
  // vitest reads it; only a file outside the run's inputs leaves them intact.
  it.each([
    ['untouched', () => {}, true],
    ['given a build output', (dir: string) => writeFileSync(join(dir, 'out.js'), 'x\n'), true],
    [
      'with its config rewritten',
      (dir: string) => writeFileSync(join(dir, 'vitest.config.ts'), configWith('{}')),
      false,
    ],
    ['given an .npmrc', (dir: string) => writeFileSync(join(dir, '.npmrc'), 'x=1\n'), false],
    ...[
      '.yarnrc',
      '.yarnrc.yml',
      '.env.yarn',
      '.env',
      '.env.local',
      '.pnp.cjs',
      '.pnp.loader.mjs',
      '.pnpmfile.cjs',
      'pnpm-workspace.yaml',
      'bunfig.toml',
      'postcss.config.mjs',
      '.postcssrc',
      'tsconfig.json',
      '.babelrc',
      'browserslist',
      'tailwind.config.ts',
      // Named in another case, which a case-insensitive disk opens for the lower-case name.
      '.PostCSSrc',
      'Postcss.config.js',
      'TSCONFIG.JSON',
    ].map(
      (name) =>
        [`given a ${name}`, (dir: string) => writeFileSync(join(dir, name), 'x\n'), false] as const,
    ),
    // APFS folds `ſ` onto `s`, so vitest opens it for `vitest.workspace.ts`.
    [
      'given a name outside ASCII',
      (dir: string) => writeFileSync(join(dir, 'viteſt.workspace.ts'), 'export default [];\n'),
      false,
    ],
    ['without its manifest', (dir: string) => rmSync(join(dir, 'package.json')), false],
    [
      'with its config made a link',
      (dir: string) => {
        renameSync(join(dir, 'vitest.config.ts'), join(dir, 'real.ts'));
        symlinkSync('real.ts', join(dir, 'vitest.config.ts'));
      },
      false,
    ],
    [
      'with its manifest renamed into another case',
      (dir: string) => renameSync(join(dir, 'package.json'), join(dir, 'Package.json')),
      false,
    ],
    [
      'given a .yarn directory',
      (dir: string) => {
        mkdirSync(join(dir, '.yarn', 'plugins'), { recursive: true });
        writeFileSync(join(dir, '.yarn', 'plugins', 'p.cjs'), 'x\n');
      },
      false,
    ],
    [
      'given a .config directory',
      (dir: string) => {
        mkdirSync(join(dir, '.config'));
        writeFileSync(join(dir, '.config', 'postcssrc.json'), '{}\n');
      },
      false,
    ],
  ] as [string, (dir: string) => void, boolean][])(
    'checks the run inputs of a checkout %s',
    (_, change, intact) => {
      const { repo, sha } = committed({
        'package.json': plainVitest,
        'vitest.config.ts': configWith("{ include: ['src/**/*.test.ts'] }"),
      });
      change(repo);

      expect(
        typescriptAdapter.testInputsIntact?.({
          configPath: repo,
          measurePath: repo,
          measureSha: sha,
        }),
      ).toBe(intact);
    },
  );

  // Yarn reads its own directory, which the branch's build may rewrite.
  it.each([
    ['untouched', () => {}, true],
    ['given an empty directory', (yarn: string) => mkdirSync(join(yarn, 'cache')), true],
    [
      'with a file rewritten',
      (yarn: string) => writeFileSync(join(yarn, 'releases', 'yarn.cjs'), 'y\n'),
      false,
    ],
    [
      'given a file',
      (yarn: string) => writeFileSync(join(yarn, 'releases', 'other.cjs'), 'x\n'),
      false,
    ],
    [
      'with a file made executable',
      (yarn: string) => chmodSync(join(yarn, 'releases', 'yarn.cjs'), 0o755),
      false,
    ],
    [
      'with a file made a link',
      (yarn: string) => {
        rmSync(join(yarn, 'releases', 'yarn.cjs'));
        symlinkSync('../../package.json', join(yarn, 'releases', 'yarn.cjs'));
      },
      false,
    ],
  ] as [string, (yarn: string) => void, boolean][])(
    'checks the .yarn directory of a checkout %s',
    (_, change, intact) => {
      const repo = makeRepo({
        'package.json': plainVitest,
        'vitest.config.ts': configWith("{ include: ['src/**/*.test.ts'] }"),
      });
      mkdirSync(join(repo, '.yarn', 'releases'), { recursive: true });
      writeFileSync(join(repo, '.yarn', 'releases', 'yarn.cjs'), 'x\n');
      sh(repo, 'git', 'init', '-q');
      sh(repo, 'git', 'add', '-A');
      sh(repo, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
      const sha = sh(repo, 'git', 'rev-parse', 'HEAD');
      change(join(repo, '.yarn'));

      expect(
        typescriptAdapter.testInputsIntact?.({
          configPath: repo,
          measurePath: repo,
          measureSha: sha,
        }),
      ).toBe(intact);
    },
  );

  // npm and pnpm read the operator's own .npmrc too, which a session can write.
  it.each([
    ['none', undefined, true],
    ['one that runs nothing', 'fund=false\n', true],
    ['one with node-options', 'node-options=--import /tmp/reg.mjs\n', false],
    ['one with an escaped key', '"node\\u002doptions"=--import /tmp/reg.mjs\n', false],
    // npm reads the config these name too, which nothing here checks.
    ['one naming a globalconfig', 'globalconfig=/tmp/npmrc\n', false],
    ['one naming a userconfig', 'userconfig=/tmp/npmrc\n', false],
    ['one naming a prefix', 'prefix=/tmp/prefix\n', false],
    ['one naming a quoted prefix in another case', '"PREFIX" = /tmp/prefix\n', false],
    ['one naming a save-prefix', 'save-prefix=~\n', true],
    // Spellings npm's ini parser reads as the key: trimmed by JavaScript's trim,
    // cut at an unquoted ; or #, and without an array's [].
    ['one naming a globalconfig after a BOM', '\uFEFFglobalconfig=/x\n', false],
    ['one naming a prefix after a form feed', '\fprefix=/x\n', false],
    ['one naming a prefix before a no-break space', 'prefix\u00A0=/x\n', false],
    ['one naming a prefix after an ideographic space', '\u3000prefix=/x\n', false],
    ['one naming a prefix cut at a ;', 'prefix;x=/p\n', false],
    ['one naming a globalconfig cut at a #', 'globalconfig#c=/rc\n', false],
    ['one naming a prefix array', 'prefix[]=/p\n', false],
    ['one naming a quoted prefix array', '"prefix[]"=/p\n', false],
    // Keys not plainly spelt: ini strips quotes and parses the key as JSON,
    // which allows whitespace inside, and trims a section's name.
    ['one naming a globalconfig quoted after a space', ' "globalconfig"=/x\n', false],
    ['one naming a prefix quoted before a tab', '"prefix"\t=/x\n', false],
    ['one naming a quoted prefix in a spaced section', '[ "prefix" ]=/x\n', false],
    ['one with a spaced prefix section', '[ prefix ]\nfund=false\n', false],
    ['one naming a globalconfig after a U+2028', 'fund=false\u2028globalconfig=/x\n', false],
    ['one with a registry', 'registry = https://registry.npmjs.org/\n', true],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: npm's own substitution, not a JS template
    ['one with a token', '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n', true],
    ['one with a scope registry', '@scope:registry=https://npm.example.com/\n', true],
    ['one with a plain array key', 'public-hoist-pattern[]=*eslint*\n', true],
  ])('checks a checkout beside a user .npmrc of %s', (_, npmrc, intact) => {
    const home = tempDir('pup-home-');
    if (npmrc !== undefined) writeFileSync(join(home, '.npmrc'), npmrc);
    vi.stubEnv('HOME', home);
    const { repo, sha } = committed({
      'package.json': plainVitest,
      'vitest.config.ts': configWith("{ include: ['src/**/*.test.ts'] }"),
    });

    expect(
      typescriptAdapter.testInputsIntact?.({
        configPath: repo,
        measurePath: repo,
        measureSha: sha,
      }),
    ).toBe(intact);
  });

  it('reads a user .npmrc of exactly 64 KiB', () => {
    const home = tempDir('pup-home-');
    const line = 'fund=false\n';
    writeFileSync(join(home, '.npmrc'), `#${'x'.repeat(64 * 1024 - line.length - 2)}\n${line}`);
    vi.stubEnv('HOME', home);
    const { repo, sha } = committed({
      'package.json': plainVitest,
      'vitest.config.ts': configWith("{ include: ['src/**/*.test.ts'] }"),
    });

    expect(
      typescriptAdapter.testInputsIntact?.({
        configPath: repo,
        measurePath: repo,
        measureSha: sha,
      }),
    ).toBe(true);
  });

  // Read only as a small regular file: a link may name what the check never
  // sees, and a fifo or a device would block the read.
  it.each([
    [
      'a link',
      (path: string) => {
        const real = join(tempDir('pup-real-'), 'npmrc');
        writeFileSync(real, 'fund=false\n');
        symlinkSync(real, path);
      },
    ],
    ['a fifo', (path: string) => execFileSync('mkfifo', [path])],
    ['a directory', (path: string) => mkdirSync(path)],
    [
      'a file over 64 KiB',
      (path: string) => writeFileSync(path, `# ${'x'.repeat(64 * 1024)}\nfund=false\n`),
    ],
    // Its size is read from the descriptor before any of it is.
    [
      'a sparse 50 GiB file',
      (path: string) => {
        writeFileSync(path, 'fund=false\n');
        truncateSync(path, 50 * 1024 ** 3);
      },
    ],
  ])('finds a checkout not intact beside a user .npmrc that is %s', (_, make) => {
    const home = tempDir('pup-home-');
    make(join(home, '.npmrc'));
    vi.stubEnv('HOME', home);
    const { repo, sha } = committed({
      'package.json': plainVitest,
      'vitest.config.ts': configWith("{ include: ['src/**/*.test.ts'] }"),
    });

    expect(
      typescriptAdapter.testInputsIntact?.({
        configPath: repo,
        measurePath: repo,
        measureSha: sha,
      }),
    ).toBe(false);
  });

  it('checks the user .npmrc the operator names through --gate-env', () => {
    const named = join(tempDir('pup-userconfig-'), 'npmrc');
    writeFileSync(named, 'script-shell=/tmp/sh\n');
    vi.stubEnv('npm_config_userconfig', named);
    const { repo, sha } = committed({
      'package.json': plainVitest,
      'vitest.config.ts': configWith("{ include: ['src/**/*.test.ts'] }"),
    });
    const ctx = { configPath: repo, measurePath: repo, measureSha: sha };

    expect(typescriptAdapter.testInputsIntact?.(ctx)).toBe(true);
    expect(
      typescriptAdapter.testInputsIntact?.({ ...ctx, gateEnv: ['npm_config_userconfig'] }),
    ).toBe(false);
  });

  // npm expands `~/` against HOME and resolves the rest against the run's own
  // directory, the gate checkout, so a path not absolute may name what pup never reads.
  it.each([
    ['under a ~', { NPM_CONFIG_USERCONFIG: '~/.npmrc-work' }],
    ['relative', { NPM_CONFIG_USERCONFIG: '.npmrc.ci' }],
    ['empty', { NPM_CONFIG_USERCONFIG: '' }],
    ['in two spellings', { NPM_CONFIG_USERCONFIG: '/tmp/a', npm_config_userconfig: '/tmp/b' }],
  ] as [string, Record<string, string>][])(
    'finds a checkout not intact beside a user .npmrc named %s through --gate-env',
    (_, env) => {
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      const { repo, sha } = committed({
        'package.json': plainVitest,
        'vitest.config.ts': configWith("{ include: ['src/**/*.test.ts'] }"),
      });
      const ctx = { configPath: repo, measurePath: repo, measureSha: sha };

      expect(typescriptAdapter.testInputsIntact?.(ctx)).toBe(true);
      expect(typescriptAdapter.testInputsIntact?.({ ...ctx, gateEnv: Object.keys(env) })).toBe(
        false,
      );
    },
  );

  // The gate links each entry of the trusted node_modules into its checkout.
  it.each([
    ['links each entry to the trusted one', () => {}, true],
    [
      'holds a vite cache of its own',
      (modules: string) => mkdirSync(join(modules, '.vite', 'vitest'), { recursive: true }),
      true,
    ],
    // `tsc -b` with `tsBuildInfoFile: ./node_modules/.tmp/...`; no package is dot-named.
    [
      'holds a build output the trusted one lacks',
      (modules: string) => mkdirSync(join(modules, '.tmp')),
      true,
    ],
    ['holds binaries of its own', (modules: string) => mkdirSync(join(modules, '.bin')), false],
    // npm 6 and older ran `.hooks/<event>` around each script.
    ['holds npm hooks of its own', (modules: string) => mkdirSync(join(modules, '.HOOKS')), false],
    // APFS folds `ſ` onto `s`, so it opens `.hookſ` for `.hooks`.
    [
      'holds a dot-named entry of its own named outside ASCII',
      (modules: string) => mkdirSync(join(modules, '.hookſ')),
      false,
    ],
    // vite bundles an ESM config into `.vite-temp`, which the trusted one holds too.
    [
      'holds a vite-temp of its own',
      (modules: string) => mkdirSync(join(modules, '.vite-temp')),
      true,
    ],
    // Only `.cache`, `.vite` and `.vite-temp` are the run's; `.vitest` is a linked entry.
    [
      'replaces a linked .vite-named entry with one of its own',
      (modules: string) => {
        rmSync(join(modules, '.vitest'));
        mkdirSync(join(modules, '.vitest'));
      },
      false,
    ],
    [
      'holds binaries of its own in another case',
      (modules: string) => mkdirSync(join(modules, '.BIN')),
      false,
    ],
    [
      'replaces a dot-named link with an entry of its own',
      (modules: string) => {
        rmSync(join(modules, '.pnpm'));
        mkdirSync(join(modules, '.pnpm'));
      },
      false,
    ],
    [
      'replaces a link with a package of its own',
      (modules: string) => {
        rmSync(join(modules, 'vitest'));
        mkdirSync(join(modules, 'vitest'));
      },
      false,
    ],
    [
      'links an entry elsewhere',
      (modules: string) => {
        rmSync(join(modules, 'vitest'));
        symlinkSync(tempDir('pup-elsewhere-'), join(modules, 'vitest'));
      },
      false,
    ],
    [
      'is itself a link',
      (modules: string) => {
        rmSync(modules, { recursive: true });
        symlinkSync(tempDir('pup-elsewhere-'), modules);
      },
      false,
    ],
  ])('checks the node_modules of a checkout that %s', (_, change, intact) => {
    const files = {
      'package.json': plainVitest,
      'vitest.config.ts': configWith("{ include: ['src/**/*.test.ts'] }"),
    };
    const { repo, sha } = committed(files);
    const checkout = makeRepo(files);
    const modules = join(checkout, 'node_modules');
    mkdirSync(modules);
    for (const entry of ['vitest', '.pnpm', '.vitest']) {
      mkdirSync(join(repo, 'node_modules', entry), { recursive: true });
      symlinkSync(join(repo, 'node_modules', entry), join(modules, entry));
    }
    mkdirSync(join(repo, 'node_modules', '.vite-temp'));
    change(modules);

    expect(
      typescriptAdapter.testInputsIntact?.({
        configPath: repo,
        measurePath: checkout,
        measureSha: sha,
      }),
    ).toBe(intact);
  });

  it('holds the run inputs intact outside the gate, where nothing ran', () => {
    const repo = makeRepo({ 'package.json': plainVitest, '.npmrc': 'x=1\n' });

    expect(typescriptAdapter.testInputsIntact?.(localContext(repo))).toBe(true);
  });
});

describe('typescriptAdapter.depGraph', () => {
  function makeSourceRepo(files: Record<string, string>): string {
    const dir = tempDir('pup-graph-');
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }

  it('builds module nodes and edges from relative imports, ESM .js style included', () => {
    const repo = makeSourceRepo({
      'src/cli/index.ts': "import { run } from '../core/run.service.js';\nrun();\n",
      'src/core/run.service.ts':
        "import type { Cfg } from './types/run.types.js';\nexport const run = (c?: Cfg) => c;\n",
      'src/core/types/run.types.ts': 'export interface Cfg { a: number }\n',
    });

    const graph = typescriptAdapter.depGraph?.(localContext(repo));

    expect(Object.keys(graph?.modules ?? {}).sort()).toEqual([
      'src/cli',
      'src/core',
      'src/core/types',
    ]);
    expect(graph?.edges).toEqual([
      { from: 'src/cli', to: 'src/core' },
      { from: 'src/core', to: 'src/core/types' },
    ]);
  });

  it('resolves directory index imports and ignores package imports and node_modules', () => {
    const repo = makeSourceRepo({
      'src/app.ts':
        "import { x } from './lib';\nimport ts from 'typescript';\nexport const a = [x, ts];\n",
      'src/lib/index.ts': 'export const x = 1;\n',
      'node_modules/pkg/index.ts': 'export const hidden = 1;\n',
    });

    const graph = typescriptAdapter.depGraph?.(localContext(repo));

    expect(Object.keys(graph?.modules ?? {}).sort()).toEqual(['src', 'src/lib']);
    expect(graph?.edges).toEqual([{ from: 'src', to: 'src/lib' }]);
  });

  it('expects coverage only for source files that still exist, never tests or assets', () => {
    const repo = makeSourceRepo({
      'src/app.ts': 'export const a = 1;\n',
      'src/app.test.ts': 'export const spec = 1;\n',
      'src/types.d.ts': 'declare const g: number;\n',
      'README.md': '# docs\n',
    });

    const coverable = typescriptAdapter.coverableFiles?.(localContext(repo), [
      'src/app.ts',
      'src/app.test.ts',
      'src/types.d.ts',
      'README.md',
      // Deleted on this branch: nothing left to cover.
      'src/removed.ts',
    ]);

    expect(coverable).toEqual(['src/app.ts']);
  });

  it('does not expect coverage for what the tooling excludes by default', () => {
    // Otherwise every change to a build config or a test helper is flagged.
    const repo = makeSourceRepo({
      'vitest.config.ts': 'export default {};\n',
      'tests/helper.ts': 'export const h = 1;\n',
      'src/__mocks__/db.ts': 'export const db = 1;\n',
      'src/app.ts': 'export const a = 1;\n',
    });

    const coverable = typescriptAdapter.coverableFiles?.(localContext(repo), [
      'vitest.config.ts',
      'tests/helper.ts',
      'src/__mocks__/db.ts',
      'src/app.ts',
    ]);

    expect(coverable).toEqual(['src/app.ts']);
  });

  it('gives naming no hiding place: only the tools own exclusions are honoured', () => {
    // `config` is a valid role suffix in this repo, and the tools exclude named
    // build configs, not every *.config.*. A blanket rule would let a session
    // park a module at src/payments.config.ts and never be measured.
    const repo = makeSourceRepo({
      'src/payments.config.ts': 'export const rate = 1;\n',
      'src/build/pipeline.ts': 'export const p = 1;\n',
      'src/test/prod.ts': 'export const t = 1;\n',
      'packages/tests/api/server.ts': 'export const s = 1;\n',
    });

    const coverable = typescriptAdapter.coverableFiles?.(localContext(repo), [
      'src/payments.config.ts',
      'src/build/pipeline.ts',
      'src/test/prod.ts',
      'packages/tests/api/server.ts',
    ]);

    expect(coverable).toEqual([
      'src/payments.config.ts',
      'src/build/pipeline.ts',
      'src/test/prod.ts',
      'packages/tests/api/server.ts',
    ]);
  });

  it('groups top-level files under (root) and skips declaration files', () => {
    const repo = makeSourceRepo({
      'main.ts': "import './helper.js';\n",
      'helper.ts': 'export {};\n',
      'globals.d.ts': 'declare const g: number;\n',
    });

    const graph = typescriptAdapter.depGraph?.(localContext(repo));

    expect(graph?.modules).toEqual({ '(root)': ['helper.ts', 'main.ts'] });
    expect(graph?.edges).toEqual([]);
  });
});

describe('typescriptAdapter.deadCode', () => {
  const tree = {
    'package.json': '{}',
    'src/a.ts': 'export const viaAlias = 1;\n',
    'src/b.ts': "import { viaAlias } from '@src/a.js';\nexport const b = viaAlias;\n",
  };
  const aliased = '{ "compilerOptions": { "paths": { "@src/*": ["./src/*"] } } }';

  function makeTree(files: Record<string, string>): string {
    const dir = tempDir('pup-dead-');
    mkdirSync(join(dir, 'src'));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  }

  it("resolves an import through the measured checkout's tsconfig paths", () => {
    // The trusted checkout predates the alias: the branch introducing it must
    // not read its own alias imports as unresolved.
    const ctx = {
      measurePath: makeTree({ ...tree, 'tsconfig.json': aliased }),
      configPath: makeTree(tree),
    };

    expect(typescriptAdapter.deadCode?.(ctx)).toEqual([{ file: 'src/b.ts', exportName: 'b' }]);
  });

  it('resolves relative imports only without a usable tsconfig paths, as before', () => {
    const dead = [
      { file: 'src/a.ts', exportName: 'viaAlias' },
      { file: 'src/b.ts', exportName: 'b' },
    ];
    for (const tsconfig of [
      undefined,
      '{ "compilerOptions": { "strict": true } }',
      '{ "compil',
      '{ "compilerOptions": { "paths": { "@src/*": "./src/*" } } }',
    ]) {
      const files = tsconfig === undefined ? tree : { ...tree, 'tsconfig.json': tsconfig };

      expect(typescriptAdapter.deadCode?.(localContext(makeTree(files)))).toEqual(dead);
    }
  });
});

describe('typescriptAdapter nested packages', () => {
  const clone = Array.from({ length: 8 }, (_, i) => `export const v${i} = ${i} * 2;`).join('\n');
  const tree = {
    'package.json': '{}',
    'src/app.ts': "import { p } from '../tools/plain/p.js';\nexport const a = p;\n",
    'tools/plain/p.ts': 'export const p = 1;\nexport const plainDead = 2;\n',
    'tools/plain/clone.ts': `${clone}\n`,
    'tools/review/package.json': '{}',
    'tools/review/src/r.ts': 'export const reviewDead = 1;\n',
    'tools/review/src/clone.ts': `${clone}\n`,
  };

  const GIT_ENV: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };

  function writeFiles(dir: string, files: Record<string, string>): void {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
  }

  /** A checkout with `files` committed: markers are read from HEAD's tree. */
  function makeTree(files: Record<string, string>): string {
    const dir = tempDir('pup-nested-');
    writeFiles(dir, files);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: GIT_ENV });
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    return dir;
  }

  it('leaves a nested package out of the walk, dead code, duplication and coverage', () => {
    const ctx = localContext(makeTree(tree));

    expect(Object.keys(typescriptAdapter.depGraph?.(ctx).modules ?? {}).sort()).toEqual([
      'src',
      'tools/plain',
    ]);
    const dead = typescriptAdapter.deadCode?.(ctx) as DeadExport[];
    expect(dead.map((d) => d.file)).not.toContain('tools/review/src/r.ts');
    const duplication = typescriptAdapter.duplication?.(ctx) as DuplicationReport;
    expect(duplication.duplicatedLines).toBe(0);
    expect(
      typescriptAdapter.coverableFiles?.(ctx, ['src/app.ts', 'tools/review/src/r.ts']),
    ).toEqual(['src/app.ts']);
  });

  it("leaves a nested package's test files out of the root run's tests", () => {
    const ctx = localContext(
      makeTree({
        ...tree,
        'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
        'vitest.config.ts': 'export default {};\n',
      }),
    );

    expect(
      typescriptAdapter.testFiles?.(ctx, ['tools/review/src/r.test.ts', 'tools/plain/p.test.ts']),
    ).toEqual(['tools/plain/p.test.ts']);
  });

  it('still walks a directory without its own package.json', () => {
    const ctx = localContext(makeTree(tree));

    const dead = typescriptAdapter.deadCode?.(ctx) as DeadExport[];
    expect(dead).toContainEqual({ file: 'tools/plain/p.ts', exportName: 'plainDead' });
    expect(typescriptAdapter.coverableFiles?.(ctx, ['tools/plain/p.ts'])).toEqual([
      'tools/plain/p.ts',
    ]);
  });

  it('counts a nested package the trusted checkout does not have', () => {
    // A package.json is one file a session can write anywhere; a worktree-only
    // marker would buy exemption with `touch src/core/package.json`.
    const measurePath = makeTree(tree);
    const { 'tools/review/package.json': _, ...trusted } = tree;
    const ctx = { measurePath, configPath: makeTree(trusted) };

    const dead = typescriptAdapter.deadCode?.(ctx) as DeadExport[];
    expect(dead).toContainEqual({ file: 'tools/review/src/r.ts', exportName: 'reviewDead' });
    const duplication = typescriptAdapter.duplication?.(ctx) as DuplicationReport;
    expect(duplication.duplicatedLines).toBeGreaterThan(0);
    expect(typescriptAdapter.coverableFiles?.(ctx, ['tools/review/src/r.ts'])).toEqual([
      'tools/review/src/r.ts',
    ]);
  });

  it('ignores an untracked marker, even one present in both checkouts', () => {
    const { 'tools/review/package.json': _, ...unmarked } = tree;
    const measurePath = makeTree(unmarked);
    const configPath = makeTree(unmarked);
    writeFiles(measurePath, { 'tools/review/package.json': '{}' });
    writeFiles(configPath, { 'tools/review/package.json': '{}' });
    const ctx = { measurePath, configPath };

    const dead = typescriptAdapter.deadCode?.(ctx) as DeadExport[];
    expect(dead).toContainEqual({ file: 'tools/review/src/r.ts', exportName: 'reviewDead' });
    expect(typescriptAdapter.coverableFiles?.(ctx, ['tools/review/src/r.ts'])).toEqual([
      'tools/review/src/r.ts',
    ]);
  });

  describe('touchedNestedPackages', () => {
    const scripted = {
      ...tree,
      'tools/review/package.json': JSON.stringify({
        scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' },
      }),
      'tools/review/pnpm-lock.yaml': '',
    };

    it('resolves test and typecheck from the trusted manifest, run through its package manager', () => {
      const measurePath = makeTree({
        ...scripted,
        // The session's manifest drops both scripts; the trusted one still names them.
        'tools/review/package.json': JSON.stringify({ scripts: {} }),
      });
      const ctx = { measurePath, configPath: makeTree(scripted) };

      expect(
        typescriptAdapter.touchedNestedPackages?.(ctx, [
          'src/app.ts',
          'tools/review/src/r.ts',
          'tools/review/README.md',
          'tools/plain/p.ts',
        ]),
      ).toEqual([
        {
          dir: 'tools/review',
          changedFiles: ['tools/review/src/r.ts', 'tools/review/README.md'],
          droppedSources: ['tools/review/src/r.ts'],
          commands: [
            { stage: 'test', command: 'pnpm', args: ['run', 'test'] },
            { stage: 'typecheck', command: 'pnpm', args: ['run', 'typecheck'] },
          ],
          missing: [],
        },
      ]);
    });

    it('names the scripts the trusted manifest lacks, whatever the session declares', () => {
      const configPath = makeTree({
        ...tree,
        'tools/review/package.json': JSON.stringify({ scripts: { typecheck: 'tsc' } }),
      });
      const ctx = { measurePath: makeTree(scripted), configPath };

      const [pkg] = typescriptAdapter.touchedNestedPackages?.(ctx, ['tools/review/src/r.ts']) ?? [];

      expect(pkg?.commands).toEqual([
        { stage: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
      ]);
      expect(pkg?.missing).toEqual(['test']);
    });

    it('treats a manifest-less package as declaring nothing', () => {
      const ctx = localContext(makeTree(tree));

      const [pkg] = typescriptAdapter.touchedNestedPackages?.(ctx, ['tools/review/src/r.ts']) ?? [];

      expect(pkg).toMatchObject({ commands: [], missing: ['test', 'typecheck'] });
    });

    it('gives a file to its innermost package and keeps deletions out of the dropped sources', () => {
      const ctx = localContext(
        makeTree({
          ...tree,
          'tools/review/inner/package.json': '{}',
          'tools/review/inner/i.ts': '',
        }),
      );

      const packages = typescriptAdapter.touchedNestedPackages?.(ctx, [
        'tools/review/inner/i.ts',
        'tools/review/src/gone.ts',
      ]);

      expect(packages?.map((p) => [p.dir, p.changedFiles, p.droppedSources])).toEqual([
        ['tools/review', ['tools/review/src/gone.ts'], []],
        ['tools/review/inner', ['tools/review/inner/i.ts'], ['tools/review/inner/i.ts']],
      ]);
    });

    it('touches nothing for a package the trusted checkout does not commit', () => {
      const { 'tools/review/package.json': _, ...trusted } = tree;
      const ctx = { measurePath: makeTree(tree), configPath: makeTree(trusted) };

      expect(typescriptAdapter.touchedNestedPackages?.(ctx, ['tools/review/src/r.ts'])).toEqual([]);
    });
  });

  it('drops exactly the nested entries from the coverage report', () => {
    const repo = makeTree({ 'pkg/package.json': '{}', 'pkg/src/b.ts': '', 'pkgs/c.ts': '' });
    const entry = {
      statementMap: { '0': { start: { line: 1 }, end: { line: 1 } } },
      s: { '0': 1 },
    };
    const raw: IstanbulCoverageMap = {
      [join(repo, 'src/a.ts')]: entry,
      [join(repo, 'pkg/src/b.ts')]: entry,
      [join(repo, 'pkg/index.ts')]: entry,
      // A sibling sharing the prefix is not inside the package.
      [join(repo, 'pkgs/c.ts')]: entry,
    };

    expect(Object.keys(rootCoverageReport(raw, localContext(repo)).files).sort()).toEqual([
      'pkgs/c.ts',
      'src/a.ts',
    ]);
  });
});
