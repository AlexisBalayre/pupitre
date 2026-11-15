import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, normalize, relative, sep } from 'node:path';
import ts from 'typescript';
import { withoutFiles } from '../core/coverage.utils.js';
import { GATE_ENVIRONMENT_DIR } from '../core/merge-gate.constants.js';
import { GateInterruptedError, removeGateDir, runGateChild } from '../core/sandbox.utils.js';
import { failureSummary, isUnavailable, readPlainFile } from './capability.utils.js';
import { nestedPackageDirs } from './git-tree.client.js';
import type {
  Adapter,
  CapabilityContext,
  CapabilityUnavailable,
  CoverageReport,
  CoveredTestRun,
  DeadExport,
  DepGraph,
  DuplicationReport,
  FileComplexity,
  GateCommand,
  GateStage,
  NestedPackage,
  NestedPackageStage,
  RootFiles,
} from './types/adapter.types.js';
import type { IstanbulCoverageMap } from './types/istanbul.types.js';
import { istanbulToCoverageReport } from './typescript-coverage.utils.js';
import { COVERAGE_RUN_TIMEOUT_MS } from './typescript-debt.constants.js';
import { findDeadExports, findDuplication, measureComplexity } from './typescript-debt.utils.js';
import {
  isCoverageExcluded,
  isInNestedPackage,
  isSourceFile,
  type PathAliases,
  parsePathAliases,
  resolveImport,
  SOURCE_EXTENSIONS,
} from './typescript-source.utils.js';
import { diskRoot, treeRoot, vitestCollection } from './vitest-config.utils.js';

interface PackageManifest {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  main?: string;
  module?: string;
  types?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
}

const GATE_STAGES: GateStage[] = ['build', 'test', 'lint'];

/** What a nested package must declare for the gate to measure it (decision 59). */
const NESTED_STAGES: NestedPackageStage[] = ['test', 'typecheck'];

const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.worktrees',
  '.claude',
]);

function walkSourceFiles(
  repoPath: string,
  nested: Set<string>,
  dir = repoPath,
  found: string[] = [],
): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        !SKIPPED_DIRS.has(entry.name) &&
        !entry.name.startsWith('.') &&
        !nested.has(relative(repoPath, path).split(sep).join('/'))
      ) {
        walkSourceFiles(repoPath, nested, path, found);
      }
    } else if (isSourceFile(entry.name)) {
      found.push(relative(repoPath, path));
    }
  }
  return found;
}

/** Repo-relative `/`-separated path -> content, sorted for deterministic metrics. */
function readSources(ctx: CapabilityContext): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const file of walkSourceFiles(ctx.measurePath, nestedPackageDirs(ctx)).sort()) {
    sources[file.split(sep).join('/')] = readFileSync(join(ctx.measurePath, file), 'utf8');
  }
  return sources;
}

function collectExportPaths(value: unknown, found: string[]): void {
  if (typeof value === 'string') {
    found.push(value);
  } else if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) collectExportPaths(nested, found);
  }
}

/**
 * Files package.json declares as entry points (main/module/types/bin/exports)
 * — their exports are consumed from outside the repo, so dead-export analysis
 * must not count them. Built `.js` targets map back to their `.ts` source.
 */
function manifestEntryFiles(repoPath: string, fileSet: Set<string>): Set<string> {
  const manifest = readManifest(repoPath);
  const declared: string[] = [];
  if (manifest) {
    for (const field of [manifest.main, manifest.module, manifest.types]) {
      if (field) declared.push(field);
    }
    if (typeof manifest.bin === 'string') declared.push(manifest.bin);
    else if (manifest.bin) declared.push(...Object.values(manifest.bin));
    collectExportPaths(manifest.exports, declared);
  }
  const entries = new Set<string>();
  for (const raw of declared) {
    const path = normalize(raw).split(sep).join('/');
    for (const candidate of [path, path.replace(/\.js$/, '.ts')]) {
      if (fileSet.has(candidate)) entries.add(candidate);
    }
  }
  return entries;
}

