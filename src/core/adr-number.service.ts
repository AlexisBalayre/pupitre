import type { Database } from 'better-sqlite3';
import { sanitizeReason } from '../adapters/capability.utils.js';
import { quotePath } from './debt.service.js';
import { rethrowIfKilled, runGit } from './git-diff.client.js';
import { newestMerge, resolveCommitIfPresent, timedSince } from './merge-gate.service.js';
import { listSessions } from './session.repository.js';
import { holdingStates } from './session-state.utils.js';
import type { GateStageResult } from './types/merge-gate.types.js';

export const ADR_NUMBER_STAGE = 'adr-number';

const ADR_DIR = 'docs/adr/';
/**
 * `docs/adr/` as a diff pathspec git cannot shift: `top` anchors it at the repo
 * root whatever cwd prefix a session-set `core.worktree` gives git, `literal`
 * keeps it free of globs, and `icase` takes `docs/ADR/` too, which a
 * case-insensitive checkout lands in the same folder.
 */
const ADR_PATHSPEC = ':(top,literal,icase)docs/adr/';
/**
 * A decision file, `docs/adr/NNNN-*.md`, its number captured. Case-insensitive,
 * for the same reason as `ADR_PATHSPEC`.
 */
const ADR_DECISION = /^docs\/adr\/([0-9]{4})-[^/]*\.md$/i;
/** The last segment of a path, where a decision's number starts. */
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The highest number a decision file can carry: `ADR_DECISION` takes four digits. */
const MAX_DECISION = 9999;
/**
 * The most decisions another session branch is checked for. One adding more is
 * left unchecked with a note, so a branch squatting a range of numbers cannot
 * refuse every peer's gate with it.
 */
const MAX_PEER_DECISIONS = 3;
/** How long one read of another session's branch may take under the merge lock. */
const PEER_READ_TIMEOUT_MS = 10_000;

/** A decision path's number, undefined for any other path. */
function decisionNumber(path: string): number | undefined {
  const number = ADR_DECISION.exec(path)?.[1];
  return number === undefined ? undefined : Number(number);
}

/**
 * The files `tip` adds under `docs/adr/` over its merge base with `base`.
 * Rename detection is off, so a decision renumbered with `git mv` counts as
 * the add of its new name; colour and external diffs are off, so a
 * session-written config cannot change what the listing prints. Only
 * `docs/adr/` is listed, so a branch's other files are never buffered, and the
 * names are the root's (`--no-relative`, `ADR_PATHSPEC`), so a session-set
 * `core.worktree` or `diff.relative` cannot empty the listing.
 */
function addedAdrPaths(repoPath: string, base: string, tip: string, timeout?: number): string[] {
  return runGit(
    repoPath,
    [
      'diff',
      '--no-ext-diff',
      '--no-color',
      '--no-relative',
      '--no-renames',
      '--diff-filter=A',
      '-z',
      '--name-only',
      `${base}...${tip}`,
      '--',
      ADR_PATHSPEC,
    ],
    timeout === undefined ? {} : { timeout },
  )
    .split('\0')
    .filter(Boolean);
}

/** The decision files among `paths`, with their numbers. */
function decisionsOf(paths: string[]): Map<string, number> {
  const decisions = new Map<string, number>();
  for (const path of paths) {
    const number = decisionNumber(path);
    if (number !== undefined) decisions.set(path, number);
  }
  return decisions;
}

/**
 * The decision files `tip` renames over its merge base with `base`, keyed by
 * the new path, to the old one, whatever number the new path has. One keeping
 * its number is a slug rename, the same decision under a new name. Git pairs
 * the two paths by content (`--find-renames`, its default 50% similarity), so
 * a branch that deletes a decision and adds an unrelated one under its number
 * is not a rename and stays refused.
 */
function decisionRenames(repoPath: string, base: string, tip: string): Map<string, string> {
  const fields = runGit(repoPath, [
    'diff',
    '--no-ext-diff',
    '--no-color',
    '--no-relative',
    '--find-renames',
    '--diff-filter=R',
    '-z',
    '--name-status',
    `${base}...${tip}`,
    '--',
    ADR_PATHSPEC,
  ]).split('\0');
  const renamed = new Map<string, string>();
  // `R<score>\0<from>\0<to>` per rename.
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [from, to] = [fields[i + 1] as string, fields[i + 2] as string];
    if (decisionNumber(from) !== undefined) renamed.set(to, from);
  }
  return renamed;
}

