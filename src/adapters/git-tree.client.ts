import { execFileSync } from 'node:child_process';
import { GIT_SAFE_CONFIG, scrubbedGitEnv } from '../core/git-diff.client.js';
import { GATE_COMMAND_TIMEOUT_MS } from '../core/merge-gate.constants.js';

const MANIFEST = 'package.json';

/** A tree listing is one path per file; 64 MiB is far past any real repo's. */
const LS_TREE_MAX_BUFFER = 64 * 1024 * 1024;

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
 * Resolved once per capability call; callers pass the set down. A client, not a
 * util: it reads git, so it lives apart from the pure path predicates.
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
