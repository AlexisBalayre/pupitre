import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, relative, sep } from 'node:path';
import ts from 'typescript';
import { withoutFiles } from '../core/coverage.utils.js';
import { runGateChild } from '../core/sandbox.utils.js';
import { failureSummary } from './capability.utils.js';
import { nestedPackageDirs } from './git-tree.client.js';
import type {
  Adapter,
  CapabilityContext,
  CapabilityUnavailable,
  CoverageReport,
  DeadExport,
  DepGraph,
  DuplicationReport,
  FileComplexity,
  GateCommand,
  GateStage,
  NestedPackage,
  NestedPackageStage,
} from './types/adapter.types.js';
import type { IstanbulCoverageMap } from './types/istanbul.types.js';
import { istanbulToCoverageReport } from './typescript-coverage.utils.js';
import { COVERAGE_RUN_TIMEOUT_MS } from './typescript-debt.constants.js';
import { findDeadExports, findDuplication, measureComplexity } from './typescript-debt.utils.js';
import {
  isCoverageExcluded,
  isInNestedPackage,
  isSourceFile,
  resolveImport,
  SOURCE_EXTENSIONS,
} from './typescript-source.utils.js';

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

/** Nested packages both checkouts commit, resolved once per capability call (decision 58). */
function nestedPackages({ measurePath, configPath }: CapabilityContext): Set<string> {
  return nestedPackageDirs([measurePath, configPath]);
}

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
  for (const file of walkSourceFiles(ctx.measurePath, nestedPackages(ctx)).sort()) {
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
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
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
  const nested = nestedPackages(ctx);
  return withoutFiles(istanbulToCoverageReport(raw, ctx.measurePath), (file) =>
    isInNestedPackage(file, nested),
  );
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
    const files = walkSourceFiles(repoPath, nestedPackages(ctx)).map((f) => f.split(sep).join('/'));
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
    const nested = nestedPackages(ctx);
    return files.filter(
      (file) =>
        isSourceFile(file) &&
        !isCoverageExcluded(file) &&
        !isInNestedPackage(file, nested) &&
        existsSync(join(ctx.measurePath, file)),
    );
  },

  touchedNestedPackages(ctx: CapabilityContext, files: string[]): NestedPackage[] {
    const nested = nestedPackages(ctx);
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

  coverage(ctx: CapabilityContext): CoverageReport | CapabilityUnavailable {
    const { measurePath, configPath, gateEnv } = ctx;
    // Declared in the trusted manifest, run against the measured checkout: a
    // session cannot switch the stage off by dropping its own devDependency.
    const manifest = readManifest(configPath);
    const deps = { ...manifest?.dependencies, ...manifest?.devDependencies };
    if (!deps.vitest || !(deps['@vitest/coverage-v8'] ?? deps['@vitest/coverage-istanbul'])) {
      return { unavailable: 'no vitest + @vitest/coverage-* in package.json' };
    }
    // Pinned from the trusted manifest. Left to the worktree's config, a
    // session can select `provider: 'custom'` with its own provider module and
    // hand the gate a forged report — 100% covered, every file present — which
    // then ratchets the stored baseline to the forged number (decision 30).
    const provider = deps['@vitest/coverage-v8'] ? 'v8' : 'istanbul';
    const outDir = mkdtempSync(join(tmpdir(), 'pup-coverage-'));
    try {
      // The instrumented run executes the repo's own test suite, so it runs
      // confined like a gate stage — and needs its report directory writable,
      // since the sandbox's default-allow does not survive a TMPDIR under HOME
      // (decisions 28, 36).
      runGateChild(
        'npx',
        [
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
        {
          cwd: measurePath,
          repoPath: configPath,
          writablePaths: [outDir],
          gateEnv,
          timeout: COVERAGE_RUN_TIMEOUT_MS,
        },
      );
      const raw = JSON.parse(
        readFileSync(join(outDir, 'coverage-final.json'), 'utf8'),
      ) as IstanbulCoverageMap;
      return rootCoverageReport(raw, ctx);
    } catch (error) {
      // A failed instrumented run (crash, timeout, threshold config) degrades to
      // "not measured" — the plain test stage has already gated correctness.
      return { unavailable: `instrumented vitest run failed: ${failureSummary(error)}` };
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  },
};
