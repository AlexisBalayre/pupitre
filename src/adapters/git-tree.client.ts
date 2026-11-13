import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { rethrowIfKilled, runGit } from '../core/git-diff.client.js';
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
 * Outside the gate, a directory that is no repository and a repository with
 * no commit yet, as `pup init` meets, commit no markers, so nothing is
 * exempt. Any other listing that fails throws, and at the gate, both shas
 * given, every one does, so the gate refuses: an empty trusted set would run
 * no nested package's own stages, and a session can fail that listing alone,
 * by a `.git/config` git cannot parse, and mend it
 * before the gate's last check (decision 161).
 * The trusted checkout is listed at the target sha the gate pinned under the
 * merge lock, not at its HEAD: a session can detach `.git/HEAD` to a commit
 * with no nested marker while the listing runs and restore it before the
 * gate's last check, and no nested package's own stages would run. A context
 * pinning one sha and not the other is refused, not read: either side it
 * leaves unpinned would be listed at a HEAD the session can move.
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
  configSha,
}: CapabilityContext): Set<string> {
  const gate = measureSha !== undefined;
  if (gate !== (configSha !== undefined)) {
    throw new Error(
      'A gate lists nested packages at both pinned shas, the cut and the target; this ' +
        'context pins one and not the other, so nothing was listed.',
    );
  }
  const measured = committedPackageDirs(
    gate ? configPath : measurePath,
    measureSha ?? 'HEAD',
    gate,
  );
  if (configPath === measurePath) return measured;
  const trusted = committedPackageDirs(configPath, configSha ?? 'HEAD', gate);
  return new Set([...measured].filter((dir) => trusted.has(dir)));
}

function committedPackageDirs(checkout: string, rev: string, gate: boolean): Set<string> {
  let listing: string;
  try {
    // Timed out like every other child pup runs: git reads config a session
    // can write, and an untimed read would hang the gate inside the lock.
    // `--full-tree`: a `core.worktree` a session sets in the trusted checkout's
    // shared config after the gate's check runs git there from a subdirectory,
    // and a plain `ls-tree` lists that prefix alone, no nested package among
    // it (decision 161).
    listing = runGit(checkout, ['ls-tree', '--full-tree', '-r', '-z', '--name-only', rev], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GATE_COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    rethrowIfKilled(error);
    const repo = lstatSync(join(checkout, '.git'), { throwIfNoEntry: false }) !== undefined;
    if (gate || (repo && !unbornHead(checkout, rev))) throw error;
    return new Set();
  }
  const dirs = new Set<string>();
  for (const path of listing.split('\0')) {
    if (path.endsWith(`/${MANIFEST}`)) dirs.add(path.slice(0, -MANIFEST.length - 1));
  }
  return dirs;
}

/**
 * Whether `rev` is the `HEAD` of a repository with no commit yet. Exit 1 is
 * `--verify --quiet`'s "no such ref"; a repository git cannot open, its config
 * unparsable or its `core.worktree` empty, exits 128 and is not unborn.
 */
function unbornHead(checkout: string, rev: string): boolean {
  if (rev !== 'HEAD') return false;
  try {
    runGit(checkout, ['rev-parse', '--verify', '--quiet', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GATE_COMMAND_TIMEOUT_MS,
    });
    return false;
  } catch (error) {
    rethrowIfKilled(error);
    return typeof error === 'object' && error !== null && 'status' in error && error.status === 1;
  }
}
