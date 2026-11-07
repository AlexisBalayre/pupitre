import type { Database } from 'better-sqlite3';
import { sanitizeReason } from '../adapters/capability.utils.js';
import { quotePath } from './debt.service.js';
import { runGit } from './git-diff.client.js';
import { newestMerge } from './merge-gate.service.js';
import { listSessions } from './session.repository.js';
import { holdingStates } from './session-state.utils.js';

const ADR_DIR = 'docs/adr/';
/** A decision file, `docs/adr/NNNN-*.md`, its number captured. */
const ADR_DECISION = /^docs\/adr\/([0-9]{4})-[^/]*\.md$/;

const SESSION_BRANCHES = 'refs/heads/pup/';

/** A decision path's number, undefined for any other path. */
function decisionNumber(path: string): number | undefined {
  const number = ADR_DECISION.exec(path)?.[1];
  return number === undefined ? undefined : Number(number);
}

/**
 * The decision files `tip` adds over its merge base with `base`, with their
 * numbers. Rename detection is off, so a decision renumbered with `git mv`
 * counts as the add of its new name; colour and external diffs are off, so a
 * session-written config cannot change what the listing prints.
 */
function addedDecisions(repoPath: string, base: string, tip: string): Map<string, number> {
  const added = new Map<string, number>();
  const paths = runGit(repoPath, [
    'diff',
    '--no-ext-diff',
    '--no-color',
    '--no-renames',
    '--diff-filter=A',
    '-z',
    '--name-only',
    `${base}...${tip}`,
  ]).split('\0');
  for (const path of paths) {
    const number = decisionNumber(path);
    if (number !== undefined) added.set(path, number);
  }
  return added;
}

/**
 * Every session branch's tip, by ref name, as `for-each-ref` lists it. A ref
 * name holds no control character (`check-ref-format`), so a line is one ref.
 */
function sessionBranchTips(repoPath: string): Map<string, string> {
  const tips = new Map<string, string>();
  const listing = runGit(repoPath, [
    'for-each-ref',
    '--format=%(objectname) %(refname)',
    SESSION_BRANCHES,
  ]);
  for (const line of listing.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) tips.set(line.slice(space + 1), line.slice(0, space));
  }
  return tips;
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
 * Why the branch at `sha` may not take the decision numbers it adds (decision
 * 146): one line per added decision whose number is already on the target at
 * `targetSha`, or is added by another session branch that is live or holds an
 * open PR, each naming the lowest free number above the target's highest.
 * Parallel sessions pick the next number from the target, and two files that
 * share a number under different slugs merge without a conflict. Every read is
 * of a pinned sha through `runGit`, never of a worktree; the store only says
 * which listed refs count, so no store text reaches git as a revision.
 */
export function adrNumberRefusals(
  db: Database,
  repoPath: string,
  sessionId: string,
  targetSha: string,
  sha: string,
): string[] {
  const added = addedDecisions(repoPath, targetSha, sha);
  if (added.size === 0) return [];
  const onTarget = new Set(
    runGit(repoPath, ['ls-tree', '-z', '--name-only', targetSha, ADR_DIR])
      .split('\0')
      .map(decisionNumber)
      .filter((number) => number !== undefined),
  );
  const takenBy = new Map<number, string>();
  const tips = sessionBranchTips(repoPath);
  for (const ref of competingBranches(db, sessionId)) {
    const tip = tips.get(ref);
    if (tip === undefined) continue;
    for (const number of addedDecisions(repoPath, targetSha, tip).values()) {
      if (!takenBy.has(number)) takenBy.set(number, ref.slice('refs/heads/'.length));
    }
  }
  const taken = new Set([...onTarget, ...takenBy.keys(), ...added.values()]);
  let free = Math.max(0, ...onTarget);
  const nextFree = (): string => {
    do free += 1;
    while (taken.has(free));
    taken.add(free);
    return String(free).padStart(4, '0');
  };
  const refusals: string[] = [];
  for (const [path, number] of added) {
    const other = takenBy.get(number);
    const where = onTarget.has(number)
      ? 'is already on the target'
      : other !== undefined
        ? `is also added by ${sanitizeReason(other)}, a session branch that is live or has an open PR`
        : undefined;
    if (where === undefined) continue;
    refusals.push(
      `  ${quotePath(path)}: decision ${String(number).padStart(4, '0')} ${where}; ` +
        `renumber it ${nextFree()}, the lowest free number`,
    );
  }
  return refusals.length === 0 ? [] : ['ADR numbers already taken:', ...refusals];
}
