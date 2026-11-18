import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { quotePath } from './debt.service.js';
import { runGit } from './git-diff.client.js';
import { GATE_ENVIRONMENT_DIR } from './merge-gate.constants.js';
import { linkEnvironment } from './merge-gate.service.js';
import { owningLockfile } from './uninstalled-dependency.service.js';

/**
 * Give a remeasure's stand-in, a checkout of `targetSha`, the main checkout's
 * `node_modules` at each of `environments`, as `linkEnvironment` gives the gate
 * checkout its own, each refused first unless it was installed from what the
 * stand-in holds (decision 198).
 */
export function linkStandInEnvironments(
  repoPath: string,
  standIn: string,
  targetSha: string,
  environments: Iterable<string>,
): void {
  for (const rel of environments) {
    refuseForeignEnvironment(repoPath, standIn, targetSha, rel);
    linkEnvironment(repoPath, standIn, rel);
  }
}

/**
 * Refuse to give a remeasure's stand-in, a checkout of `targetSha`, the main
 * checkout's `node_modules` at `rel` unless it was installed from what the
 * stand-in holds. The main checkout need not hold `targetSha`, and past it
 * holds the session's own merge: one that changed the lockfile, or what is
 * committed under `node_modules`, would have the stages measure with tools the
 * session chose, and the adapters' link checks compare against the stand-in,
 * so they would not see it (decision 198). Only where `linkEnvironment` would
 * link: the lockfile that owns `rel` must be in the same place, of the same
 * manager and the same bytes in both, and the main checkout's HEAD must commit
 * exactly what `targetSha` commits under that `node_modules`. A lockfile that
 * is no regular file, a link included, counts as none, and no lockfile refuses.
 */
function refuseForeignEnvironment(
  repoPath: string,
  standIn: string,
  targetSha: string,
  rel: string,
): void {
  const local = join(standIn, rel, GATE_ENVIRONMENT_DIR);
  if (lstatSync(local, { throwIfNoEntry: false })) return;
  if (!existsSync(join(repoPath, rel, GATE_ENVIRONMENT_DIR))) return;
  if (!existsSync(dirname(local))) return;
  const main = owningLockfile(repoPath, rel);
  const base = owningLockfile(standIn, rel);
  const lockfile = (root: string, lock: typeof main) =>
    lock && regularFileBytes(join(root, lock.dir, lock.manager.lockfile));
  const mainBytes = lockfile(repoPath, main);
  const baseBytes = lockfile(standIn, base);
  const installedFromBase =
    main?.dir === base?.dir &&
    main?.manager === base?.manager &&
    mainBytes !== undefined &&
    baseBytes !== undefined &&
    mainBytes.equals(baseBytes);
  const environment = join(rel, GATE_ENVIRONMENT_DIR);
  const committed = (rev: string) =>
    runGit(repoPath, ['ls-tree', '-r', '-z', '--full-tree', rev])
      .split('\0')
      .filter((entry) => {
        const path = entry.slice(entry.indexOf('\t') + 1);
        return path === environment || path.startsWith(`${environment}/`);
      })
      .join('\0');
  const why = !installedFromBase
    ? `was not installed from the lockfile ${targetSha} holds there`
    : committed('HEAD') !== committed(targetSha)
      ? `holds other committed files than ${targetSha} does`
      : undefined;
  if (why === undefined) return;
  throw new Error(
    `${quotePath(environment)} in the main checkout ${why}, so a remeasure against ` +
      `${targetSha} cannot measure with it: its tools could be ones the merge chose. Nothing ` +
      'was landed.',
  );
}

/** A file's bytes when it is a regular file, opened without following a link or blocking. */
function regularFileBytes(path: string): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    return fstatSync(fd).isFile() ? readFileSync(fd) : undefined;
  } finally {
    closeSync(fd);
  }
}
