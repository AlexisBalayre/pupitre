import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { Adapter } from '../adapters/types/adapter.types.js';
import { quotePath } from './debt.service.js';
import { currentBranch, runGit } from './git-diff.client.js';
import { globToRegExp } from './glob.utils.js';
import { DEBT_DETAIL_SAMPLES } from './merge-gate.constants.js';
import {
  assertMergeLockHeld,
  debtKind,
  isAncestor,
  measureBranch,
  resolveCommit,
} from './merge-gate.service.js';
import type { StageProgress } from './progress.utils.js';
import { CRITICAL_AREAS } from './routing.utils.js';
import { endSandboxRun, removeGateDir, sandboxLabel } from './sandbox.utils.js';
import { decodeEvent, listEvents, type SessionRow } from './session.repository.js';
import type { GateReport, GateStageResult } from './types/merge-gate.types.js';

/** What a remeasure reads of `pup land`'s request (decision 185). */
interface RemeasureRequest {
  repoPath: string;
  adapters: Adapter[];
  gateEnv?: string[];
  wait?: boolean;
  /** Who approved commits past the pin that touch a critical area, scrubbed by the caller. */
  approvedBy?: string;
}

/** `CRITICAL_AREAS` as path matchers, for a remeasure's approval (decision 185). */
const CRITICAL_PATHS = CRITICAL_AREAS.map(globToRegExp);

/**
 * `--remeasure` (decision 185): the gate's stages, `measureBranch`'s, run on
 * the commit GitHub's merge made, against the commit it went onto on the
 * pinned target, from a gate checkout of its own and under the land's lock, as
 * `runMergeGate` runs them, and only with the local target at that commit,
 * which the main checkout then holds for the complexity stage's "before" as
 * it does for the gate's. The commits past the pin are the ones no gate
 * measured; when they change a file in a critical area, the remeasure runs
 * only on the approval `approvedBy` names: a pass says the code builds and its
 * tests pass, not that a change to the gate itself is sound. A hard stage that
 * fails refuses, and so does a flag of a kind the session's own gate did not
 * already file as accepted debt: no one accepted it. The stages take minutes,
 * so after a pass what the land acts on is read again: the lock, the main
 * checkout's branch, the local target at `localSha` and origin's still holding
 * `originTip`, which `originTipNow` fetches anew. Origin moving on changes
 * nothing landed; origin rewound, or anything moved here, refuses. A pass's
 * report is returned, for the `landed` event.
 */
