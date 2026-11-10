import { execFileSync } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GIT_ENV } from '@test/helpers/git.mock.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { describe, expect, it } from 'vitest';
import { diskRoot, treeRoot, vitestCollection } from './vitest-config.utils.js';

function repoWith(files: Record<string, string>): string {
  const dir = tempDir('pup-vitest-config-');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const configWith = (test: string): string =>
  `import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({\n  test: ${test},\n});\n`;

/**
 * A repo whose object store holds a tree of `entries`, each a name and its
 * mode and content, built by plumbing so two names a case-insensitive disk
 * cannot hold apart can be committed side by side. Returns the repo and tree.
 */
function treeWith(entries: [string, string, string][]): { repo: string; tree: string } {
  const repo = tempDir('pup-vitest-tree-');
  const git = (args: string[], input?: string): string =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', input, env: GIT_ENV }).trim();
  git(['init', '-q']);
  const lines = entries.map(([name, mode, content]) => {
    const oid = git(['hash-object', '-w', '--stdin'], content);
    return `${mode} blob ${oid}\t${name}\n`;
  });
  return { repo, tree: git(['mktree'], lines.join('')) };
}

/** What the run at a checkout of `files` collects of `paths`, or undefined where it is unknown. */
function collected(files: Record<string, string>, paths: string[]): string[] | undefined {
  const read = vitestCollection(diskRoot(repoWith(files)));
  return read && paths.filter(read.collects);
}

// What one vitest run collects, read statically from its config (decision 143).
describe('vitestCollection', () => {
  it('collects only what the include names', () => {
    const files = { 'vitest.config.ts': configWith("{ include: ['src/**/*.test.ts'] }") };

    expect(collected(files, ['src/a.test.ts', 'src/deep/b.test.ts', 'scripts/x.test.ts'])).toEqual([
      'src/a.test.ts',
      'src/deep/b.test.ts',
    ]);
  });

  it("collects vitest's default include, past its default exclude, with no config", () => {
    expect(
      collected({}, [
        'src/a.spec.tsx',
        'b.test.js',
        'src/c.test.mts',
        'src/d.ts',
        'node_modules/pkg/e.test.ts',
        'dist/f.test.ts',
        'vitest.config.test.ts',
      ]),
    ).toEqual(['src/a.spec.tsx', 'b.test.js', 'src/c.test.mts']);
  });

  it('reads vitest.config before vite.config, as vitest does', () => {
    const files = {
      'vite.config.ts': configWith("{ include: ['**/*.test.ts'] }"),
      'vitest.config.mts': configWith("{ include: ['src/**/*.test.ts'] }"),
    };

    expect(collected(files, ['src/a.test.ts', 'scripts/x.test.ts'])).toEqual(['src/a.test.ts']);
  });

  it('drops what an exclude names, as a file or as a directory above it', () => {
    const files = {
      'vitest.config.ts': configWith(
        "{ include: ['src/**/*.test.ts'], exclude: ['src/legacy', 'src/**/slow.test.ts', '**/fixtures/**'] }",
      ),
    };

    expect(
      collected(files, [
        'src/a.test.ts',
        'src/legacy/b.test.ts',
        'src/deep/slow.test.ts',
        'src/fixtures/c.test.ts',
      ]),
    ).toEqual(['src/a.test.ts']);
  });

  it('collects nothing by an include pattern it does not read', () => {
    const files = {
      'vitest.config.ts': configWith(
        "{ include: ['src/*a*b.test.ts', '**/x/**/c.test.ts', 'src/{e,f}.test.ts', './src/g.test.ts', 'src/**/d.test.ts'] }",
      ),
    };

    expect(
      collected(files, [
        'src/ab.test.ts',
        'w/x/y/c.test.ts',
        'src/e.test.ts',
        'src/{e,f}.test.ts',
        'src/g.test.ts',
        'src/d.test.ts',
      ]),
    ).toEqual(['src/d.test.ts']);
  });

  const patterns = (count: number): string =>
    JSON.stringify(Array.from({ length: count }, (_, i) => `x${i}`));

  // Read as the trusted checkout's, the laxer side, so a row fails if its
  // refusal is deleted.
  it.each([
    [
      'a function config',
      "import { defineConfig } from 'vitest/config';\nexport default defineConfig(() => ({}));\n",
    ],
    [
      'its own defineConfig wrapper',
      "const defineConfig = (config) => ({ ...config, test: { ...config.test, exclude: ['src/**'] } });\n" +
        "export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });\n",
    ],
    [
      'a defineConfig imported from elsewhere',
      "import { defineConfig } from './shared.js';\nexport default defineConfig({ test: {} });\n",
    ],
    [
      'another import aliased to defineConfig',
      "import { loadEnv as defineConfig } from 'vite';\nexport default defineConfig({ test: {} });\n",
    ],
    ['an include built at run time', configWith('{ include: patterns }')],
    ['an include over 64 patterns', configWith(`{ include: ${patterns(65)} }`)],
    ['an exclude spreading the defaults', configWith('{ exclude: [...configDefaults.exclude] }')],
    ['an exclude with braces', configWith("{ exclude: ['src/{a,b}.test.ts'] }")],
    ['an exclude with a !', configWith("{ exclude: ['!src/a.test.ts'] }")],
    ['an exclude over 64 patterns', configWith(`{ exclude: ${patterns(65)} }`)],
    ['an exclude climbing with ..', configWith("{ exclude: ['../src/a.test.ts'] }")],
    ['an absolute exclude', configWith("{ exclude: ['/abs/a.test.ts'] }")],
    // Spellings vitest's globber reads otherwise than the pattern says (M3).
    ['an exclude starting ./', configWith("{ exclude: ['./src/prod'] }")],
    ['an exclude ending /', configWith("{ exclude: ['src/prod/'] }")],
    ['an exclude with a . segment', configWith("{ exclude: ['src/./prod'] }")],
    ['an exclude with an empty segment', configWith("{ exclude: ['src//prod'] }")],
    ['an exclude with a ?', configWith("{ exclude: ['src/pro?'] }")],
    ['an exclude with a backslash', configWith("{ exclude: ['src/\\\\prod'] }")],
    ['an exclude with whitespace', configWith("{ exclude: [' src/prod'] }")],
    ['an exclude with an @', configWith("{ exclude: ['src/@prod'] }")],
    ['an empty exclude pattern', configWith("{ exclude: [''] }")],
    [
      'a config that does not parse',
      "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} };\n",
    ],
    ['a spread into test', configWith('{ ...shared }')],
    ['a shorthand include', configWith('{ include }')],
    ['a getter include', configWith("{ get include() { return ['src/**']; } }")],
    ['an include named twice', configWith("{ include: ['nothing/**'], include: ['src/**'] }")],
    ['projects', configWith("{ projects: ['packages/*'] }")],
    ['a test workspace', configWith("{ workspace: ['packages/*'] }")],
    ['a test dir', configWith("{ dir: 'src/core' }")],
    ['a test root', configWith("{ root: 'src' }")],
    ['typecheck', configWith('{ typecheck: { enabled: true, only: true } }')],
    ['a prototype under test', configWith("{ __proto__: { exclude: ['src/**'] } }")],
    ['a root', "export default { root: 'src', test: {} };\n"],
    // Modules the run loads, which in the gate are the branch's.
    [
      'an import of a file',
      `import shared from './shared.js';\n${configWith("{ include: ['src/**/*.test.ts'] }")}`,
    ],
    [
      'a re-export of a file',
      `export * from './shared.js';\n${configWith("{ include: ['src/**/*.test.ts'] }")}`,
    ],
    ['setupFiles', configWith("{ setupFiles: ['./setup.ts'] }")],
    ['globalSetup', configWith("{ globalSetup: 'global.ts' }")],
    ['reporters', configWith("{ reporters: ['./reporter.ts'] }")],
    ['an environment', configWith("{ environment: './env.ts' }")],
    ['a runner', configWith("{ runner: './runner.ts' }")],
    ['a pool', configWith("{ pool: './pool.ts' }")],
    ['poolOptions', configWith("{ poolOptions: { forks: { execArgv: ['--import=./x.js'] } } }")],
    ['execArgv', configWith("{ execArgv: ['--import=./x.js'] }")],
    ['a sequencer', configWith("{ sequence: { sequencer: './sequencer.ts' } }")],
    [
      'plugins',
      "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ plugins: [], test: {} });\n",
    ],
    ['a prototype', "export default { __proto__: { test: { exclude: ['src/**'] } } };\n"],
  ])('collects nothing under %s', (_, config) => {
    expect(vitestCollection(diskRoot(repoWith({ 'vitest.config.ts': config })))).toBeUndefined();
  });

  // This repo's own: the gate compares it across checkouts rather than run it.
  it('reads a config that runs code and imports packages', () => {
    const files = {
      'vitest.config.ts':
        "import { availableParallelism } from 'node:os';\n" +
        configWith(
          "{ include: ['src/**/*.test.ts'], maxWorkers: Math.max(2, availableParallelism()) }",
        ),
    };

    expect(collected(files, ['src/a.test.ts', 'b.test.ts'])).toEqual(['src/a.test.ts']);
  });

  // A `.` stops at a line break, so `src/**`'s `.*(?:/.*)?$` would backtrack
  // over every `/` before one, quadratically.
  it('collects no path holding a line break, in linear time', () => {
    const files = {
      'vitest.config.ts': configWith("{ include: ['**/*.test.ts'], exclude: ['src/**'] }"),
    };
    const collects = vitestCollection(diskRoot(repoWith(files)))?.collects;
    const started = Date.now();

    for (const breaks of ['\n', '\r', '\u2028', '\u2029']) {
      expect(collects?.(`src/${'a/'.repeat(20_000)}${breaks}x.test.ts`)).toBe(false);
    }
    expect(collects?.('lib/a\nb.test.ts')).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it.each(['vitest.workspace.ts', 'Vitest.Workspace.ts', 'VITEST.WORKSPACE.JSON'])(
    'collects nothing beside a workspace file named %s',
    (name) => {
      expect(
        vitestCollection(diskRoot(repoWith({ [name]: 'export default [];\n' }))),
      ).toBeUndefined();
    },
  );

  it('refuses to read a config that is a symlink', () => {
    const repo = repoWith({ 'real.config.ts': configWith("{ include: ['src/**/*.test.ts'] }") });
    symlinkSync('real.config.ts', join(repo, 'vitest.config.ts'));

    expect(() => vitestCollection(diskRoot(repo))).toThrow();
  });

  // A case-insensitive disk opens it for vitest.config.ts; a case-sensitive one does not.
  it('refuses to read a config named in another case', () => {
    const repo = repoWith({ 'Vitest.config.ts': configWith("{ include: ['src/**/*.test.ts'] }") });

    expect(() => vitestCollection(diskRoot(repo))).toThrow();
  });

  it("reads a commit's config from the object store, whatever the disk holds", () => {
    const { repo, tree } = treeWith([
      ['vitest.config.ts', '100644', configWith("{ include: ['src/**/*.test.ts'] }")],
    ]);
    writeFileSync(join(repo, 'vitest.config.ts'), configWith("{ include: ['**/*.test.ts'] }"));
    const collects = vitestCollection(treeRoot(repo, tree))?.collects;

    expect(['src/a.test.ts', 'b.test.ts'].filter((path) => collects?.(path))).toEqual([
      'src/a.test.ts',
    ]);
  });

  it.each([
    ['a link', [['vitest.config.ts', '120000', 'real.config.ts']]],
    [
      'two names that fold to one',
      [
        ['vitest.config.ts', '100644', configWith("{ include: ['src/**/*.test.ts'] }")],
        ['VITEST.config.ts', '100644', configWith("{ include: ['**/*.test.ts'] }")],
      ],
    ],
  ] as [string, [string, string, string][]][])(
    "refuses to read a commit's config that is %s",
    (_, entries) => {
      const { repo, tree } = treeWith(entries);

      expect(() => vitestCollection(treeRoot(repo, tree))).toThrow();
    },
  );

  // Vitest runs the branch's config, so the gate reads its lists only where
  // the rest of it is the trusted one's: `config` is that rest.
  const configOf = (config: string): string | undefined =>
    vitestCollection(diskRoot(repoWith({ 'vitest.config.ts': config })))?.config;
  const trusted = configWith("{ include: ['src/**/*.test.ts'], maxWorkers: 2 }");

  it('gives two configs that differ only in their lists one rest', () => {
    expect(
      configOf(
        configWith("{ include: [\n    'src/a/**', // and lib\n    'lib/**',\n  ], maxWorkers: 2 }"),
      ),
    ).toBe(configOf(trusted));
    expect(configOf(configWith('{ include: [], maxWorkers: 2 }'))).toBe(configOf(trusted));
  });

  it.each([
    ['another key', configWith("{ include: ['src/**/*.test.ts'], maxWorkers: 2, retry: 3 }")],
    ['another value', configWith("{ include: ['src/**/*.test.ts'], maxWorkers: 3 }")],
    [
      'an assignment in a value',
      configWith(
        "{ include: ['src/**/*.test.ts'], maxWorkers: (Object.prototype.exclude = ['src/**'], 2) }",
      ),
    ],
    [
      'another import',
      "import { availableParallelism } from 'node:os';\n" +
        configWith("{ include: ['src/**/*.test.ts'], maxWorkers: 2 }"),
    ],
    [
      'an exclude added',
      configWith("{ include: ['src/**/*.test.ts'], exclude: [], maxWorkers: 2 }"),
    ],
    ['another config file', trusted],
  ])('tells apart a config with %s', (name, config) => {
    const other =
      name === 'another config file'
        ? vitestCollection(diskRoot(repoWith({ 'vite.config.ts': config })))?.config
        : configOf(config);

    expect(other).toBeDefined();
    expect(other).not.toBe(configOf(trusted));
  });
});
