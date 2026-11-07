import type { Database } from 'better-sqlite3';
import { sanitizeReason } from '../adapters/capability.utils.js';
import { quotePath } from './debt.service.js';
import { runGit } from './git-diff.client.js';
import { newestMerge, timedSince } from './merge-gate.service.js';
import { listSessions } from './session.repository.js';
import { holdingStates } from './session-state.utils.js';
import type { GateStageResult } from './types/merge-gate.types.js';

export const ADR_NUMBER_STAGE = 'adr-number';

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

/** The decision files in `sha`'s `docs/adr/`. */
function decisionPaths(repoPath: string, sha: string): string[] {
  return runGit(repoPath, ['ls-tree', '-z', '--name-only', sha, ADR_DIR])
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
 * number the target at `targetSha` still holds at a path the branch keeps, that
 * the branch adds twice, or that another session branch adds while its session
 * is live or holds an open PR, each line naming the lowest free number above
 * the target's highest. A number whose target file the branch removes is a
 * rename of that decision, not a new one. Parallel sessions pick the next
 * number from the target, and two files that share a number under different
 * slugs merge without a conflict. A branch git cannot diff against the target
 * (an orphan, say) is skipped and named rather than failing everyone's gate.
 * Undefined, so no stage at all, when the branch adds no decision or every
 * check passed with nothing to say. Every read is of a pinned sha through
 * `runGit`, never of a worktree; the store only says which listed refs count,
 * so no store text reaches git as a revision.
 */
export function adrNumberStage(
  db: Database,
  repoPath: string,
  sessionId: string,
  targetSha: string,
  sha: string,
): GateStageResult | undefined {
  const started = Date.now();
  const added = addedDecisions(repoPath, targetSha, sha);
  if (added.size === 0) return undefined;
  const targetPaths = decisionPaths(repoPath, targetSha);
  const tipPaths = new Set(decisionPaths(repoPath, sha));
  const kept = numbersOf(targetPaths.filter((path) => tipPaths.has(path)));
  const renamed = numbersOf(targetPaths.filter((path) => !tipPaths.has(path)));
  const takenBy = new Map<number, string>();
  const unread: string[] = [];
  const tips = sessionBranchTips(repoPath);
  for (const ref of competingBranches(db, sessionId)) {
    const tip = tips.get(ref);
    if (tip === undefined) continue;
    const branch = sanitizeReason(ref.slice('refs/heads/'.length));
    let theirs: Map<string, number>;
    try {
      theirs = addedDecisions(repoPath, targetSha, tip);
    } catch {
      unread.push(branch);
      continue;
    }
    for (const number of theirs.values()) if (!takenBy.has(number)) takenBy.set(number, branch);
  }
  const taken = new Set([...numbersOf(targetPaths), ...takenBy.keys(), ...added.values()]);
  let free = Math.max(0, ...numbersOf(targetPaths));
  const nextFree = (): string => {
    do free += 1;
    while (taken.has(free));
    taken.add(free);
    return pad(free);
  };
  const firstAdd = new Map<number, string>();
  const refusals: string[] = [];
  for (const [path, number] of added) {
    const first = firstAdd.get(number);
    if (first === undefined) firstAdd.set(number, path);
    const other = takenBy.get(number);
    const where = kept.has(number)
      ? 'is already on the target'
      : first !== undefined
        ? `is also added by ${quotePath(first)} on this branch`
        : renamed.has(number)
          ? undefined
          : other !== undefined
            ? `is also added by ${other}, a session branch that is live or has an open PR`
            : undefined;
    if (where === undefined) continue;
    refusals.push(
      `  ${quotePath(path)}: decision ${pad(number)} ${where}; ` +
        `renumber it ${nextFree()}, the lowest free number`,
    );
  }
  const lines = [
    ...(refusals.length > 0 ? ['ADR numbers already taken:', ...refusals] : []),
    ...unread.map(
      (branch) => `not checked against ${branch}: git could not diff it against the target`,
    ),
  ];
  if (lines.length === 0) return undefined;
  return timedSince(started, {
    stage: ADR_NUMBER_STAGE,
    status: refusals.length > 0 ? 'fail' : 'pass',
    detail: lines.join('\n'),
  });
}