function moduleId(file: string): string {
  const dir = dirname(file);
  return dir === '.' ? '(root)' : dir.split(sep).join('/');
}

function readManifest(repoPath: string): PackageManifest | undefined {
  const manifestPath = join(repoPath, 'package.json');
  if (!existsSync(manifestPath)) return undefined;
  return JSON.parse(readPlainFile(manifestPath)) as PackageManifest;
}

/**
 * The root `tsconfig.json`'s `paths`, read from the measured checkout and not
 * the trusted one: a branch that introduces an alias also imports through it,
 * and the trusted tsconfig would read those imports as unresolved and the
 * exports as dead. That is safe to take from the session because an alias
 * marks nothing used that a relative import from the same file could not.
 * A missing or unreadable tsconfig means no aliases.
 */
function readPathAliases(repoPath: string): PathAliases {
  const tsconfigPath = join(repoPath, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) return new Map();
  try {
    return parsePathAliases(readPlainFile(tsconfigPath));
  } catch {
    return new Map();
  }
}

function packageManager(repoPath: string): string {
  if (existsSync(join(repoPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(repoPath, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/**
 * The instrumented run's report, restricted to the root's own files. The include
 * glob reaches into nested packages, whose own runner covers them; this drops
 * them with the same predicate as `coverableFiles`, so report and expectation
 * cannot drift (decisions 32, 58). Exported for its test: it is the one join a
 * unit test can reach without an instrumented vitest run.
 */
export function rootCoverageReport(
  raw: IstanbulCoverageMap,
  ctx: CapabilityContext,
): CoverageReport {
  const nested = nestedPackageDirs(ctx);
  return withoutFiles(istanbulToCoverageReport(raw, ctx.measurePath), (file) =>
    isInNestedPackage(file, nested),
  );
}

/** The `test` scripts the instrumented run reproduces exactly. */
const PLAIN_VITEST_SCRIPT = /^vitest(?: run)?$/;

/**
 * Whether a checkout's `test` script is the plain vitest run, with no pre or
 * post script around it: what the folded run repeats (decision 95) and what the
 * diff-size split reads the collection of (decision 143). Throws on a manifest
 * that cannot be read.
 */
function runsPlainVitest(manifest: PackageManifest | undefined): boolean {
  const scripts = manifest?.scripts ?? {};
  return (
    PLAIN_VITEST_SCRIPT.test(scripts.test?.trim() ?? '') &&
    scripts.pretest === undefined &&
    scripts.posttest === undefined
  );
}

/**
 * The root entries, by lower-cased name, that decide what a vitest run
 * collects: the manifest whose script starts it, the npm, yarn, pnpm and bun
 * configs and env files that can change how that script runs, yarn's
 * Plug'n'Play runtime (`.pnp.cjs`, `.pnp.loader.mjs`) and its `.yarn`
 * directory, read whole, and every config and workspace file vitest or vite
 * reads.
 */
const VITEST_RUN_INPUT =
  /^(?:package\.json|\.npmrc|\.yarnrc(?:\.yml)?|\.env(?:\.[^/]*)?|\.pnp\.[^/]*|\.yarn|pnpm-workspace\.yaml|bunfig\.toml|vite(?:st)?\.(?:config|workspace|projects)\.[^/]*)$/;

/**
 * The npm, yarn, pnpm and bun configs among the run inputs, which the branch
 * may commit, and the env files: `.env.yarn`, which Yarn 4 injects into every
 * script's environment by default, and every `.env*`, which bun loads.
 */
const PACKAGE_MANAGER_CONFIG =
  /^(?:\.npmrc|\.yarnrc(?:\.yml)?|\.env(?:\.[^/]*)?|pnpm-workspace\.yaml|bunfig\.toml)$/;

/**
 * A key, in any of their spellings, by which a package-manager config has the
 * test script run a file, which in the gate is the branch's even where the
 * config is the target's: yarn's own binary and plugins, a node option such
 * as `--import`, the shell scripts run in, bun's preloads, and the env files
 * yarn injects, which may set any of these.
 */
const RUNS_A_FILE =
  /yarn[-_]?path|plugins|node[-_]?options|script[-_]?shell|preload|inject[-_]?environment[-_]?files/i;

/**
 * A `$` in a key, the text of a line that is not a comment before its first
 * `=` or `:`, which npm substitutes from the environment, so `${KEY}=` may
 * spell any key.
 */
const KEY_SUBSTITUTION = /^(?![ \t]*[#;])[^=:\r\n\u2028\u2029]*\$/m;

/**
 * Keys, normalised by `configKey`, that have npm read another config, which
 * nothing here checks: `globalconfig`, `userconfig`, the `prefix` whose
 * `etc/npmrc` is the global config, npm reading the global one last, after
 * the project and user configs that can move it, and the `DESTDIR` variable
 * npm puts in front of the global prefix.
 */
const CONFIG_NAMING_KEYS = new Set(['globalconfig', 'userconfig', 'prefix', 'destdir']);

/**
 * A line's key, reduced at least as far as npm's ini parser and dotenv reduce
 * it, and further, so that a spelling either reads as one of
 * `CONFIG_NAMING_KEYS` reduces to it: the text before the first `=`, trimmed
 * as JavaScript's `trim` trims (a BOM, `\f`, `\v`, U+00A0, U+2000-200A,
 * U+3000), without an `export`, cut at the first `;` or `#` (an unquoted ini
 * key ends there), `:` (a YAML key) or whitespace (a `.yarnrc` key), without
 * quotes or a `[]` (an ini array key), in lower case, without an
 * `npm_config_` and without `-` and `_`. Reducing further only refuses more.
 */
function configKey(line: string): string {
  return (line.split('=')[0] as string)
    .trim()
    .replace(/^export\s+/i, '')
    .split(/[;#:\s]/)[0]
    ?.replace(/["'[\]]/g, '')
    .toLowerCase()
    .replace(/^npm[-_]config[-_]/, '')
    .replace(/[-_]/g, '') as string;
}

/** Whether a config or env file has a line whose key names another config (`CONFIG_NAMING_KEYS`). */
function namesAConfig(text: string): boolean {
  return text.split(/[\r\n]+/).some((line) => CONFIG_NAMING_KEYS.has(configKey(line)));
}

/**
 * Whether a package-manager config or env file may have the run load a file:
 * it names one of `RUNS_A_FILE`'s keys as text, names another config
 * (`namesAConfig`), or holds a backslash, by which each of these formats
 * escapes a character of a key, quoted or not (`"yarn\u0050ath"`), or a
 * substitution in a key. Read as text rather than parsed as each package
 * manager parses it, so a value with an escape costs the split too.
 */
function runsAFile(text: string): boolean {
  return (
    RUNS_A_FILE.test(text) ||
    namesAConfig(text) ||
    text.includes('\\') ||
    KEY_SUBSTITUTION.test(text)
  );
}

/**
 * Yarn's Plug'n'Play runtime, which yarn loads into every script it runs. It
 * resolves packages without the `node_modules` the gate links and checks, from
 * a cache the branch may commit, so where it stands the run is the branch's.
 */
const PNP_RUNTIME = /^\.pnp\./;

/** What vitest and vite write in `node_modules` as they run, which the gate does not link. */
const RUN_CACHE = /^\.(?:cache|vite)$/;

/**
 * Dot-named `node_modules` entries a run loads: the binaries a script runs by
 * name, and the `.hooks` npm 6 and older ran around each script.
 */
const RUN_LOADED_DOT_ENTRIES = ['.bin', '.hooks'];

/**
 * A checkout's root as the diff-size split reads it: from the commit it holds
 * where it has one, the target's for the trusted checkout and the pinned one
 * for the gate's (decision 143), since a session can write either disk; from
 * disk outside the gate.
 */
function rootAt(ctx: CapabilityContext, path: string, sha: string | undefined): RootFiles {
  return sha === undefined ? diskRoot(path) : treeRoot(ctx.configPath, sha);
}

/**
 * Whether a `node_modules` entry the trusted checkout's lacks is one the gate
 * lets stand: a dot-named one, which no package can be named, such as the
 * build info `tsc -b` may write there, but none the run itself loads, in any
 * case. A package may still load one by name, as `@prisma/client` loads
 * `.prisma/client`, but from its own real path, the trusted checkout's.
 */
function unloadedEntry(trusted: string, name: string): boolean {
  return (
    name.startsWith('.') &&
    !RUN_LOADED_DOT_ENTRIES.includes(name.toLowerCase()) &&
    lstatSync(join(trusted, name), { throwIfNoEntry: false }) === undefined
  );
}

/**
 * Whether the gate checkout's `node_modules` still links each entry to the
 * trusted checkout's, as the gate made it: one replaced runs the branch's
 * vitest, or a package it loads. A run cache, or an entry no run loads, may
 * stand beside them.
 */
function environmentLinked({ configPath, measurePath }: CapabilityContext): boolean {
  const local = join(measurePath, GATE_ENVIRONMENT_DIR);
  const trusted = join(configPath, GATE_ENVIRONMENT_DIR);
  const stat = lstatSync(local, { throwIfNoEntry: false });
  if (stat === undefined) return !existsSync(trusted);
  return (
    stat.isDirectory() &&
    readdirSync(local).every(
      (name) =>
        RUN_CACHE.test(name) ||
        unloadedEntry(trusted, name) ||
        readlinkSync(join(local, name)) === join(trusted, name),
    )
  );
}

/**
 * The root entries `pattern` names, by name, each read. Throws where one
 * cannot be read.
 */
function runInputs(root: RootFiles, pattern: RegExp): [string, string][] {
  const inputs = [...root].filter(([name]) => pattern.test(name));
  return inputs.map(([name, read]): [string, string] => [name, read()]).sort();
}

function parsedManifest(root: RootFiles): PackageManifest | undefined {
  const read = root.get('package.json');
  return read && (JSON.parse(read()) as PackageManifest);
}

/**
 * Manifest fields `pm run test` does not read: the dependency maps, which the
 * `node_modules` the gate links from the trusted checkout answers whatever the
 * branch declares, and the scripts, whose test ones `runsPlainVitest` reads
 * on each side.
 */
const NOT_RUN_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'scripts',
];

/**
 * The manifest's fields that may shape the run, compared across checkouts:
 * `packageManager`, a `pnpm` or `config` block, `type`, `imports` and the
 * rest. A key the branch reorders counts as a change.
 */
function runFields(manifest: PackageManifest): [string, unknown][] {
  return Object.entries(manifest).filter(([field]) => !NOT_RUN_FIELDS.includes(field));
}

/**
 * What a plain vitest run over `root` collects, with the manifest's run fields
 * and the package-manager configs beside the config it compares across
 * checkouts; undefined where it is unknown, where one of those configs may run
 * a file (`runsAFile`), or where yarn's Plug'n'Play runtime stands at the
 * root. Throws where the root cannot be read.
 */
function plainVitestCollection(root: RootFiles): ReturnType<typeof vitestCollection> {
  const manifest = parsedManifest(root);
  const managers = runInputs(root, PACKAGE_MANAGER_CONFIG);
  const collection =
    runsPlainVitest(manifest) &&
    !managers.some(([, text]) => runsAFile(text)) &&
    ![...root.keys()].some((name) => PNP_RUNTIME.test(name))
      ? vitestCollection(root)
      : undefined;
  return (
    collection && {
      ...collection,
      config: JSON.stringify([collection.config, runFields(manifest as PackageManifest), managers]),
    }
  );
}

/**
 * Whether a `resolve.alias` key names a scope the trusted `node_modules` holds,
 * which the gate links into its checkout: the alias would redirect that
 * scope's packages to the branch's modules.
 */
function aliasesAScope({ configPath }: CapabilityContext, aliases: string[]): boolean {
  return aliases.some(
    (key) =>
      lstatSync(join(configPath, GATE_ENVIRONMENT_DIR, key), { throwIfNoEntry: false }) !==
      undefined,
  );
}

/**
 * The user-level `.npmrc` npm and pnpm read for the gate's run: the one the
 * operator names by `npm_config_userconfig` through `--gate-env`, or the one
 * in the home directory the gate's environment keeps.
 */
function userNpmrc({ gateEnv = [] }: CapabilityContext): string {
  const named = gateEnv.find((name) => name.toLowerCase() === 'npm_config_userconfig');
  return (named && process.env[named]) || join(homedir(), '.npmrc');
}

/** The largest user-level `.npmrc` read: any real one is a few lines. */
const USER_CONFIG_MAX_BYTES = 64 * 1024;

/**
 * The user-level `.npmrc` at `path`, opened without following a link and
 * without blocking, so a link, a fifo or a device is never read through: only
 * a regular file whose size on the descriptor is at most
 * `USER_CONFIG_MAX_BYTES`, read for at most one byte more, so a sparse file
 * of any size is never loaded. Throws on anything else, the descriptor closed
 * on every path that holds one.
 */
function readUserConfig(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > USER_CONFIG_MAX_BYTES) {
      throw new Error(`${path} is not a regular file of at most ${USER_CONFIG_MAX_BYTES} bytes`);
    }
    const buffer = Buffer.alloc(USER_CONFIG_MAX_BYTES + 1);
    let length = 0;
    for (let read = -1; read !== 0 && length < buffer.length; length += read) {
      read = readSync(fd, buffer, length, buffer.length - length, null);
    }
    if (length > USER_CONFIG_MAX_BYTES) throw new Error(`${path} grew past the cap as it was read`);
    return buffer.toString('utf8', 0, length);
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether the user-level `.npmrc` may have the run load a file
 * (`runsAFile`): a session can write it, and no commit holds it. Read only as
 * `readUserConfig` reads it; throws where anything else stands there, or it
 * cannot be read.
 */
function userConfigRunsAFile(ctx: CapabilityContext): boolean {
  const path = userNpmrc(ctx);
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return false;
  return runsAFile(readUserConfig(path));
}

/** The config files vitest reads at a package root. */
const VITEST_CONFIG_FILE = /^vite(?:st)?\.(?:config|workspace|projects)\.[cm]?[jt]s$/;

/**
 * Whether a vitest or vite config at `repoPath` mentions coverage thresholds.
 * Read as text, since it only decides whether to fold, and a config it cannot
 * read counts as declaring them, which keeps the two runs.
 */
function declaresCoverageThresholds(repoPath: string): boolean {
  return readdirSync(repoPath).some((name) => {
    if (!VITEST_CONFIG_FILE.test(name)) return false;
    try {
      return readPlainFile(join(repoPath, name)).includes('thresholds');
    } catch {
      return true;
    }
  });
}

/**
 * The instrumented vitest run behind `coverage` and `coveredTest`, or why the
 * trusted manifest allows none. Its report directory exists from here on, and
 * `dispose` removes it.
 */
function instrumentedRun(ctx: CapabilityContext): CoveredTestRun | CapabilityUnavailable {
  // Declared in the trusted manifest, run against the measured checkout: a
  // session cannot switch the stage off by dropping its own devDependency.
  const manifest = readManifest(ctx.configPath);
  const deps = { ...manifest?.dependencies, ...manifest?.devDependencies };
  if (!deps.vitest || !(deps['@vitest/coverage-v8'] ?? deps['@vitest/coverage-istanbul'])) {
    return { unavailable: 'no vitest + @vitest/coverage-* in package.json' };
  }
  // Pinned from the trusted manifest. Left to the worktree's config, a
  // session can select `provider: 'custom'` with its own provider module and
  // hand the gate a forged report — 100% covered, every file present — which
  // then ratchets the stored baseline to the forged number (decision 30).
  const provider = deps['@vitest/coverage-v8'] ? 'v8' : 'istanbul';
  // The grant is the report directory, inside one of the gate's own that is
  // never granted. A child can remove the report directory, as a failing run
  // does, or put a symlink there, and the re-run's profile resolves the grant's
  // parent: one no child can remove keeps the name the gate's (decision 108).
  const holder = mkdtempSync(join(tmpdir(), 'pup-coverage-'));
  const outDir = join(holder, 'report');
  try {
    mkdirSync(outDir);
  } catch (error) {
    removeGateDir(holder);
    throw error;
  }
  return {
    command: 'npx',
    args: [
      '--no-install',
      'vitest',
      'run',
      '--coverage.enabled',
      `--coverage.provider=${provider}`,
      // Vitest 3+ reports only files a test loaded. Without this, a module
      // no test imports is absent rather than 0%-covered, which turns an
      // untested file into "not in the report" instead of a precise patch
      // coverage flag — and makes every type-only module look hidden.
      `--coverage.include=**/*.{${SOURCE_EXTENSIONS.map((ext) => ext.slice(1)).join(',')}}`,
      '--coverage.reporter=json',
      `--coverage.reportsDirectory=${outDir}`,
    ],
    writablePaths: [outDir],
    report: () => {
      try {
        const raw = JSON.parse(
          readFileSync(join(outDir, 'coverage-final.json'), 'utf8'),
        ) as IstanbulCoverageMap;
        return rootCoverageReport(raw, ctx);
      } catch (error) {
        return { unavailable: `instrumented vitest run failed: ${failureSummary(error)}` };
      }
    },
    dispose: () => removeGateDir(holder),
  };
}

export const typescriptAdapter: Adapter = {
  id: 'typescript',

  detect(repoPath: string): boolean {
    const manifest = readManifest(repoPath);
    if (!manifest) return false;
    return (
      existsSync(join(repoPath, 'tsconfig.json')) ||
      Boolean(manifest.devDependencies?.typescript ?? manifest.dependencies?.typescript)
    );
  },

  gateCommands(repoPath: string): GateCommand[] {
    const manifest = readManifest(repoPath);
    const scripts = manifest?.scripts ?? {};
    const hasTypescript = Boolean(
      manifest?.devDependencies?.typescript ?? manifest?.dependencies?.typescript,
    );
    const pm = packageManager(repoPath);
    const commands: GateCommand[] = [];
    for (const stage of GATE_STAGES) {
      if (scripts[stage]) {
        commands.push({ stage, command: pm, args: ['run', stage] });
      } else if (
        stage === 'build' &&
        hasTypescript &&
        existsSync(join(repoPath, 'tsconfig.json'))
      ) {
        // --no-install: bare `npx tsc` in a repo without typescript would
        // auto-install the deprecated `tsc` squatter package from npm.
        commands.push({ stage, command: 'npx', args: ['--no-install', 'tsc', '--noEmit'] });
      }
    }
    return commands;
  },

  /**
   * Module-level import graph via `ts.preProcessFile` — the syntax-only
   * scanner behind the docs-blessed ts-morph/dependency-cruiser stack, so no
   * tsconfig or full parse is needed. Only relative, in-repo imports become
   * edges; package imports are ignored. Windows separators normalize to `/`.
   */
  depGraph(ctx: CapabilityContext): DepGraph {
    const repoPath = ctx.measurePath;
    const files = walkSourceFiles(repoPath, nestedPackageDirs(ctx)).map((f) =>
      f.split(sep).join('/'),
    );
    const fileSet = new Set(files);
    const modules: Record<string, string[]> = {};
    const edgeSet = new Set<string>();
    for (const file of files) {
      const id = moduleId(file);
      modules[id] ??= [];
      modules[id].push(file);
      const info = ts.preProcessFile(readFileSync(join(repoPath, file), 'utf8'), true, true);
      for (const imported of info.importedFiles) {
        if (!imported.fileName.startsWith('.')) continue;
        const resolved = resolveImport(file, imported.fileName, fileSet);
        if (!resolved) continue;
        const target = moduleId(resolved);
        if (target !== id) edgeSet.add(`${id}\0${target}`);
      }
    }
    for (const moduleFiles of Object.values(modules)) moduleFiles.sort();
    return {
      modules,
      edges: [...edgeSet].sort().map((pair) => {
        const [from, to] = pair.split('\0');
        return { from: from as string, to: to as string };
      }),
    };
  },

  deadCode(ctx: CapabilityContext): DeadExport[] {
    const sources = readSources(ctx);
    // Entry points come from the trusted manifest: a session that declares its
    // own dead export an entry point would otherwise hide it from the ratchet.
    return findDeadExports(
      sources,
      manifestEntryFiles(ctx.configPath, new Set(Object.keys(sources))),
      readPathAliases(ctx.measurePath),
    );
  },

  duplication(ctx: CapabilityContext): DuplicationReport {
    return findDuplication(readSources(ctx));
  },

  complexity({ measurePath: repoPath }: CapabilityContext, files: string[]): FileComplexity[] {
    return files
      .filter((file) => isSourceFile(file) && existsSync(join(repoPath, file)))
      .map((file) => ({
        file,
        complexity: measureComplexity(file, readFileSync(join(repoPath, file), 'utf8')),
      }));
  },

  coverableFiles(ctx: CapabilityContext, files: string[]): string[] {
    const nested = nestedPackageDirs(ctx);
    return files.filter(
      (file) =>
        isSourceFile(file) &&
        !isCoverageExcluded(file) &&
        !isInNestedPackage(file, nested) &&
        existsSync(join(ctx.measurePath, file)),
    );
  },

  testFiles(ctx: CapabilityContext, files: string[]): string[] {
    // Both checkouts: the trusted one is what the gate trusts, and the measured
    // one is what the test stage's run reads, so a branch that narrows its own
    // include or exclude leaves a file vitest never collects, which then fails
    // nothing when it holds no test (decisions 31, 143). A nested package's file
    // is its own runner's (decision 58). Unknown on either side collects nothing.
    // Vitest runs the branch's config, so its lists count only where the rest
    // of it, and the package-manager configs the script runs under, are the
    // trusted one's.
    const [trusted, measured] = (
      [
        [ctx.configPath, ctx.configSha],
        [ctx.measurePath, ctx.measureSha],
      ] as const
    ).map(([path, sha]) => {
      try {
        return plainVitestCollection(rootAt(ctx, path, sha));
      } catch {
        return undefined;
      }
    });
    if (!trusted || measured?.config !== trusted.config || aliasesAScope(ctx, trusted.aliases)) {
      return [];
    }
    const nested = nestedPackageDirs(ctx);
    return files.filter(
      (file) =>
        !isInNestedPackage(file, nested) &&
        [trusted, measured].every((side) => side.collects(file)),
    );
  },

  testInputsIntact(ctx: CapabilityContext): boolean {
    // The test stage ran vitest over the checkout's disk, which the branch's
    // build had run in, while `testFiles` reads the commit: they answer for the
    // same run only where the disk still holds the commit's inputs, compared
    // by every name that folds to one (decision 143).
    if (ctx.measureSha === undefined) return true;
    try {
      return (
        environmentLinked(ctx) &&
        !userConfigRunsAFile(ctx) &&
        JSON.stringify(runInputs(diskRoot(ctx.measurePath, ctx.configPath), VITEST_RUN_INPUT)) ===
          JSON.stringify(runInputs(treeRoot(ctx.configPath, ctx.measureSha), VITEST_RUN_INPUT))
      );
    } catch {
      return false;
    }
  },

  touchedNestedPackages(ctx: CapabilityContext, files: string[]): NestedPackage[] {
    const nested = nestedPackageDirs(ctx);
    const touched = new Map<string, string[]>();
    for (const file of files) {
      // The innermost package owns the file: its runner is the one that tests it.
      const [dir] = [...nested]
        .filter((candidate) => isInNestedPackage(file, new Set([candidate])))
        .sort((a, b) => b.length - a.length);
      if (dir !== undefined) touched.set(dir, [...(touched.get(dir) ?? []), file]);
    }
    return [...touched.keys()].sort().map((dir) => {
      const changedFiles = touched.get(dir) as string[];
      // Scripts from the trusted checkout, as `gateCommands` resolves the root's
      // (decision 11): a session that deletes one flags the stage, not skips it.
      const trusted = join(ctx.configPath, dir);
      const scripts = readManifest(trusted)?.scripts ?? {};
      const pm = packageManager(trusted);
      const declared = NESTED_STAGES.filter((stage) => scripts[stage]);
      return {
        dir,
        changedFiles,
        droppedSources: changedFiles.filter(
          (file) => isSourceFile(file) && existsSync(join(ctx.measurePath, file)),
        ),
        commands: declared.map((stage) => ({ stage, command: pm, args: ['run', stage] })),
        missing: NESTED_STAGES.filter((stage) => !scripts[stage]),
      };
    });
  },

  async coverage(ctx: CapabilityContext): Promise<CoverageReport | CapabilityUnavailable> {
    const run = instrumentedRun(ctx);
    if (isUnavailable(run)) return run;
    try {
      // The instrumented run executes the repo's own test suite, so it runs
      // confined like a gate stage — and needs its report directory writable,
      // since the sandbox's default-allow does not survive a TMPDIR under HOME
      // (decisions 28, 36).
      await runGateChild(run.command, run.args, {
        cwd: ctx.measurePath,
        repoPath: ctx.configPath,
        writablePaths: run.writablePaths,
        gateEnv: ctx.gateEnv,
        timeout: COVERAGE_RUN_TIMEOUT_MS,
      });
      return run.report();
    } catch (error) {
      if (error instanceof GateInterruptedError) throw error;
      // A failed instrumented run (crash, timeout, threshold config) degrades to
      // "not measured" — the plain test stage has already gated correctness.
      return { unavailable: `instrumented vitest run failed: ${failureSummary(error)}` };
    } finally {
      run.dispose();
    }
  },

  coveredTest(ctx: CapabilityContext): CoveredTestRun | undefined {
    // Only a test script that is the plain run the instrumented one repeats:
    // `vitest` runs once outside a terminal, as every gate child is. Flags,
    // another runner or a pre/post script would make the two different runs,
    // and the test stage would then pass on a run nobody made (decision 95).
    // A threshold fails an instrumented run whose every test passed, and the
    // test stage would then fail on a figure: such a repo keeps the two runs,
    // its coverage run alone failing on the threshold, as before. Both
    // checkouts are asked: the trusted one decides whether the gate may fold,
    // and the measured one is what `pm run test` there would have run, so a
    // session that edits its own scripts or config keeps the two runs.
    for (const path of new Set([ctx.configPath, ctx.measurePath])) {
      try {
        if (!runsPlainVitest(readManifest(path)) || declaresCoverageThresholds(path))
          return undefined;
      } catch {
        return undefined;
      }
    }
    // The folded run starts vitest through `npx --no-install`, which finds it
    // only here: a Plug'n'Play install has no such binary, and its test script,
    // started by its package manager, would pass where the folded run fails.
    if (!existsSync(join(ctx.measurePath, 'node_modules', '.bin', 'vitest'))) return undefined;
    const run = instrumentedRun(ctx);
    return isUnavailable(run) ? undefined : run;
  },
};
