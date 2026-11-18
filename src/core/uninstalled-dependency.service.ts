import { existsSync, lstatSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parse } from 'yaml';
import { readPlainFile } from '../adapters/capability.utils.js';
import type { NestedPackage } from '../adapters/types/adapter.types.js';
import { quotePath } from './debt.service.js';
import { globToRegExp } from './glob.utils.js';
import { GATE_ENVIRONMENT_DIR } from './merge-gate.constants.js';
import { shellWord } from './shell-quote.utils.js';

const NPM = { name: 'npm', lockfile: 'package-lock.json', dirFlag: '--prefix' };

/**
 * Each package manager the adapter resolves, in its order: the lockfile it
 * writes, and how it names the directory to install in.
 */
const PACKAGE_MANAGERS = [
  { name: 'pnpm', lockfile: 'pnpm-lock.yaml', dirFlag: '--dir' },
  { name: 'yarn', lockfile: 'yarn.lock', dirFlag: '--cwd' },
  NPM,
];

/**
 * Whether the workspace rooted at `root` lists `dir` as a member, in the main
 * checkout: by the `packages` globs of its `pnpm-workspace.yaml` for pnpm, by
 * its manifest's `workspaces` for npm and yarn, a `!` glob dropping what the
 * others match. A root that lists none, or whose file cannot be read, has no
 * members: its install never writes `dir`'s dependencies.
 */
function listsMember(repoPath: string, root: string, manager: typeof NPM, dir: string): boolean {
  let globs: unknown;
  try {
    if (manager.name === 'pnpm') {
      globs = parse(readPlainFile(join(repoPath, root, 'pnpm-workspace.yaml')))?.packages;
    } else {
      const { workspaces } = JSON.parse(readPlainFile(join(repoPath, root, 'package.json')));
      globs = workspaces?.packages ?? workspaces;
    }
  } catch {
    return false;
  }
  if (!Array.isArray(globs)) return false;
  const member = relative(root, dir);
  const matching = globs.filter(
    (glob): glob is string =>
      typeof glob === 'string' && globToRegExp(glob.replace(/^!/, '')).test(member),
  );
  return (
    matching.some((glob) => !glob.startsWith('!')) && !matching.some((glob) => glob.startsWith('!'))
  );
}

/**
 * The lockfile in the main checkout that installs `dir`, and the manager that
 * wrote it: `dir`'s own, or, for a workspace member, which keeps none, the
 * nearest one above when its workspace lists `dir`. A package below a
 * lockfile whose workspace does not list it installs on its own, as the
 * adapter runs it: undefined, as for a package with no lockfile anywhere.
 */
export function owningLockfile(
  repoPath: string,
  dir: string,
): { dir: string; manager: typeof NPM } | undefined {
  for (let rel = dir; ; rel = dirname(rel)) {
    const manager = PACKAGE_MANAGERS.find(({ lockfile }) =>
      existsSync(join(repoPath, rel, lockfile)),
    );
    if (manager) {
      return rel === dir || listsMember(repoPath, rel, manager, dir)
        ? { dir: rel, manager }
        : undefined;
    }
    if (rel === '.') return undefined;
  }
}

/**
 * Refuse a nested package whose stages would run with no environment: one
 * the trusted manifest gives a dependency that resolves from no
 * `node_modules` the gate links, the package's own or, for a workspace
 * member, its workspace root's, and the pinned tree commits none either.
 * A package whose owning lockfile sits beside a Yarn Plug'n'Play runtime in
 * the pinned tree is never refused: it resolves from yarn's cache, and the
 * install this would name writes no `node_modules` to clear the refusal.
 * `linkEnvironment` would link nothing, and the stage would fail on a runner
 * it cannot find, which reads as the branch's fault. It throws, like a
 * timeout under load: the operator installs, with the manager and in the
 * directory the owning lockfile names, npm in the package itself when none
 * owns it, and the session has nothing to fix (decision 138). Read from
 * `config`, the main checkout or a remeasure's stand-in for it given the main
 * checkout's environment (decision 198); the install is named in `repoPath`.
 */
export function refuseUninstalled(
  repoPath: string,
  config: string,
  checkout: string,
  pkg: NestedPackage,
): void {
  if (pkg.commands.length === 0) return;
  if (existsSync(join(config, pkg.dir, GATE_ENVIRONMENT_DIR))) return;
  if (lstatSync(join(checkout, pkg.dir, GATE_ENVIRONMENT_DIR), { throwIfNoEntry: false })) return;
  // Parsed without a guard: the adapter read `commands` from this same file.
  const manifest: { dependencies?: object; devDependencies?: object } = JSON.parse(
    readPlainFile(join(config, pkg.dir, 'package.json')),
  );
  const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  // Nothing to install: a manager writes the lockfile and no `node_modules`.
  if (declared.length === 0) return;
  const lock = owningLockfile(config, pkg.dir);
  // Yarn's Plug'n'Play runtime resolves from its cache and no install writes
  // a `node_modules`: the stages resolve through the one the pinned tree holds.
  if (
    lock &&
    ['.pnp.cjs', '.pnp.js'].some((name) =>
      lstatSync(join(checkout, lock.dir, name), { throwIfNoEntry: false }),
    )
  ) {
    return;
  }
  // Only a member, with no lockfile of its own, has its dependencies hoisted:
  // to the workspace root holding its lockfile. A package no lockfile owns
  // still resolves from the repo root's. The gate links both.
  const root = lock?.dir ?? '.';
  if (
    root !== pkg.dir &&
    declared.every((name) => existsSync(join(config, root, GATE_ENVIRONMENT_DIR, name)))
  ) {
    return;
  }
  // No lockfile owns it: npm in the package itself, as the adapter runs it.
  const { dir, manager } = lock ?? { dir: pkg.dir, manager: NPM };
  // A remeasure's stand-in has only what was linked into it from the main
  // checkout, and what lands there is a land, not a merge.
  const [where, outcome, retry] =
    config === repoPath
      ? ['in the main checkout', 'nothing was merged', 'merge again']
      : [
          'in the main checkout to link into the checkout of the target',
          'nothing was landed',
          'remeasure again',
        ];
  throw new Error(
    `${quotePath(pkg.dir)} has no ${GATE_ENVIRONMENT_DIR} ${where}, so its ` +
      `${pkg.commands.map((c) => c.stage).join(' and ')} stages cannot find their tools; ` +
      `${outcome}. Install it with \`${manager.name} ${manager.dirFlag} ` +
      `${shellWord(quotePath(dir))} install\` in ${shellWord(repoPath)}, then ${retry}.`,
  );
}