export async function remeasureMerge(
  db: Database,
  req: RemeasureRequest,
  session: SessionRow,
  merge: {
    sha: string;
    head: string;
    landedOn: string;
    mergeCommit: string;
    target: string;
    prUrl: string;
    /** The session id as printed. */
    id: string;
    localSha: string;
    originTip: string;
    originTipNow: () => string;
  },
  progress: StageProgress,
): Promise<GateReport> {
  const { sha, head, landedOn, mergeCommit, target, prUrl, id, localSha, originTip } = merge;
  // `measureBranch` reads the complexity stage's "before" from the main
  // checkout, which holds the local target, not `landedOn`. Any commit between
  // them that changed a file the merge changes would hide or inflate its rise,
  // and a target that already holds the merge reads its own change as before.
  if (localSha !== landedOn) {
    throw new Error(
      `Local ${target} is at ${localSha}, not ${landedOn}, the commit the merge of ${prUrl} ` +
        'went onto. The complexity stage reads what the merge changed as it was before from the ' +
        `main checkout, so a remeasure runs only with local ${target} at that commit. Nothing ` +
        'was landed.',
    );
  }
  if (req.approvedBy === undefined) {
    // The trees, not `gitDiffPaths`' merge-base range: the head need not
    // descend from the pin, and from an older merge-base a head that kept a
    // change the pin reverted would show none. Over-reporting fails closed.
    const critical = runGit(req.repoPath, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--text',
      '--no-relative',
      '--no-renames',
      '-z',
      '--name-only',
      sha,
      head,
    ])
      .split('\0')
      .filter(Boolean)
      .filter((path) => CRITICAL_PATHS.some((area) => area.test(path)));
    if (critical.length > 0) {
      const named = critical.slice(0, DEBT_DETAIL_SAMPLES).map(quotePath).join(', ');
      const more = critical.length > DEBT_DETAIL_SAMPLES ? ', …' : '';
      throw new Error(
        `The commits past the pin, ${sha}..${head}, change ${critical.length} file(s) in a ` +
          `critical area (${named}${more}); a remeasure lands them only on the operator's ` +
          `approval: re-run with \`--remeasure --approved-by <who>\`. Nothing was landed.`,
      );
    }
  }
  // The report of the gate that pinned `sha`, or of the re-gate that re-pinned
  // it: each files it on its way to merged just before the `merge` event naming
  // `sha`, with nothing of either type between. So the first of either before
  // the newest such event must be that report; an older `merge` there means
  // this one has none, and its report is never borrowed. Events are in id
  // order. A stage the report ran must run again.
  const newestFirst = listEvents(db, session.id).map(decodeEvent).reverse();
  const pinnedAt = newestFirst.findIndex((event) => event.type === 'merge' && event.sha === sha);
  const gated =
    pinnedAt === -1
      ? undefined
      : newestFirst
          .slice(pinnedAt + 1)
          .find((event) => event.type === 'gate_result' || event.type === 'merge');
  const pinnedStages =
    gated?.type === 'gate_result' && gated.to === 'merged' && gated.report?.passed
      ? gated.report.stages
      : undefined;
  if (pinnedStages === undefined) {
    throw new Error(
      `No passing gate report into merged is recorded right before the merge of ${sha}, the ` +
        'commit the gate pinned, so a remeasure has no stages to hold the merge to. Nothing was ' +
        'landed.',
    );
  }
  // Every gate run lists these three, run or skipped: a report without one is
  // no full run's, and would hold the merge to nothing there.
  const unlisted = ['build', 'test', 'lint'].filter(
    (name) => !pinnedStages.some(({ stage }) => stage === name),
  );
  if (unlisted.length > 0) {
    throw new Error(
      `The gate report recorded for ${sha}, the commit the gate pinned, lists no ` +
        `${unlisted.join(', ')} stage, so a remeasure cannot hold the merge to it. Nothing was ` +
        'landed.',
    );
  }
  progress.stage('remeasure');
  const sandbox = sandboxLabel();
  const stages: GateStageResult[] = [];
  // Where and how `runMergeGate` cuts its checkout, for its reasons.
  const checkoutRoot = mkdtempSync(join(realpathSync(tmpdir()), 'pup-gate-checkout-'));
  let measured: Awaited<ReturnType<typeof measureBranch>>;
  try {
    measured = await measureBranch(
      db,
      {
        repoPath: req.repoPath,
        sessionId: session.id,
        adapters: req.adapters,
        gateEnv: req.gateEnv,
        wait: req.wait,
      },
      session,
      stages,
      join(checkoutRoot, basename(checkoutRoot)),
      { targetSha: landedOn, sha: mergeCommit },
      progress,
    );
  } finally {
    endSandboxRun();
    // Swallowed, as the gate's is: the registration goes with the next prune.
    try {
      removeGateDir(checkoutRoot);
      runGit(req.repoPath, ['worktree', 'prune']);
    } catch {
      // see above
    }
  }
  // The open entries the session's own gate filed as accepted debt, by kind;
  // one whose files are no list of paths accepts nothing.
  const accepted = new Map<string, { description: string; files: string[] }[]>();
  for (const entry of measured?.openEntries ?? []) {
    const kind = remeasureKind(entry.description, session.id);
    const files = pathList(entry.files);
    if (kind === undefined || files === undefined) continue;
    accepted.set(kind, [...(accepted.get(kind) ?? []), { description: entry.description, files }]);
  }
  const flaggedDebt = measured?.flaggedDebt ?? [];
  const flaggedBy = new Set(
    flaggedDebt.flatMap((flag) => debtFigures(flag.description, session.id)?.stage ?? []),
  );
  // Past a stage that failed the rest never ran, so only a full run is held
  // to the pin's stages: all but the two the gate runs on the session's
  // worktree, which a remeasure has none of.
  const unrun =
    measured === undefined
      ? []
      : pinnedStages.flatMap(({ stage, status }) => {
          if (!RAN_STATUSES.has(status) || WORKTREE_STAGES.has(stage)) return [];
          const now = stages.find((result) => result.stage === stage)?.status ?? 'absent';
          return ['absent', 'skipped'].includes(now)
            ? [`  ${stage}: ran at the pin, ${now} now`]
            : [];
        });
  const failed = [
    ...stages
      .filter((stage) => !LANDABLE_STATUSES.has(stage.status))
      .map((stage) => `  ${stage.stage}: ${stage.detail ?? stage.status}`),
    ...unrun,
    // A flagged stage the ledger can judge only through the debt it filed.
    ...stages
      .filter((stage) => stage.status === 'flagged' && !flaggedBy.has(stage.stage))
      .map((stage) => `  ${stage.stage}: flagged, with no debt filed for it`),
    ...flaggedDebt.flatMap((flag) => {
      const held = accepted.get(remeasureKind(flag.description, session.id) as string) ?? [];
      if (held.length === 0) return [`  flagged, never accepted: ${flag.description}`];
      const now = debtFigures(flag.description, session.id);
      if (now === undefined || DEBT_WORDINGS[now.wording]?.unrecorded) {
        return [`  flagged, its figures unreadable or unrecorded: ${flag.description}`];
      }
      const sameFiles = DEBT_WORDINGS[now.wording]?.sameFiles === true;
      return held.some(
        (entry) =>
          noWorse(flag.description, entry.description, session.id) &&
          (!sameFiles || flag.files.every((file) => entry.files.includes(file))),
      )
        ? []
        : [
            `  flagged past the accepted ${held.map((entry) => entry.description).join('; ')}` +
              `${sameFiles ? ' or on files it did not name' : ''}: ${flag.description}`,
          ];
    }),
  ];
  if (measured === undefined || failed.length > 0) {
    throw new Error(
      `The remeasure of ${mergeCommit} against ${target} at ${landedOn} did not pass:\n` +
        `${failed.join('\n') || '  the stages stopped with no result'}\n` +
        'The session stays merged. Nothing was landed.',
    );
  }
  assertMergeLockHeld(req.repoPath, `the land of ${prUrl} after its remeasure`);
  // Each read and what it says when it no longer holds.
  const moved = (
    [
      [currentBranch(req.repoPath) === target, `the main checkout left ${target}`],
      [
        resolveCommit(req.repoPath, `refs/heads/${target}`) === localSha,
        `local ${target} moved from ${localSha}`,
      ],
      [
        isAncestor(req.repoPath, originTip, merge.originTipNow()),
        `origin's ${target} no longer holds ${originTip}`,
      ],
    ] as const
  )
    .filter(([holds]) => !holds)
    .map(([, change]) => change);
  if (moved.length > 0) {
    throw new Error(
      `While the remeasure ran, ${moved.join('; ')}. The session stays merged. Nothing ` +
        `was landed; re-run \`pup land ${id} --remeasure\`.`,
    );
  }
  return { sessionId: session.id, passed: true, sandbox, stages };
}