/**
 * Whether `error` is a git child Node killed for overrunning its timeout or its
 * output buffer. Node kills it with SIGTERM, the signal `rethrowIfKilled` reads
 * as an interrupt, so this is asked first: an overrun is the branch's doing,
 * not the operator's Ctrl-C.
 */
function isOverrun(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
  return code === 'ETIMEDOUT' || code === 'ENOBUFS';
}

/**
 * The decisions another session's branch adds, or why it is not checked: git
 * could not resolve or diff it (an orphan, a symbolic ref, an overrun), or it
 * adds more than `MAX_PEER_DECISIONS`. Undefined when the branch does not
 * exist. An interrupt that killed git is rethrown.
 */
function peerDecisions(
  repoPath: string,
  targetSha: string,
  ref: string,
): Map<string, number> | string | undefined {
  try {
    const tip = resolveCommitIfPresent(repoPath, ref);
    if (tip === undefined) return undefined;
    const theirs = decisionsOf(addedAdrPaths(repoPath, targetSha, tip, PEER_READ_TIMEOUT_MS));
    return theirs.size > MAX_PEER_DECISIONS
      ? `it adds ${theirs.size} decisions, more than the ${MAX_PEER_DECISIONS} a session branch is checked for`
      : theirs;
  } catch (error) {
    if (!isOverrun(error)) rethrowIfKilled(error);
    return 'git could not read it against the target';
  }
}

/**
 * The other sessions whose branch can still land: one holding its scope
 * (decision 41's live states) or a merged one whose PR is open, not landed.
 */
function competingBranches(db: Database, sessionId: string): string[] {
  const holding = holdingStates();
  return listSessions(db)
    .filter((session) => session.id !== sessionId)
    .filter((session) => {
      if (holding.includes(session.state)) return true;
      const merge = session.state === 'merged' ? newestMerge(db, session.id) : undefined;
      return typeof merge === 'object' && merge.prUrl !== undefined;
    })
    .map((session) => `refs/heads/${session.branch}`);
}

/**
 * The decision files in `sha`'s `docs/adr/`. `--full-tree`, so the path is the
 * root's whatever cwd prefix a session-set `core.worktree` gives git; ls-tree
 * takes no `icase` magic, so this reads the `docs/adr/` the target and the
 * branch already hold, which the diffs above check by case.
 */
function decisionPaths(repoPath: string, sha: string): string[] {
  return runGit(repoPath, ['ls-tree', '--full-tree', '-z', '--name-only', sha, ADR_DIR])
    .split('\0')
    .filter((path) => decisionNumber(path) !== undefined);
}

function numbersOf(paths: string[]): Set<number> {
  return new Set(paths.map((path) => decisionNumber(path) as number));
}

const pad = (number: number): string => String(number).padStart(4, '0');

/**
 * The gate's ADR-number stage (decision 146), run before any other stage
 * measures the branch. It fails on each decision the branch at `sha` adds whose
 * number the target at `targetSha` holds, that the branch adds twice, or that
 * another session branch adds while its session is live or holds an open PR,
 * each line naming the lowest free number above the target's highest. A file
 * git pairs as a rename of a target decision under the same number is that
 * decision under a new slug, not a new one: it is checked against the other
 * branches only, since two that rename one decision each still leave the
 * target two files under its number. A file under the number of a target
 * decision the branch deletes, unpaired, is refused as a rename that changed
 * too much to be paired rather than told to renumber. Parallel sessions pick the next
 * number from the target, and two files that share a number under different
 * slugs merge without a conflict. Another branch git cannot read against the
 * target (an orphan, a symbolic ref, a read past its time or buffer), or one
 * adding more than `MAX_PEER_DECISIONS`, is skipped and named rather than
 * failing or blocking everyone's gate. A new file under `docs/adr/` whose name
 * starts with a digit but is not `docs/adr/NNNN-*.md` (`00146-x.md`,
 * `0146_x.md`, `docs/adr/sub/0146-x.md`) is refused naming the expected form,
 * since the check would not read its number. Undefined, so no stage at all,
 * when the branch adds no decision or every check passed with nothing to say. Every read
 * is of a pinned sha or a resolved ref through `runGit`, never of a worktree;
 * only the branches of sessions the store counts are resolved, one at a time,
 * so no number of stray `pup/` refs weighs on the gate.
 */
