import type { Database } from 'better-sqlite3';
import { sanitizeReason } from '../adapters/capability.utils.js';
import { PR_URL } from './constants/dashboard.constants.js';
import { quotePath } from './debt.service.js';
import { rethrowIfKilled, runGit } from './git-diff.client.js';
import { COMMIT_SHA } from './merge-gate.constants.js';
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
 * A decision file, exactly `docs/adr/NNNN-<slug>.md`, its number captured: the
 * lowercase directory the target's listings read, ASCII digits, a lowercase
 * suffix. Any other spelling the case-blind diffs find is refused, so nothing
 * lands that a later gate would not read as a decision.
 */
const ADR_DECISION = /^docs\/adr\/([0-9]{4})-[^/]+\.md$/;
/** The one file under `docs/adr/` that is not a decision. */
const ADR_README = 'docs/adr/README.md';

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
/** The codes Node gives a child it killed for its timeout or its output buffer. */
const OVERRUN_CODES = new Set<unknown>(['ETIMEDOUT', 'ENOBUFS']);

/**
 * The decision path a misspelt one was most likely meant as: its directory and
 * suffix lowercased, when that is a decision path. Undefined otherwise; never
 * the path itself, which is not a decision path. Only ASCII is folded: the
 * directory is replaced whole, and `/i` without the `u` flag lets no non-ASCII
 * letter match an ASCII one, so a lookalike such as the Kelvin sign is never
 * read as `k`.
 */
function meantAs(path: string): string | undefined {
  const lowered = `${ADR_DIR}${path.slice(ADR_DIR.length)}`.replace(/\.md$/i, '.md');
  return ADR_DECISION.test(lowered) ? lowered : undefined;
}

/** A decision path's number, undefined for any other path or none. */
function decisionNumber(path: string | undefined): number | undefined {
  const match = ADR_DECISION.exec(String(path));
  return match ? Number(match[1]) : undefined;
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
  return OVERRUN_CODES.has((Object(error) as { code?: unknown }).code);
}

/**
 * The decisions another session's branch, read at `rev`, adds: `'absent'` when
 * `rev` names no commit, `'undiffable'` when git could not resolve or diff it
 * against the target (an orphan, a symbolic ref, a history a `shallow` file
 * cuts, a missing object, an overrun). An interrupt that killed git is rethrown.
 */
function peerDecisions(
  repoPath: string,
  targetSha: string,
  rev: string,
): Map<string, number> | 'absent' | 'undiffable' {
  try {
    const tip = resolveCommitIfPresent(repoPath, rev);
    if (tip === undefined) return 'absent';
    return decisionsOf(addedAdrPaths(repoPath, targetSha, tip, PEER_READ_TIMEOUT_MS));
  } catch (error) {
    if (!isOverrun(error)) rethrowIfKilled(error);
    return 'undiffable';
  }
}

/** Another session's branch that can still land, as the check reads it. */
interface Competitor {
  /** The session's branch, which a refusal names. */
  branch: string;
  /**
   * What holds its decisions: the live branch's ref, or the commit an open PR's
   * gate pinned, undefined when its merge recorded none.
   */
  rev: string | undefined;
  /**
   * The PR's url, set on a pinned peer: one whose commit git cannot find
   * refuses the gate, naming the PR, rather than read as absent.
   */
  prUrl?: string;
}

/**
 * The other sessions whose branch can still land: one holding its scope
 * (decision 41's live states), read at its branch, or a merged one whose PR has
 * not landed, read at the sha its newest merge pinned. The store cannot tell
 * such a PR open from closed unmerged, so a closed one counts too: nothing
 * records a close (decision 146's ceilings). That gate normally
 * deleted the local branch, in both modes; it keeps it with a worktree it could
 * not remove or when the branch moved past the pin, and then the branch may
 * hold commits the PR does not. Either way the sha is pup's record of the PR's
 * head, where the remote-tracking ref the push wrote is one any session can
 * move (decision 84).
 */
function competingBranches(db: Database, sessionId: string): Competitor[] {
  const holding = holdingStates();
  const competitors: Competitor[] = [];
  for (const session of listSessions(db)) {
    if (session.id === sessionId) continue;
    if (holding.includes(session.state)) {
      competitors.push({ branch: session.branch, rev: `refs/heads/${session.branch}` });
      continue;
    }
    const merge = session.state === 'merged' ? newestMerge(db, session.id) : undefined;
    if (typeof merge !== 'object' || merge.prUrl === undefined) continue;
    const rev = COMMIT_SHA.test(String(merge.sha)) ? merge.sha : undefined;
    competitors.push({ branch: session.branch, rev, prUrl: merge.prUrl });
  }
  return competitors;
}

/**
 * What the stage makes of one competing branch, `branch` its scrubbed name: the
 * decisions it adds, why it was skipped, or a line refusing an unreadable PR. A
 * live branch git cannot read, or one adding more than `MAX_PEER_DECISIONS`, is
 * skipped rather than block every peer's gate. A PR's gated commit is fixed and
 * was read at its own gate, so one the merge recorded no sha for, the repo
 * lacks or git cannot diff refuses: a session can cut that commit's history
 * with the shared `shallow` file (decision 89), and a skip would pass its clash.
 */