/**
 * Each wording a gate flag is filed in, matched whole on the description with
 * its ` session <id>` cut, and which way each figure it holds is worse: 1 when
 * higher, -1 when lower (decision 185). Whole, so a path or a name the session
 * chose cannot supply a figure; the figures are the first captures, as many as
 * `worse` has. `stage` names the stage that files it. A wording with no figure
 * matches on its `debtKind` alone, which holds its every other word. With
 * `sameFiles`, a flag's files are what was accepted, not where it was found,
 * so it passes only against an entry that named each of them. With
 * `unrecorded`, the wording leaves out a figure that can worsen, so no entry
 * holds it and it refuses.
 */
const DEBT_WORDINGS: readonly {
  pattern: RegExp;
  worse: readonly number[];
  stage: (match: RegExpExecArray) => string;
  sameFiles?: true;
  unrecorded?: true;
}[] = [
  { pattern: /^Oversize diff \((\d+) lines\) merged from$/, worse: [1], stage: () => 'diff-size' },
  {
    pattern: /^Text files git reports as binary \((\d+)\) merged from$/,
    worse: [1],
    stage: () => 'diff-size',
    sameFiles: true,
  },
  { pattern: /^New unused exports \((\d+)\) merged from$/, worse: [1], stage: () => 'dead-code' },
  {
    pattern: /^Complexity rise \(\+(\d+) decision points\) merged from$/,
    worse: [1],
    stage: () => 'complexity',
  },
  {
    pattern: /^Duplicated lines rose from (\d+) to (\d+) in$/,
    worse: [-1, 1],
    stage: () => 'duplication',
  },
  {
    pattern: /^Coverage unmeasured over (\d+) changed source file\(s\) in$/,
    worse: [1],
    stage: () => 'coverage',
    sameFiles: true,
  },
  {
    pattern:
      /^Coverage gap \(patch coverage (\d+(?:\.\d)?)% below baseline (\d+(?:\.\d)?)%\) merged from$/,
    worse: [-1, 1],
    stage: () => 'coverage',
  },
  {
    pattern: /^Coverage gap \(unreported files\) merged from$/,
    worse: [],
    stage: () => 'coverage',
    sameFiles: true,
  },
  // Its patch coverage is in no word of it, so it could fall to any figure.
  {
    pattern: /^Coverage gap \(unreported files and patch coverage\) merged from$/,
    worse: [],
    stage: () => 'coverage',
    unrecorded: true,
  },
  {
    pattern: /^Nested package (.+) changed with no (test|typecheck) script, merged from$/s,
    worse: [],
    stage: (match) => `${match[2]} (${match[1]})`,
  },
];

