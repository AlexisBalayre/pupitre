import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import ts from 'typescript';
import type {
  Adapter,
  DeadExport,
  DepGraph,
  DuplicationReport,
  FileComplexity,
  GateCommand,
  GateStage,
} from './types/adapter.types.js';
import { findDeadExports, findDuplication, measureComplexity } from './typescript-debt.utils.js';
import { isSourceFile, resolveImport } from './typescript-source.utils.js';

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

const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.worktrees',
  '.claude',
]);

function walkSourceFiles(repoPath: string, dir = repoPath, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        walkSourceFiles(repoPath, join(dir, entry.name), found);
      }
    } else if (isSourceFile(entry.name)) {
      found.push(relative(repoPath, join(dir, entry.name)));
    }
  }
  return found;
}

/** Repo-relative `/`-separated path -> content, sorted for deterministic metrics. */
function readSources(repoPath: string): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const file of walkSourceFiles(repoPath).sort()) {
    sources[file.split(sep).join('/')] = readFileSync(join(repoPath, file), 'utf8');
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
  depGraph(repoPath: string): DepGraph {
    const files = walkSourceFiles(repoPath).map((f) => f.split(sep).join('/'));
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

  deadCode(repoPath: string): DeadExport[] {
    const sources = readSources(repoPath);
    return findDeadExports(sources, manifestEntryFiles(repoPath, new Set(Object.keys(sources))));
  },

  duplication(repoPath: string): DuplicationReport {
    return findDuplication(readSources(repoPath));
  },

  complexity(repoPath: string, files: string[]): FileComplexity[] {
    return files
      .filter((file) => isSourceFile(file) && existsSync(join(repoPath, file)))
      .map((file) => ({
        file,
        complexity: measureComplexity(file, readFileSync(join(repoPath, file), 'utf8')),
      }));
  },
};
