import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, relative, sep } from 'node:path';
import ts from 'typescript';
import { withoutFiles } from '../core/coverage.utils.js';
import { GATE_ENVIRONMENT_DIR } from '../core/merge-gate.constants.js';
import { GateInterruptedError, removeGateDir, runGateChild } from '../core/sandbox.utils.js';
import { failureSummary, isUnavailable, readPlainFile } from './capability.utils.js';
import { configLoadsAFile } from './config-module.utils.js';
import { COVERAGE_RUN_TIMEOUT_MS } from './constants/typescript-debt.constants.js';
import { nestedPackageDirs } from './git-tree.client.js';
import {
  PACKAGE_MANAGER_CONFIG,
  runsAFile,
  userConfigRunsAFile,
} from './package-manager-config.utils.js';
import { diskRoot, NON_ASCII, treeEntriesMatching, treeRoot } from './root-files.utils.js';
import type {
  Adapter,
  CapabilityContext,
  CapabilityUnavailable,
  CoverageReport,
  CoveredTestRun,
  DeadExport,
  DepGraph,
  DuplicationReport,
  FailingTest,
  FileComplexity,
  GateCommand,
  GateStage,
  NestedPackage,
  NestedPackageStage,
  RootFiles,
} from './types/adapter.types.js';
import type { IstanbulCoverageMap } from './types/istanbul.types.js';
import type { PackageManifest } from './types/package-manifest.types.js';
import type { PathAliases } from './types/typescript-source.types.js';
import { istanbulToCoverageReport } from './typescript-coverage.utils.js';
import { findDeadExports, findDuplication, measureComplexity } from './typescript-debt.utils.js';
import {
  isCoverageExcluded,
  isInNestedPackage,
  isSourceFile,
  parsePathAliases,
  resolveImport,
  SOURCE_EXTENSIONS,
} from './typescript-source.utils.js';
import { vitestCollection } from './vitest-config.utils.js';

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
 * The root entries, by lower-cased name, that may decide what a vitest run
 * does: a class of the shapes a tool's config takes, not a list of the files
 * each tool loads by convention, which a review found one more of each round.
 * Every dot-named entry but `.git` (each tool's rc file, the env files, yarn's
 * Plug'n'Play runtime and `.yarn`, pnpm's hooks file, the `.config` directory
 * lilconfig and cosmiconfig search), every `*.config.*` (vite's, vitest's,
 * PostCSS's, tailwind's, babel's), vitest's workspace files, every root
 * `.json`, `.json5`, `.jsonc`, `.yaml`, `.yml`, `.toml`, `.lock` and `.lockb`
 * (the manifest, `tsconfig.json`, `pnpm-workspace.yaml`, `bunfig.toml`, the
 * lockfiles) and `browserslist`. A directory is read whole. A bare `*rc` is
 * no shape of its own: every rc convention is a dotfile, and it would take
 * `src`.
 */
const VITEST_RUN_INPUT =
  /^(?!\.git$)(?:\.[^/]*|[^/]*\.config\.[^/]*|vite(?:st)?\.(?:workspace|projects)\.[^/]*|[^/]*\.(?:json[5c]?|ya?ml|toml|lockb?)|browserslist)$/;

/** A run input that is a module, which may load others as it runs. */
const MODULE_CONFIG = /\.[cm]?[jt]sx?$/;

/**
 * Root entries that load code by what they name, which comparing their text
 * with the target's would not make the target's: yarn's Plug'n'Play runtime,
 * which resolves packages without the `node_modules` the gate links and
 * checks, from a cache the branch may commit; pnpm's hooks file,
 * `.pnpmfile.cjs` or `.pnpmfile.mjs`, which pnpm requires as it reads its
 * config; and PostCSS's config, `postcss.config.*`, any `.postcssrc*`, or one
 * in a `.config` directory, which vite loads into the vitest process for a
 * test's CSS import, and whose plugins, even in a JSON or YAML one, may be
 * named by a path to the branch's file.
 */
const ROOT_RUNTIME = /^(?:\.pnp(?:mfile)?\.|postcss\.config\.|\.postcssrc|\.config$)/;

/**
 * What vitest and vite write in `node_modules` as they run, which the gate does
 * not link: their caches, and the `.vite-temp` vite bundles an ESM config
 * into, under a fresh name each run.
 */
const RUN_CACHE = /^\.(?:cache|vite|vite-temp)$/;

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
  return sha === undefined ? diskRoot(path, ctx.configPath) : treeRoot(ctx.configPath, sha);
}

