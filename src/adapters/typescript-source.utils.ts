import { execFileSync } from 'node:child_process';
import { dirname, join, normalize } from 'node:path';
import { GIT_SAFE_CONFIG, scrubbedGitEnv } from '../core/git-diff.client.js';
import { GATE_COMMAND_TIMEOUT_MS } from '../core/merge-gate.constants.js';

const MANIFEST = 'package.json';

/** A tree listing is one path per file; 64 MiB is far past any real repo's. */
const LS_TREE_MAX_BUFFER = 64 * 1024 * 1024;

export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'];

export function isSourceFile(name: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)) && !name.endsWith('.d.ts');
}

/**
 * Whether a file holds tests rather than the code under test: the `*.test.ts`
 * suffix, and nothing else (decision 39).
 *
 * The narrowness is the design. Exempting a file hides it from the duplication
 * and dead-export metrics, and that is only safe when something forces the file
 * to actually hold tests. `*.test.ts` is what a vitest `include` conventionally
 * collects, so parking production code there makes the runner hard-fail the
 * test stage with "No test suite found in file" — self-limiting. A `*.spec.ts`
 * this project's runner does not collect, or a `tests/` directory outside its
 * include glob, is collected by nothing: either would buy exemption for free on
 * ordinary importable code, renamed in with a `git mv` that no hook sees. A
 * real test under a `tests/` layout is `tests/foo.test.ts`, which the suffix
 * already covers, so a directory arm would only ever add the unsuffixed files —
 * the attack and nothing else.
 *
 * The cost is a repo whose tests are named or placed some other way: its
 * fixture repetition gets counted rather than hidden, which is the safe
 * direction to be wrong in. Widening it means corroborating against the trusted
 * checkout's runner config rather than the path's spelling — decision 31's
 * pattern, not a longer regex.
 *
 * Deliberately *not* `isCoverageExcluded`, which answers "should a coverage
 * report mention this?" and so also swallows `dist/`, `build/` and named tool
 * configs. Those are not tests, and duplication across two `tailwind.config.ts`
 * files is still duplication.
 */
export function isTestFile(path: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(path);
}

/**
 * Files a coverage report is not expected to mention. Kept deliberately narrow
 * and matched against what vitest and istanbul actually exclude: named tool
 * configs rather than every `*.config.*`, and the artifact and test directories
 * anchored where the tools anchor them. A looser rule would be a hiding place —
 * `config` is a valid role suffix in this repo, so `src/core/gate.config.ts` is
 * ordinary production code that must still be covered (decision 30).
 *
 * `.worktrees/` is here because it is *another checkout of this same repo*, not
 * because it is generated. Measuring the main checkout while sessions are open
 * would otherwise count every session's copy of every source file, so the
 * repo's ratio would move with how many sessions happen to exist. The python
 * adapter already skips it for the same reason.
 */
export function isCoverageExcluded(path: string): boolean {
  return (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(?:^|\/)(?:vite|vitest|webpack|rollup|jest|karma|babel|nyc|tsup|eslint|prettier|cypress|playwright|ava|tailwind|postcss)\.config\.[cm]?[jt]s$/.test(
      path,
    ) ||
    /^(?:dist|build|coverage|tests?)\//.test(path) ||
    /(?:^|\/)(?:node_modules|__tests__|__mocks__|\.worktrees)\//.test(path)
  );
}

/**
 * Directories below the measured root that are nested packages: each holds its
 * own committed `package.json`, as a workspace member or a standalone tool does.
 * Such a directory has its own lockfile, test config and runner, so the root
 * runner is not expected to cover it and its exports are consumed by its own
 * entry points, not by the root's modules. Counting it at the root reads its
 * whole source as uncovered and its exports as dead (decision 58), which is the
 * same reason `.worktrees/` is skipped as another checkout.
 *
 * A directory qualifies only when every checkout given commits the marker,
 * which for a merge gate is the worktree and the trusted checkout (decision
 * 31's AND). Committed, not present on disk and not merely in the index: an
 * untracked `src/core/package.json` dropped into the main checkout from a
 * session shell is diffed and hashed by nothing, and the index of that
 * checkout is the session's to `git add` to as well, so either would buy the
 * exemption in the session's own gate with nothing merged. Reading `HEAD`'s
 * tree also settles what a marker *is*: a symlink, a directory or an empty
 * file is whatever git committed, and there is no filesystem type to check.
 * A checkout git cannot list contributes no markers, so nothing is exempt.
 *
 * Resolved once per capability call; callers pass the set down.
 */
export function nestedPackageDirs(checkouts: string[]): Set<string> {
  const [first = new Set<string>(), ...rest] = [...new Set(checkouts)].map(committedPackageDirs);
  return new Set([...first].filter((dir) => rest.every((dirs) => dirs.has(dir))));
}

function committedPackageDirs(checkout: string): Set<string> {
  let listing: string;
  try {
    // Timed out like every other child pup runs: git reads config a session
    // can write, and an untimed read would hang the gate inside the lock.
    listing = execFileSync(
      'git',
      [...GIT_SAFE_CONFIG, '-C', checkout, 'ls-tree', '-r', '-z', '--name-only', 'HEAD'],
      {
        encoding: 'utf8',
        env: scrubbedGitEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: GATE_COMMAND_TIMEOUT_MS,
        maxBuffer: LS_TREE_MAX_BUFFER,
      },
    );
  } catch {
    return new Set();
  }
  const dirs = new Set<string>();
  for (const path of listing.split('\0')) {
    if (path.endsWith(`/${MANIFEST}`)) dirs.add(path.slice(0, -MANIFEST.length - 1));
  }
  return dirs;
}

/** Whether a repo-relative file sits inside one of `nested` (see `nestedPackageDirs`). */
export function isInNestedPackage(file: string, nested: Set<string>): boolean {
  const dirs = file.split('/').slice(0, -1);
  return dirs.some((_, i) => nested.has(dirs.slice(0, i + 1).join('/')));
}

/**
 * Resolve a relative import specifier to a repo file. Tries the literal path,
 * `.js`->`.ts` and `.js`->`.tsx` (ESM-style extensioned imports of TS sources:
 * under NodeNext a `.tsx` module is imported as `.js` too, so a `.ts`-only
 * mapping read every component of the first `.tsx` files as unimported and
 * their exports as dead), appended extensions, and directory index files.
 */
export function resolveImport(
  fromFile: string,
  specifier: string,
  files: Set<string>,
): string | undefined {
  const base = normalize(join(dirname(fromFile), specifier));
  if (base.startsWith('..')) return undefined;
  const candidates = [base];
  if (/\.js$/.test(base)) {
    candidates.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
  }
  if (/\.jsx$/.test(base)) candidates.push(base.replace(/\.jsx$/, '.tsx'));
  for (const ext of SOURCE_EXTENSIONS) candidates.push(`${base}${ext}`);
  for (const ext of SOURCE_EXTENSIONS) candidates.push(join(base, `index${ext}`));
  return candidates.find((c) => files.has(c));
}
