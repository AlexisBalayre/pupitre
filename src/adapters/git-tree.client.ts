import { runGit } from '../core/git-diff.client.js';
import { GATE_COMMAND_TIMEOUT_MS } from '../core/merge-gate.constants.js';
import type { CapabilityContext } from './types/adapter.types.js';

const MANIFEST = 'package.json';

/**
 * Directories below the measured root that are nested packages: each holds its
 * own committed `package.json`, as a workspace member or a standalone tool does.
 * Such a directory has its own lockfile, test config and runner, so the root
 * runner is not expected to cover it and its exports are consumed by its own
 * entry points, not by the root's modules. Counting it at the root reads its
 * whole source as uncovered and its exports as dead (decision 58), which is the
 * same reason `.worktrees/` is skipped as another checkout.
 *
 * A directory qualifies only when both checkouts commit the marker, which for
 * a merge gate are the pinned checkout and the trusted one (decision 31's
 * AND). Committed, not present on disk and not merely in the index: an
 * untracked `src/core/package.json` dropped into the main checkout from a
 * session shell is diffed and hashed by nothing, and the index of that
 * checkout is the session's to `git add` to as well, so either would buy the
 * exemption in the session's own gate with nothing merged. Reading `HEAD`'s
 * tree also settles what a marker *is*: a symlink, a directory or an empty
 * file is whatever git committed, and there is no filesystem type to check.
 * A checkout git cannot list contributes no markers, so nothing is exempt.
 * The gate's checkout is listed at the sha it was cut at, from the trusted
 * repo's object store, never through the checkout: its HEAD and `commondir`
 * sit in an admin dir under `<common>/worktrees/` a session can rewrite after
 * the cut. A HEAD moved to another commit changed the measured set, one git
 * refuses to open emptied it, which ran no nested package's own stages, and a
 * `commondir` naming a repo of the session's ran that repo's config
 * (decision 101).
 *
 * Resolved once per capability call; callers pass the set down. A client, not a
 * util: it reads git, so it lives apart from the pure path predicates.
 */
export function nestedPackageDirs({
  measurePath,
  configPath,
  measureSha,
}: CapabilityContext): Set<string> {
  const measured =
    measureSha === undefined
      ? committedPackageDirs(measurePath, 'HEAD')
      : committedPackageDirs(configPath, measureSha);
  if (configPath === measurePath) return measured;
  const trusted = committedPackageDirs(configPath, 'HEAD');
  return new Set([...measured].filter((dir) => trusted.has(dir)));
}

function committedPackageDirs(checkout: string, rev: string): Set<string> {
  let listing: string;
  try {
    // Timed out like every other child pup runs: git reads config a session
    // can write, and an untimed read would hang the gate inside the lock.
    listing = runGit(checkout, ['ls-tree', '-r', '-z', '--name-only', rev], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GATE_COMMAND_TIMEOUT_MS,
    });
  } catch {
    return new Set();
  }
  const dirs = new Set<string>();
  for (const path of listing.split('\0')) {
    if (path.endsWith(`/${MANIFEST}`)) dirs.add(path.slice(0, -MANIFEST.length - 1));
  }
  return dirs;
}