export function adrNumberStage(
  db: Database,
  repoPath: string,
  sessionId: string,
  targetSha: string,
  sha: string,
): GateStageResult | undefined {
  const started = Date.now();
  const addedPaths = addedAdrPaths(repoPath, targetSha, sha);
  const added = decisionsOf(addedPaths);
  // Files that look numbered but that the check would not read as a decision.
  const misnamed = addedPaths.filter((path) => !added.has(path) && /^[0-9]/.test(baseName(path)));
  if (added.size === 0 && misnamed.length === 0) return undefined;
  const targetPaths = decisionPaths(repoPath, targetSha);
  const onTarget = numbersOf(targetPaths);
  const renamed = decisionRenames(repoPath, targetSha, sha);
  const tipPaths = new Set(decisionPaths(repoPath, sha));
  // Every rename source, a renumbered one too: git paired it with a new file.
  const paired = new Set(renamed.values());
  // Target decisions the branch deletes that git did not pair with a new file.
  const deleted = new Map(
    targetPaths
      .filter((path) => !tipPaths.has(path) && !paired.has(path))
      .map((path) => [decisionNumber(path) as number, path]),
  );
  const takenBy = new Map<number, string>();
  const unchecked: string[] = [];
  for (const ref of competingBranches(db, sessionId)) {
    const branch = sanitizeReason(ref.slice('refs/heads/'.length));
    const theirs = peerDecisions(repoPath, targetSha, ref);
    if (typeof theirs === 'string') unchecked.push(`not checked against ${branch}: ${theirs}`);
    if (typeof theirs !== 'object') continue;
    for (const number of theirs.values()) if (!takenBy.has(number)) takenBy.set(number, branch);
  }
  const taken = new Set([...onTarget, ...takenBy.keys(), ...added.values()]);
  let free = Math.max(0, ...onTarget);
  // Bounded to four digits: a five-digit name is no decision file to the
  // check, so suggesting one would be advice that escapes it.
  const renumber = (): string => {
    do free += 1;
    while (free <= MAX_DECISION && taken.has(free));
    if (free > MAX_DECISION) return "no four-digit number above the target's highest is free";
    taken.add(free);
    return `renumber it ${pad(free)}, the lowest free number`;
  };
  const firstAdd = new Map<number, string>();
  const refusals: string[] = [];
  for (const [path, number] of added) {
    const first = firstAdd.get(number);
    if (first === undefined) firstAdd.set(number, path);
    const other = takenBy.get(number);
    const renamedFrom = renamed.get(path);
    const from =
      renamedFrom !== undefined && decisionNumber(renamedFrom) === number ? renamedFrom : undefined;
    const replaced = deleted.get(number);
    const decision = `  ${quotePath(path)}: decision ${pad(number)}`;
    if (from !== undefined) {
      if (other !== undefined) {
        refusals.push(
          `${decision} renames ${quotePath(from)}, which ${other}, a session branch that is ` +
            'live or has an open PR, also renames or adds under that number; settle one name ' +
            "with it or keep the target's",
        );
      }
      continue;
    }
    if (onTarget.has(number) && replaced !== undefined) {
      refusals.push(
        `${decision} is already on the target as ${quotePath(replaced)}, which the branch ` +
          'deletes: this looks like a slug rename that changed too much of the file to be ' +
          "paired; keep the ADR's text closer to the original",
      );
      continue;
    }
    const where = onTarget.has(number)
      ? 'is already on the target'
      : first !== undefined
        ? `is also added by ${quotePath(first)} on this branch`
        : other !== undefined
          ? `is also added by ${other}, a session branch that is live or has an open PR`
          : undefined;
    if (where === undefined) continue;
    refusals.push(`${decision} ${where}; ${renumber()}`);
  }
  const lines = [
    ...(refusals.length > 0 ? ['ADR numbers already taken:', ...refusals] : []),
    ...(misnamed.length > 0
      ? [
          'ADR files not named docs/adr/NNNN-<slug>.md, four digits and a dash directly under docs/adr/:',
          ...misnamed.map((path) => `  ${quotePath(path)}`),
        ]
      : []),
    ...unchecked,
  ];
  if (lines.length === 0) return undefined;
  return timedSince(started, {
    stage: ADR_NUMBER_STAGE,
    status: refusals.length > 0 || misnamed.length > 0 ? 'fail' : 'pass',
    detail: lines.join('\n'),
  });
}