function readPeer(
  repoPath: string,
  targetSha: string,
  peer: Competitor,
  branch: string,
): Map<string, number> | { skipped: string } | { unreadPr: string } {
  const theirs = peer.rev === undefined ? 'absent' : peerDecisions(repoPath, targetSha, peer.rev);
  if (theirs instanceof Map) {
    if (theirs.size <= MAX_PEER_DECISIONS) return theirs;
    return {
      skipped: `it adds ${theirs.size} decisions, more than the ${MAX_PEER_DECISIONS} a session branch is checked for`,
    };
  }
  if (peer.prUrl === undefined) {
    // A live session that has not cut its branch yet adds nothing.
    return theirs === 'absent'
      ? new Map()
      : { skipped: 'git could not read it against the target' };
  }
  // Store text printed as the thing to open: a url that is not a pull
  // request's is withheld, not scrubbed (decisions 29, 83).
  const url = sanitizeReason(peer.prUrl);
  const pr = PR_URL.test(url) ? url : 'a pull request url pup withholds';
  const why =
    peer.rev === undefined
      ? 'its merge recorded no gated commit sha'
      : theirs === 'absent'
        ? `its gated commit ${peer.rev} is not in this repo; fetch the PR's head here`
        : `its gated commit ${peer.rev} is in this repo, but git could not diff it against the ` +
          'target (a history a shallow file cuts, a missing object, a read past its time); ' +
          'repair the repo, then gate again';
  return { unreadPr: `  ${branch} (${pr}): ${why}` };
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
 * another session branch adds while its session is live or holds a PR that has
 * not landed (that one read at the sha its gate pinned, since the gate normally
 * deleted the branch),
 * each line naming the lowest free number above the target's highest. A file
 * git pairs as a rename of a target decision under the same number is that
 * decision under a new slug, not a new one: it is checked against the other
 * branches only, since two that rename one decision each still leave the
 * target two files under its number. A file under the number of a target
 * decision the branch deletes, unpaired, is refused as a rename that changed
 * too much to be paired rather than told to renumber. Parallel sessions pick the next
 * number from the target, and two files that share a number under different
 * slugs merge without a conflict. Another live branch git cannot read against
 * the target (an orphan, a symbolic ref, a read past its time or buffer), or
 * one adding more than `MAX_PEER_DECISIONS`, is skipped and named rather than
 * failing or blocking everyone's gate. A PR not landed whose merge recorded no
 * commit sha, whose commit the repo lacks, or whose commit git cannot diff
 * against the target, fails the stage instead, naming the branch and the PR:
 * its commit is fixed and nothing else holds what it adds, so passing would let
 * a clash through unseen. Any other new file under `docs/adr/`,
 * in any case, that is neither exactly `docs/adr/NNNN-<slug>.md` nor
 * `docs/adr/README.md` is refused naming the expected form: a later gate would
 * not read its number, though a case-insensitive host shares its folder.
 * Undefined, so no stage at all,
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
  // Everything else the case-blind listing found, but the index.
  const misnamed = addedPaths.filter((path) => !added.has(path) && path !== ADR_README);
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
  const unreadPrs: string[] = [];
  for (const peer of competingBranches(db, sessionId)) {
    const branch = sanitizeReason(peer.branch);
    const read = readPeer(repoPath, targetSha, peer, branch);
    if (read instanceof Map) {
      for (const number of read.values()) takenBy.set(number, branch);
    } else if ('unreadPr' in read) {
      unreadPrs.push(read.unreadPr);
    } else {
      unchecked.push(`not checked against ${branch}: ${read.skipped}`);
    }
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
    const from = renamed.get(path);
    const replaced = deleted.get(number);
    const decision = `  ${quotePath(path)}: decision ${pad(number)}`;
    // A slug rename: the same number under a new name.
    if (decisionNumber(from) === number) {
      if (other !== undefined) {
        refusals.push(
          `${decision} renames ${quotePath(from as string)}, which ${other}, a session branch that is ` +
            'live or whose PR has not landed, also renames or adds under that number; settle one ' +
            "name with it or keep the target's",
        );
      }
      continue;
    }
    // Its keys are the target's numbers.
    if (replaced !== undefined) {
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
          ? `is also added by ${other}, a session branch that is live or whose PR has not landed`
          : undefined;
    if (where === undefined) continue;
    refusals.push(`${decision} ${where}; ${renumber()}`);
  }
  const section = (heading: string, items: string[]): string[] =>
    items.length > 0 ? [heading, ...items] : [];
  const lines = [
    ...section('ADR numbers already taken:', refusals),
    ...section(
      'PRs not landed whose gated commit cannot be read, so no number this branch adds can ' +
        'be cleared against them:',
      unreadPrs,
    ),
    ...section(
      'ADR files neither docs/adr/NNNN-<slug>.md nor docs/adr/README.md, in lowercase ' +
        'docs/adr/ with four ASCII digits, a dash and .md:',
      misnamed.map((path) => {
        const meant = meantAs(path);
        return `  ${quotePath(path)}${meant === undefined ? '' : `: write it as ${quotePath(meant)}`}`;
      }),
    ),
    ...unchecked,
  ];
  if (lines.length === 0) return undefined;
  return timedSince(started, {
    stage: ADR_NUMBER_STAGE,
    status: refusals.length + unreadPrs.length + misnamed.length > 0 ? 'fail' : 'pass',
    detail: lines.join('\n'),
  });
}