/** The statuses of a stage that ran at the pin, which must run again. */
const RAN_STATUSES: ReadonlySet<string> = new Set(['pass', 'flagged']);

/** The gate's stages on the session's worktree, which a remeasure cannot run. */
const WORKTREE_STAGES: ReadonlySet<string> = new Set(['worktree-clean', 'fresh-base']);

/**
 * `debtKind` with a percentage's `#.#` read as `#`: a figure rounded to a
 * whole percent, `80%` beside `80.4%`, is the same kind.
 */
function remeasureKind(description: string, sessionId: string): string | undefined {
  return debtKind(description, sessionId)?.replace(/#\.#%/g, '#%');
}

/** A ledger entry's `files`, when it is the JSON array of paths it should be. */
function pathList(raw: string): string[] | undefined {
  try {
    const files: unknown = JSON.parse(raw);
    return Array.isArray(files) && files.every((file) => typeof file === 'string')
      ? files
      : undefined;
  } catch {
    return undefined;
  }
}

/** Which statuses a remeasure lands on; any other, a future one included, refuses. */
const LANDABLE_STATUSES: ReadonlySet<string> = new Set([
  // As the gate passes them: a stage with no command, the untested skip.
  'pass',
  'skipped',
  // Judged against the ledger, as `flaggedDebt`.
  'flagged',
]);

/**
 * A flag description's wording, as an index into `DEBT_WORDINGS`, its figures
 * and the stage that filed it; undefined when `sessionId` did not file it, it
 * is no wording the gate files, or a figure is no finite number.
 */
function debtFigures(
  description: string,
  sessionId: string,
): { wording: number; figures: number[]; stage: string } | undefined {
  const suffix = ` session ${sessionId}`;
  if (!description.endsWith(suffix)) return undefined;
  const body = description.slice(0, -suffix.length);
  for (const [wording, { pattern, worse, stage }] of DEBT_WORDINGS.entries()) {
    const match = pattern.exec(body);
    if (match === null) continue;
    const figures = match.slice(1, 1 + worse.length).map(Number);
    return figures.every(Number.isFinite) ? { wording, figures, stage: stage(match) } : undefined;
  }
  return undefined;
}

/**
 * Whether the flag `description` is no worse than the accepted `held` on every
 * figure; never when either is unreadable, or they differ in kind or wording.
 */
function noWorse(description: string, held: string, sessionId: string): boolean {
  const now = debtFigures(description, sessionId);
  const then = debtFigures(held, sessionId);
  if (
    now === undefined ||
    then === undefined ||
    now.wording !== then.wording ||
    remeasureKind(description, sessionId) !== remeasureKind(held, sessionId)
  ) {
    return false;
  }
  const { worse } = DEBT_WORDINGS[now.wording] as (typeof DEBT_WORDINGS)[number];
  return now.figures.every(
    (figure, i) => (figure - (then.figures[i] as number)) * (worse[i] as number) <= 0,
  );
}