/**
 * Whether a `node_modules` entry the trusted checkout's lacks is one the gate
 * lets stand: a dot-named one, which no package can be named, such as the
 * build info `tsc -b` may write there, but none the run itself loads, in any
 * case, nor one named outside ASCII, which APFS may fold onto one the run
 * loads (`NON_ASCII`: `.hookſ` onto `.hooks`). A package may still load one
 * by name, as `@prisma/client` loads `.prisma/client`, but from its own real
 * path, the trusted checkout's.
 */
function unloadedEntry(trusted: string, name: string): boolean {
  return (
    name.startsWith('.') &&
    !NON_ASCII.test(name) &&
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
 * Whether a run input may load a file the branch wrote, though the target
 * commits the same text: a package-manager config by a key (`runsAFile`), or
 * a module of any tool by what it imports (`configLoadsAFile`).
 */
function inputLoadsAFile(name: string, text: string, selfName: string | undefined): boolean {
  return (
    (PACKAGE_MANAGER_CONFIG.test(name) && runsAFile(name, text)) ||
    (MODULE_CONFIG.test(name) && configLoadsAFile(text, selfName))
  );
}

/**
 * What a plain vitest run over `root` collects, with the manifest's run fields
 * and every other run input (`VITEST_RUN_INPUT`) beside the config it compares
 * across checkouts, the vitest configs aside, whose lists are read on each
 * side; undefined where it is unknown, where a run input may load a file
 * (`inputLoadsAFile`), where an entry that loads code by what it names stands
 * at the root (`ROOT_RUNTIME`), or where the manifest holds a `postcss` field,
 * PostCSS's config too. Throws where the root cannot be read.
 */
function plainVitestCollection(root: RootFiles): ReturnType<typeof vitestCollection> {
  const manifest = parsedManifest(root);
  const selfName = typeof manifest?.name === 'string' ? manifest.name : undefined;
  const inputs = runInputs(root, VITEST_RUN_INPUT);
  const collection =
    runsPlainVitest(manifest) &&
    !(manifest && 'postcss' in manifest) &&
    !inputs.some(([name, text]) => inputLoadsAFile(name, text, selfName)) &&
    ![...root.keys()].some((name) => ROOT_RUNTIME.test(name))
      ? vitestCollection(root)
      : undefined;
  const compared = inputs.filter(
    ([name]) => name !== 'package.json' && !VITEST_CONFIG_FILE.test(name),
  );
  return (
    collection && {
      ...collection,
      config: JSON.stringify([collection.config, runFields(manifest as PackageManifest), compared]),
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
 * A path with a `node_modules` segment, in any case: node resolves a package
 * from the nearest one above the importing file, below the root too, so a
 * branch that commits one there hands its own code to whatever imports it.
 */
const NODE_MODULES_PATH = /(?:^|\/)node_modules(?:\/|$)/i;

/**
 * The paths the branch must leave as the target holds them, at the root or
 * below: every `tsconfig*.json` and `jsconfig*.json`, in any case, since
 * tsconfck reads the nearest one above each file vite transforms, below the
 * root too, and its compiler options can have a transform import code, as
 * `jsxImportSource` names the module each JSX file imports; and every path
 * holding a character outside ASCII (`NON_ASCII`), which APFS may fold onto
 * such a tsconfig or onto a `node_modules` segment (`src/tſconfig.json`,
 * `src/node_moduleſ/x.js`). A non-ASCII path the target holds alike is the
 * target's, so only one the branch adds, removes or changes costs the split.
 */
const KEPT_PATH = /(?:^|\/)[jt]sconfig[^/]*\.json$|[\u0080-￿]/i;

/**
 * A checkout's `KEPT_PATH` files: listed from the commit it holds where it
 * has one, as `rootAt` reads the root, else each of `files` it names read
 * from disk, without following a link, or null where none stands. Throws
 * where one cannot be read.
 */
function keptPathsAt(
  ctx: CapabilityContext,
  path: string,
  sha: string | undefined,
  files: string[],
): string {
  if (sha !== undefined) return treeEntriesMatching(ctx.configPath, sha, KEPT_PATH);
  return JSON.stringify(
    files
      .filter((file) => KEPT_PATH.test(file))
      .sort()
      .map((file) => {
        const at = join(path, file);
        const stands = lstatSync(at, { throwIfNoEntry: false }) !== undefined;
        return [file, stands ? readPlainFile(at, { followLinks: false }) : null];
      }),
  );
}

/**
 * Whether the branch leaves every `KEPT_PATH` file as the target holds it, at
 * the root or below: one it adds, removes or changes anywhere, or one that
 * cannot be read, costs the split.
 */
function keptPathsShared(ctx: CapabilityContext, files: string[]): boolean {
  try {
    return (
      keptPathsAt(ctx, ctx.configPath, ctx.configSha, files) ===
      keptPathsAt(ctx, ctx.measurePath, ctx.measureSha, files)
    );
  } catch {
    return false;
  }
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

/**
 * A failed test or test file as vitest's summary names it, ` FAIL  <file> > <test>`
 * or ` FAIL  <file> [ <file> ]` for a file that failed as a whole, past a
 * project's label (`|name|`, or the padded one a coloured run prints); or the
 * header jest prints over a file's failures, `FAIL <file> (1.2 s)`.
 */
const RUNNER_FAIL_LINE =
  /^\s*FAIL\s+(?:\|[^|]+\|\s+|\S+ {2,}(?=\S))?(\S+)(?: > (.+?)| \[ .+ \]| \([\d.]+ m?s\))?\s*$/;
/** jest's header over a file whose every test passed. */
const JEST_PASS_LINE = /^\s*PASS\s/;
/** A failed test under jest's `FAIL` header, `● <describe> › <test>`. */
const JEST_FAILED_TEST = /^\s*● (.+?)\s*$/;
/** jest's `●` blocks that name no test: logged output, and a file that failed as a whole. */
const JEST_NOT_A_TEST = new Set(['Console', 'Test suite failed to run']);

/** The failed tests vitest's or jest's summary in `output` names, in order, each once. */
function failingTests(output: string): FailingTest[] {
  const named = new Map<string, FailingTest>();
  const key = (file: string, test?: string): string => JSON.stringify([file, test ?? null]);
  // The file whose jest header the lines below sit under; a `PASS` header ends it.
  let jestFile: string | undefined;
  for (const line of output.split('\n')) {
    const fail = RUNNER_FAIL_LINE.exec(line);
    if (fail?.[1]) {
      const [, file, test] = fail;
      named.set(key(file, test), test ? { file, test } : { file });
      jestFile = test ? undefined : file;
      continue;
    }
    if (JEST_PASS_LINE.test(line)) jestFile = undefined;
    const test = jestFile && JEST_FAILED_TEST.exec(line)?.[1];
    if (!jestFile || !test || JEST_NOT_A_TEST.has(test)) continue;
    // A header whose tests are named is no file that failed as a whole.
    named.delete(key(jestFile));
    named.set(key(jestFile, test), { file: jestFile, test });
  }
  return [...named.values()];
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
    if (
      !trusted ||
      measured?.config !== trusted.config ||
      aliasesAScope(ctx, trusted.aliases) ||
      files.some((file) => NODE_MODULES_PATH.test(file)) ||
      !keptPathsShared(ctx, files)
    ) {
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
    // by every name that folds to one and by object name, so a root lockfile
    // of any size compares (decision 143).
    if (ctx.measureSha === undefined) return true;
    const byObjectName = { byObjectName: true };
    try {
      return (
        environmentLinked(ctx) &&
        !userConfigRunsAFile(ctx) &&
        JSON.stringify(
          runInputs(diskRoot(ctx.measurePath, ctx.configPath, byObjectName), VITEST_RUN_INPUT),
        ) ===
          JSON.stringify(
            runInputs(treeRoot(ctx.configPath, ctx.measureSha, byObjectName), VITEST_RUN_INPUT),
          )
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

  failingTests,
};
