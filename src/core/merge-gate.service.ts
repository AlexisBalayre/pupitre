import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { isUnavailable, localContext, sanitizeReason } from '../adapters/capability.utils.js';
import type { CapabilityContext } from '../adapters/types/adapter.types.js';
import {
  killSession as killTmux,
  SteerNotDeliveredError,
} from '../claude/session-runtime.service.js';
import { patchCoverage, repoCoverageRatio } from './coverage.utils.js';
import { draftDecisionRecord } from './decision-record.service.js';
import {
  assertNoArmedGitDrivers,
  GIT_SAFE_CONFIG,
  gitDiffAddedLines,
  gitDiffBinaryRecount,
  gitDiffNumstat,
  gitDiffPaths,
  scrubbedGitEnv,
} from './git-diff.client.js';
import {
  assertGhAvailable,
  createPullRequest,
  findOpenPullRequest,
  originRepoSlug,
  rewritePullRequest,
} from './github.client.js';
import { readOriginUrl } from './init.service.js';
import { hasOpenLedgerEntry, insertLedgerEntry, listLedgerEntries } from './ledger.repository.js';
import {
  COMPLEXITY_FILE_FLAG_DELTA,
  COVERAGE_RATIO_EPSILON,
  DEBT_DETAIL_SAMPLES,
  DIFF_SIZE_FLAG_LINES,
  DUPLICATION_RULE_ID,
  GATE_COMMAND_TIMEOUT_MS,
  GATE_OUTPUT_TAIL_CHARS,
  LOCKFILE_NAMES,
  MAX_REJECTS_BEFORE_BLOCKED,
  MERGE_LOCK_DIRNAME,
  PR_TITLE_MAX_CHARS,
} from './merge-gate.constants.js';
import { MergeLockHeldError, SessionNotReviewableError } from './merge-gate.errors.js';
import { runGateChild, sandboxLabel } from './sandbox.utils.js';
import { auditScope } from './scope-audit.utils.js';
import {
  appendEvent,
  getProject,
  getSession,
  getTask,
  incrementRejectCount,
  type SessionRow,
  saveProjectBaseline,
  transitionSession,
} from './session.repository.js';
import { steerSession } from './session-lifecycle.service.js';
import type { PullRequestRef } from './types/github.types.js';
import type { DebtBaseline, ProjectBaseline } from './types/init.types.js';
import type {
  GateReport,
  GateStageResult,
  MergeOutcome,
  MergeRequest,
} from './types/merge-gate.types.js';
import type { TaskSpec } from './types/profile.types.js';

/**
 * Every git call the gate makes runs with hooks disabled. Worktrees share the
 * main checkout's `$GIT_COMMON_DIR/hooks`, hooks are untracked so the scope
 * audit never sees one appear, and the gate's own `git rebase` runs before any
 * stage — so a planted `pre-rebase` would execute with pup's environment ahead
 * of the sandbox that is supposed to confine it. A command-line `-c` outranks a
 * session-written `.git/config` (decision 28).
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT_SAFE_CONFIG, '-C', cwd, ...args], {
    encoding: 'utf8',
    env: scrubbedGitEnv(),
  }).trim();
}

function isAncestor(repoPath: string, maybeAncestor: string, ref: string): boolean {
  try {
    git(repoPath, 'merge-base', '--is-ancestor', maybeAncestor, ref);
    return true;
  } catch {
    return false;
  }
}

/**
 * A repo path on its way into a stage detail. Paths come from `git diff -z`
 * precisely so they stay raw bytes, and a detail is printed to the operator's
 * terminal, fenced into the PR body, and fed back to the session as a re-steer
 * prompt — so a filename carrying ANSI escapes could repaint the report the
 * operator decides from (the decision-29 rationale, applied to paths).
 */
function quotePath(path: string): string {
  return sanitizeReason(path);
}

/** A CSI escape — where a test runner's colour and cursor moves are carried. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CSI_ESCAPE = /\u001b\[[0-9;:?]*[ -/]*[@-~]/g;
/** Everything else a terminal writes. Newline stays: a detail may list a line each. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

/**
 * A stage detail on its way into the report. A gate command runs in a pty-less
 * child but writes what it would to a terminal — vitest's failures arrived as
 * 2000 chars of raw SGR — and the report is printed to the operator's terminal,
 * fenced into the PR body, and pasted back into the session's input box as the
 * re-steer. Escapes there repaint the report the operator decides from
 * (decision 29's rationale, applied to command output), and worse: a pasted
 * escape never shows in the input box as the characters that were sent, so
 * `pasteLanded` cannot match the paste and the whole re-steer is refused
 * (decision 45). A sibling of `sanitizeReason` rather than that function
 * itself — a detail keeps its newlines, because the scope audit puts a path on
 * each, and its full `GATE_OUTPUT_TAIL_CHARS` of output. An escape of any
 * other form loses its ESC to the control sweep and lands as inert text.
 * Applied to the captured output rather than over the finished report, so the
 * stored stages, the operator's own print and the PR body are plain too and
 * not just the steer. It is the only route an escape takes into a stage that
 * steers: git C-quotes a control byte in a pathname whatever `core.quotePath`
 * says, `quotePath` already sanitizes the scope audit's, and an adapter's own
 * text reaches flagged stages only, which are refused and never steered.
 */
function plainDetail(detail: string): string {
  return detail.replace(CSI_ESCAPE, '').replace(CONTROL_CHARS, ' ').trimEnd();
}

function commandFailureDetail(error: unknown): string {
  const failure = error as { stdout?: string; stderr?: string; message?: string };
  const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim();
  // Plain before the tail is taken, never after: the cut would otherwise land
  // mid-escape and leave its parameters as text, and a coloured runner spends
  // much of the budget on bytes nobody reads.
  return plainDetail(output || (failure.message ?? 'command failed')).slice(
    -GATE_OUTPUT_TAIL_CHARS,
  );
}

/**
 * Adds + deletes across the branch diff, excluding lockfiles and binary files.
 * A null numstat is a measurement, not a skip: a file git reports as binary
 * whose content is text is recounted from its patch and named in `forged`,
 * because git was told to call it binary by something no diff shows
 * (decision 53).
 */
export function countChangedLines(
  repoPath: string,
  target: string,
  branch: string,
): { lines: number; forged: string[] } {
  let lines = 0;
  const forged: string[] = [];
  for (const stat of gitDiffNumstat(repoPath, target, branch)) {
    if (LOCKFILE_NAMES.includes(stat.path)) continue;
    if (stat.added !== null && stat.deleted !== null) {
      lines += stat.added + stat.deleted;
      continue;
    }
    const recount = gitDiffBinaryRecount(repoPath, target, branch, stat.path);
    if (!recount) continue;
    lines += recount.added + recount.deleted;
    forged.push(stat.path);
  }
  return { lines, forged };
}

function withMergeLock<TResult>(repoPath: string, fn: () => TResult): TResult {
  const lockPath = join(repoPath, '.git', MERGE_LOCK_DIRNAME);
  try {
    mkdirSync(lockPath);
  } catch {
    throw new MergeLockHeldError(lockPath);
  }
  try {
    return fn();
  } finally {
    rmdirSync(lockPath);
  }
}

function formatGateReport(report: GateReport): string {
  const lines = report.stages.map(
    (s) => `- ${s.stage}: ${s.status.toUpperCase()}${s.detail ? ` — ${s.detail}` : ''}`,
  );
  const header = `Merge gate ${report.passed ? 'passed' : 'FAILED'} for session ${report.sessionId}.`;
  // The containment line sits with the stages, not in a footnote: this text is
  // the PR body and the re-steer prompt as well as the terminal report.
  lines.push(`- sandbox: ${report.sandbox}`);
  if (report.passed) return [header, ...lines].join('\n');
  return [
    header,
    ...lines,
    '',
    'Fix the failures above, commit in this worktree, then run `pup session done "<summary>"` again.',
  ].join('\n');
}

/**
 * `pup merge`: fresh-base check with mechanical auto-rebase (decision 8), then the
 * hard stages — build, tests, lint, a touched nested package's own test and
 * typecheck (decision 59), scope audit — and the soft debt stages:
 * diff-size plus the v1.1 debt deltas (dead code, duplication, complexity;
 * decision 21). Pass: ff-only merge, full cleanup (decision 16), and the debt
 * baseline ratchets to the merged state. Hard fail: re-steer with the report, cap
 * at two rejections then park as blocked (decisions 7, 15). Any soft flag without
 * --accept-debt refuses the merge but leaves the session reviewable (decision 17);
 * with it, each flag writes a ledger entry. The whole run holds the per-repo
 * merge lock.
 */
export function runMergeGate(db: Database, req: MergeRequest): MergeOutcome {
  const session = getSession(db, req.sessionId);
  if (!session) throw new Error(`No session ${req.sessionId}.`);
  if (session.state !== 'awaiting-review') {
    throw new SessionNotReviewableError(req.sessionId, session.state);
  }
  // Before the auto-rebase, which runs a smudge filter on every file it checks
  // out and a merge driver on every conflict, with the operator's environment
  // and ahead of the sandbox that confines the stages. Both paths, because the
  // rebase runs in the worktree and the ff-only merge in the main checkout,
  // and a worktree-scoped config is only visible from its own worktree
  // (decision 50).
  assertNoArmedGitDrivers(req.repoPath);
  assertNoArmedGitDrivers(session.worktree_path);
  const target = git(req.repoPath, 'branch', '--show-current');
  if (!target) {
    throw new Error(`Main worktree at ${req.repoPath} is not on a branch; cannot merge.`);
  }
  let pullRequest: PullRequestPlan | undefined;
  if (req.openPr) {
    assertGhAvailable();
    // Resolved once, here, and carried to the push, so the PR's repo and the
    // pushed-to URL are one value and nothing the stages run can move it
    // (decisions 54, 56).
    const originUrl = pushTarget(db, session, req.repoPath);
    const ref = {
      repo: originRepoSlug(originUrl),
      head: session.branch,
      base: target,
    };
    // Everything GitHub can refuse is settled here, before ten minutes of gate
    // stages and before --accept-debt writes ledger entries for a merge that
    // would then abort (decision 27).
    pullRequest = { ...ref, originUrl, adoptedUrl: findOpenPullRequest(req.repoPath, ref) };
  }
  return withMergeLock(req.repoPath, () => gateAndMerge(db, req, session, target, pullRequest));
}

const PUSH_TARGET_HELP =
  'Nothing was pushed. The config the value lives in is shared with every worktree and a ' +
  'session can rewrite it, so treat a session that moved it as compromised; if origin really ' +
  'moved, re-record it with `pup init --origin-moved` from the trusted checkout.';

/**
 * Where the branch is pushed and which repo the PR is pinned to: the URL
 * recorded on the project row, and only while origin is still configured as
 * that same value.
 *
 * Decision 54 stopped the push reading `url.*` rewrites out of the shared
 * config, and left the ceiling this closes: `remote.origin.url` itself lives in
 * that same session-writable config, so a session that rewrites it aims both
 * the push and the `--repo` pin. The recorded copy is the trusted one — written
 * by `pup init` from the operator's checkout — so it is what pup pushes to, and
 * the live read is here to say when something moved it rather than to be
 * quietly worked around. Both refusals are decision 6's loud backstop: they
 * name both values and happen before the gate runs, so nothing is pushed.
 */
function pushTarget(db: Database, session: SessionRow, repoPath: string): string {
  const configured = readOriginUrl(repoPath);
  if (!configured) {
    throw new Error('`pup merge --pr` needs an `origin` remote to push the branch to.');
  }
  const task = getTask(db, session.task_id);
  if (!task) throw new Error(`Session ${session.id} has no task row; cannot resolve its project.`);
  const project = getProject(db, task.project_id);
  // The session reaches its project through its task row, which is a second
  // notion of "this project" beside the path the merge was asked for. They
  // agree in every store pup writes; if they ever did not, the push target
  // would be read from a row describing another checkout.
  if (project && project.repo_path !== repoPath) {
    throw new Error(
      `Session ${session.id} belongs to project ${task.project_id}, recorded at ` +
        `${project.repo_path}, not the ${repoPath} this merge was asked for. Nothing was pushed.`,
    );
  }
  const recorded = project?.origin_url ?? undefined;
  if (!recorded) {
    throw new Error(
      'No push target is recorded for this project, so there is nothing to check origin ' +
        `against: origin says ${sanitizeReason(configured)}, and nothing says that is where ` +
        'the operator pointed it. Run `pup init` from the trusted checkout to record it, ' +
        'then retry. Nothing was pushed.',
    );
  }
  if (recorded !== configured) {
    throw new Error(
      "Refusing `pup merge --pr`: origin's URL is not the one recorded when this project " +
        `was set up.\n  recorded:   ${sanitizeReason(recorded)}\n  configured: ` +
        `${sanitizeReason(configured)}\n${PUSH_TARGET_HELP}`,
    );
  }
  return recorded;
}

interface PullRequestPlan extends PullRequestRef {
  /** The push target recorded at setup; the push goes here literally (decision 56). */
  originUrl: string;
  /** Set when an open PR for this branch already exists and passed adoption checks. */
  adoptedUrl?: string;
}

function gateAndMerge(
  db: Database,
  req: MergeRequest,
  session: SessionRow,
  target: string,
  pullRequest?: PullRequestPlan,
): MergeOutcome {
  const worktree = session.worktree_path;
  // Measure the session's work, but read which tools are declared from the main
  // checkout the merge lock holds at the target branch: otherwise a session
  // silences a debt stage by editing its own manifest (decision 29).
  const capabilityContext: CapabilityContext = {
    measurePath: worktree,
    configPath: req.repoPath,
    ...(req.gateEnv?.length ? { gateEnv: req.gateEnv } : {}),
  };
  const sandbox = sandboxLabel();
  const stages: GateStageResult[] = [];
  const failed = (): MergeOutcome =>
    rejectOrBlock(db, { sessionId: session.id, passed: false, sandbox, stages });

  const dirty = git(worktree, 'status', '--porcelain');
  if (dirty) {
    stages.push({
      stage: 'worktree-clean',
      status: 'fail',
      detail: `Uncommitted changes in the worktree:\n${dirty}`,
    });
    return failed();
  }
  stages.push({ stage: 'worktree-clean', status: 'pass' });

  if (isAncestor(req.repoPath, target, session.branch)) {
    stages.push({ stage: 'fresh-base', status: 'pass', detail: `already based on ${target}` });
  } else {
    try {
      git(worktree, 'rebase', target);
      stages.push({ stage: 'fresh-base', status: 'pass', detail: `auto-rebased onto ${target}` });
    } catch (error) {
      try {
        git(worktree, 'rebase', '--abort');
      } catch {
        // nothing to abort — the rebase never started
      }
      stages.push({
        stage: 'fresh-base',
        status: 'fail',
        detail:
          `Auto-rebase onto ${target} hit conflicts. Run \`git rebase ${target}\`, ` +
          `resolve the conflicts, and finish the rebase.\n${commandFailureDetail(error)}`,
      });
      return failed();
    }
  }

  /** Runs one hard stage; false once it has recorded the failure. */
  const commandStage = (
    stage: string,
    command: { command: string; args: string[] },
    cwd: string,
  ): boolean => {
    try {
      // The session wrote what this runs (its own scripts, its own config), so
      // it runs confined: an env allowlist (decision 28) inside a sandbox whose
      // writes are default-deny (decision 36). The stage writes in its own
      // worktree; `repoPath` is passed to scope the toolchain cache, and stays
      // read-only, which is what keeps decision 29's trusted checkout trusted
      // while the session's own code is running.
      runGateChild(command.command, command.args, {
        cwd,
        repoPath: req.repoPath,
        gateEnv: req.gateEnv,
        timeout: GATE_COMMAND_TIMEOUT_MS,
      });
      stages.push({ stage, status: 'pass' });
      return true;
    } catch (error) {
      stages.push({ stage, status: 'fail', detail: commandFailureDetail(error) });
      return false;
    }
  };

  // Resolved from the trusted main checkout, not the session's worktree: a
  // session that deletes a script fails that stage instead of skipping it.
  const commands = req.adapter.gateCommands(req.repoPath);
  for (const stage of ['build', 'test', 'lint'] as const) {
    const command = commands.find((c) => c.stage === stage);
    if (!command) {
      stages.push({ stage, status: 'skipped', detail: 'not measured — no command available' });
      continue;
    }
    if (!commandStage(stage, command, worktree)) return failed();
  }

  const changedPaths = gitDiffPaths(req.repoPath, target, session.branch);
  const flaggedDebt: { description: string; files: string[] }[] = [];
  const acceptHint =
    'Re-run with --accept-debt "<reason>" --review-by "<condition>", or steer the session to address it.';
  const flagDetail = (summary: string): string =>
    req.acceptDebt
      ? `${summary} — accepted as debt: ${req.acceptDebt.reason}`
      : `${summary}. ${acceptHint}`;

  // Decision 58 leaves a nested package out of every root measurement because
  // its own runner covers it; nothing else invokes that runner, so the gate
  // does, as hard stages in the package's own directory. A script the trusted
  // manifest lacks is a flag: changed code no stage measures is never a free
  // pass (decisions 30, 59).
  const nestedPackages = req.adapter.touchedNestedPackages?.(capabilityContext, changedPaths) ?? [];
  for (const pkg of nestedPackages) {
    const dir = quotePath(pkg.dir);
    for (const command of pkg.commands) {
      if (!commandStage(`${command.stage} (${dir})`, command, join(worktree, pkg.dir))) {
        return failed();
      }
    }
    for (const stage of pkg.missing) {
      flaggedDebt.push({
        description: `Nested package ${dir} changed with no ${stage} script, merged from session ${session.id}`,
        files: [...pkg.changedFiles].sort(),
      });
      stages.push({
        stage: `${stage} (${dir})`,
        status: 'flagged',
        detail: flagDetail(
          `not measured — ${dir}/package.json declares no ${stage} script, and no root stage measures a nested package`,
        ),
      });
    }
  }
  // Said on every debt stage the exclusion shapes, so a pass there reads as
  // "measured without these", not as "nothing to measure" (decision 29).
  const droppedDirs = nestedPackages.filter((pkg) => pkg.droppedSources.length > 0);
  const droppedCount = droppedDirs.reduce((sum, pkg) => sum + pkg.droppedSources.length, 0);
  const nestedNote =
    droppedCount === 0
      ? ''
      : `; ${droppedCount} changed file(s) in a nested package not measured here (${droppedDirs
          .slice(0, DEBT_DETAIL_SAMPLES)
          .map((pkg) => quotePath(pkg.dir))
          .join(', ')}${droppedDirs.length > DEBT_DETAIL_SAMPLES ? ', …' : ''})`;
  const measuredHere = (detail: string): string => `${detail}${nestedNote}`;

  const specRow = db
    .prepare('SELECT project_id, spec FROM tasks WHERE id = ?')
    .get(session.task_id) as { project_id: string; spec: string };
  const spec = JSON.parse(specRow.spec) as TaskSpec;
  const violations = auditScope(changedPaths, spec.scopeIn, spec.scopeOut ?? []);
  if (violations.length > 0) {
    stages.push({
      stage: 'scope-audit',
      status: 'fail',
      detail: `Out-of-scope changes:\n${violations
        .map((v) => `  ${quotePath(v.path)} (${v.reason})`)
        .join('\n')}`,
    });
    return failed();
  }
  stages.push({
    stage: 'scope-audit',
    status: 'pass',
    detail: `${changedPaths.length} files in scope`,
  });

  // Snapshot before any --accept-debt entry from THIS merge is written, so a
  // merge never flags its own fresh debt as closeable.
  const debtCandidates = listLedgerEntries(db, specRow.project_id)
    .filter((entry) => {
      const files = JSON.parse(entry.files) as string[];
      return files.some((f) => changedPaths.includes(f));
    })
    .map((entry) => ({ id: entry.id, description: entry.description }));

  const project = getProject(db, specRow.project_id);
  const baseline = project?.baseline
    ? (JSON.parse(project.baseline) as ProjectBaseline)
    : undefined;
  const measuredDebt: DebtBaseline = {};

  const changed = countChangedLines(req.repoPath, target, session.branch);
  const sizeFindings: string[] = [];
  if (changed.lines > DIFF_SIZE_FLAG_LINES) {
    flaggedDebt.push({
      description: `Oversize diff (${changed.lines} lines) merged from session ${session.id}`,
      files: changedPaths,
    });
    sizeFindings.push(`exceeds the ${DIFF_SIZE_FLAG_LINES}-line flag`);
  }
  // Flagged at any size: the count is honest again once recounted, but a text
  // file git was told to call binary is a write nobody reviewed (decision 53).
  if (changed.forged.length > 0) {
    const forged = [...changed.forged].sort();
    const quoted = forged.slice(0, DEBT_DETAIL_SAMPLES).map(quotePath).join(', ');
    const ellipsis = forged.length > DEBT_DETAIL_SAMPLES ? ', …' : '';
    flaggedDebt.push({
      description: `Text files git reports as binary (${forged.length}) merged from session ${session.id}`,
      files: forged,
    });
    sizeFindings.push(
      `counts ${forged.length} text file(s) git reports as binary, recounted from the patch: ` +
        `${quoted}${ellipsis}`,
    );
  }
  if (sizeFindings.length > 0) {
    stages.push({
      stage: 'diff-size',
      status: 'flagged',
      detail: flagDetail(`${changed.lines} changed lines ${sizeFindings.join('; ')}`),
    });
  } else {
    stages.push({ stage: 'diff-size', status: 'pass', detail: `${changed.lines} changed lines` });
  }

  if (!req.adapter.deadCode) {
    stages.push({
      stage: 'dead-code',
      status: 'skipped',
      detail: 'not measured — adapter cannot detect dead code',
    });
  } else {
    const result = req.adapter.deadCode(capabilityContext);
    if (!isUnavailable(result)) measuredDebt.deadExports = result;
    const known = baseline?.debt?.deadExports;
    if (isUnavailable(result)) {
      stages.push({
        stage: 'dead-code',
        status: 'skipped',
        detail: measuredHere(`not measured — ${sanitizeReason(result.unavailable)}`),
      });
    } else if (!known) {
      stages.push({
        stage: 'dead-code',
        status: 'skipped',
        detail: measuredHere('not measured — no debt baseline; run `pup init`'),
      });
    } else {
      const knownKeys = new Set(known.map((d) => `${d.file}\u0000${d.exportName}`));
      const fresh = result.filter((d) => !knownKeys.has(`${d.file}\u0000${d.exportName}`));
      if (fresh.length === 0) {
        stages.push({
          stage: 'dead-code',
          status: 'pass',
          detail: measuredHere('no new unused exports'),
        });
      } else {
        const quoted = fresh
          .slice(0, DEBT_DETAIL_SAMPLES)
          .map((d) => `${quotePath(d.file)}#${d.exportName}`)
          .join(', ');
        const ellipsis = fresh.length > DEBT_DETAIL_SAMPLES ? ', …' : '';
        flaggedDebt.push({
          description: `New unused exports (${fresh.length}) merged from session ${session.id}`,
          // Sorted so a retry produces the same list, and with it the same
          // ledger dedupe key, whatever order the tool reported findings in.
          files: [...new Set(fresh.map((d) => d.file))].sort(),
        });
        stages.push({
          stage: 'dead-code',
          status: 'flagged',
          detail: flagDetail(
            measuredHere(`${fresh.length} new unused export(s): ${quoted}${ellipsis}`),
          ),
        });
      }
    }
  }

  if (!req.adapter.duplication) {
    stages.push({
      stage: 'duplication',
      status: 'skipped',
      detail: 'not measured — adapter cannot detect duplication',
    });
  } else {
    const duplication = req.adapter.duplication(capabilityContext);
    // A number counted under an older rule is not a bar, it is a different
    // measurement — comparing across the two passes on the difference. So a
    // mismatch skips the stage, and must not move the bar either: this number
    // was never compared to anything, and re-stamping it here would let one
    // merge write an arbitrary floor that every later merge gates against and
    // `pup audit` then confirms. Only `pup audit`, on the trusted checkout,
    // re-stamps an existing baseline (decisions 30, 39).
    const comparableRule = baseline?.debt?.duplicationRule === DUPLICATION_RULE_ID;
    if (comparableRule || baseline?.debt?.duplicatedLines === undefined) {
      measuredDebt.duplicatedLines = duplication.duplicatedLines;
      measuredDebt.duplicationRule = DUPLICATION_RULE_ID;
    }
    const knownLines = comparableRule ? baseline?.debt?.duplicatedLines : undefined;
    // Say what was left out, so a number that fell has a visible reason and a
    // pile of copy-pasted fixtures is not silently invisible (decisions 29, 39).
    // Re-checked as a finite number here as well as at the custom adapter's
    // boundary: this string reaches the terminal, the fenced PR body and the
    // re-steer prompt, and an adapter is not the only possible producer.
    const excludedBlocks = duplication.excludedTestBlocks;
    const fixtureNote =
      typeof excludedBlocks === 'number' && Number.isFinite(excludedBlocks) && excludedBlocks > 0
        ? `; ${Math.trunc(excludedBlocks)} test-fixture block(s) not counted`
        : '';
    if (knownLines === undefined) {
      stages.push({
        stage: 'duplication',
        status: 'skipped',
        detail: measuredHere(
          baseline?.debt?.duplicatedLines === undefined
            ? 'not measured — no debt baseline; run `pup init`'
            : 'not measured — the stored baseline counts duplication a different way; run `pup audit`',
        ),
      });
    } else if (duplication.duplicatedLines <= knownLines) {
      stages.push({
        stage: 'duplication',
        status: 'pass',
        detail: measuredHere(
          `${duplication.duplicatedLines} duplicated lines (baseline ${knownLines})${fixtureNote}`,
        ),
      });
    } else {
      const changedSet = new Set(changedPaths);
      const touchedBlocks = duplication.blocks.filter((b) =>
        b.locations.some((l) => changedSet.has(l.file)),
      );
      const samples = (touchedBlocks.length > 0 ? touchedBlocks : duplication.blocks)
        .slice(0, DEBT_DETAIL_SAMPLES)
        .map((b) =>
          b.locations
            .slice(0, 2)
            .map((l) => `${quotePath(l.file)}:${l.line}`)
            .join(' ≈ '),
        )
        .join('; ');
      const files = [
        ...new Set(
          touchedBlocks
            .flatMap((b) => b.locations.map((l) => l.file))
            .filter((f) => changedSet.has(f)),
        ),
      ].sort();
      flaggedDebt.push({
        description: `Duplicated lines rose from ${knownLines} to ${duplication.duplicatedLines} in session ${session.id}`,
        files: files.length > 0 ? files : changedPaths,
      });
      stages.push({
        stage: 'duplication',
        status: 'flagged',
        detail: flagDetail(
          measuredHere(
            `duplicated lines rose from ${knownLines} to ${duplication.duplicatedLines} (e.g. ${samples})${fixtureNote}`,
          ),
        ),
      });
    }
  }

  if (!req.adapter.complexity) {
    stages.push({
      stage: 'complexity',
      status: 'skipped',
      detail: 'not measured — adapter cannot measure complexity',
    });
  } else {
    // "Before" reads the main checkout, which the merge lock holds at the target
    // branch — no historical checkout needed.
    const before = new Map(
      req.adapter
        .complexity(localContext(req.repoPath, req.gateEnv), changedPaths)
        .map((f) => [f.file, f.complexity]),
    );
    const risen = req.adapter
      .complexity(capabilityContext, changedPaths)
      .map((f) => ({ ...f, delta: f.complexity - (before.get(f.file) ?? 0) }))
      .filter((f) => f.delta > COMPLEXITY_FILE_FLAG_DELTA);
    if (risen.length === 0) {
      stages.push({
        stage: 'complexity',
        status: 'pass',
        detail: `no touched file rose by more than ${COMPLEXITY_FILE_FLAG_DELTA} decision points`,
      });
    } else {
      const quoted = risen
        .slice(0, DEBT_DETAIL_SAMPLES)
        .map((f) => `${quotePath(f.file)} (+${f.delta})`)
        .join(', ');
      const ellipsis = risen.length > DEBT_DETAIL_SAMPLES ? ', …' : '';
      flaggedDebt.push({
        description: `Complexity rise (+${risen.reduce((sum, f) => sum + f.delta, 0)} decision points) merged from session ${session.id}`,
        files: risen.map((f) => f.file),
      });
      stages.push({
        stage: 'complexity',
        status: 'flagged',
        detail: flagDetail(
          `complexity rose sharply in ${risen.length} touched file(s): ${quoted}${ellipsis}`,
        ),
      });
    }
  }

  if (!req.adapter.coverage) {
    stages.push({
      stage: 'coverage',
      status: 'skipped',
      detail: 'not measured — adapter cannot measure coverage',
    });
  } else {
    const result = req.adapter.coverage(capabilityContext);
    const coverageReport = isUnavailable(result) ? undefined : result;
    const repoRatio = coverageReport ? repoCoverageRatio(coverageReport) : undefined;
    if (repoRatio !== undefined) measuredDebt.coverageRatio = repoRatio;
    const baselineRatio = baseline?.debt?.coverageRatio;
    const coverable = req.adapter.coverableFiles?.(capabilityContext, changedPaths) ?? [];
    if (!coverageReport || repoRatio === undefined) {
      const reason = isUnavailable(result)
        ? sanitizeReason(result.unavailable)
        : 'the instrumented run reported no instrumentable lines';
      // Skipping here is a session-reachable outcome, not just an environment
      // gap: the coverage config lives in the worktree, so failing the run or
      // emptying the report turns the stage off. Changed source plus no
      // measurement is a flag, not a free skip (decision 30).
      if (coverable.length > 0) {
        flaggedDebt.push({
          description: `Coverage unmeasured over ${coverable.length} changed source file(s) in session ${session.id}`,
          files: [...coverable].sort(),
        });
        stages.push({
          stage: 'coverage',
          status: 'flagged',
          detail: flagDetail(
            measuredHere(`${coverable.length} changed source file(s) went unmeasured — ${reason}`),
          ),
        });
      } else {
        stages.push({
          stage: 'coverage',
          status: 'skipped',
          detail: measuredHere(`not measured — ${reason}`),
        });
      }
    } else if (baselineRatio === undefined) {
      stages.push({
        stage: 'coverage',
        status: 'skipped',
        detail: measuredHere('not measured — no coverage baseline; run `pup init`'),
      });
    } else {
      const patch = patchCoverage(
        coverageReport,
        gitDiffAddedLines(req.repoPath, target, session.branch),
      );
      const pct = (ratio: number): string => `${Math.round(ratio * 1000) / 10}%`;
      // Changed code the report never mentions is the loophole patch coverage
      // alone cannot see: excluding a file otherwise reads as "no instrumentable
      // changed lines" and passes for free (decision 30). hasOwn, not `in`: the
      // Python report is parsed JSON, so its keys can reach the prototype.
      const unreported = coverable.filter((file) => !Object.hasOwn(coverageReport.files, file));
      const ratio = patch.instrumented === 0 ? undefined : patch.covered / patch.instrumented;
      const ratioBelowBar = ratio !== undefined && ratio + COVERAGE_RATIO_EPSILON < baselineRatio;
      if (unreported.length > 0 || ratioBelowBar) {
        // Both are evaluated, never short-circuited: a merge that hides files
        // AND drops patch coverage must record both, or the ledger understates
        // what was accepted while the baseline ratchets anyway.
        const problems: string[] = [];
        const files = new Set<string>();
        if (unreported.length > 0) {
          const quoted = unreported.slice(0, DEBT_DETAIL_SAMPLES).map(quotePath).join(', ');
          const ellipsis = unreported.length > DEBT_DETAIL_SAMPLES ? ', …' : '';
          problems.push(
            `${unreported.length} changed source file(s) never reached the coverage report — no test loads them, or coverage config excludes them: ${quoted}${ellipsis}`,
          );
          for (const file of unreported) files.add(file);
        }
        if (ratio !== undefined && ratioBelowBar) {
          const quoted = patch.uncovered
            .slice(0, DEBT_DETAIL_SAMPLES)
            .map((u) => `${quotePath(u.file)}:${u.line}`)
            .join(', ');
          const ellipsis = patch.uncovered.length > DEBT_DETAIL_SAMPLES ? ', …' : '';
          problems.push(
            `patch coverage ${pct(ratio)} below repo baseline ${pct(baselineRatio)} (uncovered: ${quoted}${ellipsis})`,
          );
          for (const u of patch.uncovered) files.add(u.file);
        }
        flaggedDebt.push({
          description: `Coverage gap (${problems.length === 2 ? 'unreported files and patch coverage' : unreported.length > 0 ? 'unreported files' : `patch coverage ${pct(ratio as number)} below baseline ${pct(baselineRatio)}`}) merged from session ${session.id}`,
          files: [...files].sort(),
        });
        stages.push({
          stage: 'coverage',
          status: 'flagged',
          detail: flagDetail(measuredHere(problems.join('; '))),
        });
      } else if (ratio === undefined) {
        stages.push({
          stage: 'coverage',
          status: 'pass',
          detail: measuredHere('no instrumentable changed lines'),
        });
      } else {
        stages.push({
          stage: 'coverage',
          status: 'pass',
          detail: measuredHere(`patch coverage ${pct(ratio)} (baseline ${pct(baselineRatio)})`),
        });
      }
    }
  }

  if (flaggedDebt.length > 0) {
    if (!req.acceptDebt) {
      const report: GateReport = { sessionId: session.id, passed: false, sandbox, stages };
      appendEvent(db, session.id, 'gate_result', { outcome: 'refused', report });
      return { status: 'refused', report, rejectCount: session.reject_count };
    }
    for (const flag of flaggedDebt) {
      const entry = {
        projectId: specRow.project_id,
        description: flag.description,
        files: flag.files,
        reason: req.acceptDebt.reason,
        acceptedBy: req.acceptDebt.acceptedBy,
        reviewBy: req.acceptDebt.reviewBy,
      };
      // A retry after a partial failure (gh died after the push) re-runs the
      // gate with the same flags — the same debt must not be counted twice.
      // Safe because every description above embeds the session id, so this can
      // only ever match this session's own earlier attempt.
      if (!hasOpenLedgerEntry(db, entry)) insertLedgerEntry(db, entry);
    }
  }

  const report: GateReport = { sessionId: session.id, passed: true, sandbox, stages };
  const commitSubjects = git(
    req.repoPath,
    'log',
    '--reverse',
    '--format=%s',
    `${target}..${session.branch}`,
  )
    .split('\n')
    .filter(Boolean);
  let prUrl: string | undefined;
  let prWasAdopted = false;
  if (pullRequest) {
    const newPr = {
      ...pullRequest,
      title: prTitle(spec.goal) || `pup session ${session.id}`,
      body: prBody(spec, report, commitSubjects),
    };
    pushBranch(req.repoPath, pullRequest.originUrl, session.branch);
    if (pullRequest.adoptedUrl) {
      rewritePullRequest(req.repoPath, pullRequest.adoptedUrl, newPr);
      prWasAdopted = true;
      prUrl = pullRequest.adoptedUrl;
    } else {
      prUrl = createPullRequest(req.repoPath, newPr);
    }
  } else {
    git(req.repoPath, 'merge', '--ff-only', session.branch);
  }
  transitionSession(db, session.id, 'merged', { report });
  appendEvent(db, session.id, 'merge', {
    branch: session.branch,
    target,
    files: changedPaths,
    ...(prUrl !== undefined ? { prUrl } : {}),
  });
  if (
    // In PR mode the target branch has not moved, so the bar must not either:
    // the next `pup audit` after the PR lands ratchets it (decision 26).
    !req.openPr &&
    project &&
    baseline &&
    (measuredDebt.deadExports !== undefined ||
      measuredDebt.duplicatedLines !== undefined ||
      measuredDebt.coverageRatio !== undefined)
  ) {
    // Ratchet (docs/04): the merged state becomes the new bar. Accepted-debt merges
    // move it too — the accepted amount lives in the ledger, and re-flagging it would
    // punish later sessions for debt they didn't add.
    const next: ProjectBaseline = { ...baseline, debt: { ...baseline.debt, ...measuredDebt } };
    saveProjectBaseline(
      db,
      specRow.project_id,
      JSON.parse(project.adapters) as string[],
      JSON.stringify(next),
    );
  }
  const decisionRecordId = draftDecisionRecord(db, {
    sessionId: session.id,
    spec,
    files: changedPaths,
    commitSubjects,
  });

  // By pane as well as name: a rename from inside the session would leave
  // the name pointing at nothing while the window ran on (decision 46).
  killTmux(session.id, session.tmux_target);
  git(req.repoPath, 'worktree', 'remove', '--force', worktree);
  // PR mode needs -D: the branch is not in the local target's history, only on origin.
  git(req.repoPath, 'branch', req.openPr ? '-D' : '-d', session.branch);
  return {
    status: 'merged',
    report,
    rejectCount: session.reject_count,
    debtCandidates,
    decisionRecordId,
    ...(prUrl !== undefined ? { prUrl, prWasAdopted } : {}),
  };
}

/**
 * Push the session branch to origin's pinned URL. A retry after a failed `--pr`
 * run has usually been rebased onto a moved target, so a plain push would be
 * rejected non-fast-forward — and so would every retry after it, dead-ending
 * the branch. The branch is pup's own (`pup/<slug>`, created and deleted by
 * pup) and the gate just validated these commits, so the rewrite is intended.
 * The lease still refuses if origin moved past what pup itself last pushed, and
 * it only applies once a remote-tracking ref exists — on the first push there
 * is nothing to lease against.
 *
 * Naming the URL is not enough on its own: git rewrites a literal URL through
 * `url.<base>.insteadOf` and `pushInsteadOf` exactly as it rewrites a remote's,
 * and a `-c` rewrite of our own loses the tie to a session's that matches the
 * whole URL. So the push runs from an empty scratch git dir borrowing the
 * repo's objects: the shared config is never read, while the operator's global
 * and system config still apply (decision 54). Pushing to a URL updates no
 * remote-tracking ref, so the lease names its value and the ref is moved here.
 */
function pushBranch(repoPath: string, originUrl: string, branch: string): void {
  const tracking = `refs/remotes/origin/${branch}`;
  const leased = (() => {
    try {
      // A missing remote-tracking ref is the expected first-push case, not an
      // error: git's stderr is captured here (not inherited) so its "fatal:
      // Needed a single revision" doesn't reach the operator console.
      return execFileSync(
        'git',
        [...GIT_SAFE_CONFIG, '-C', repoPath, 'rev-parse', '--verify', tracking],
        { encoding: 'utf8', env: scrubbedGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim();
    } catch {
      return undefined;
    }
  })();
  const tip = git(repoPath, 'rev-parse', `refs/heads/${branch}`);
  const objects = git(repoPath, 'rev-parse', '--path-format=absolute', '--git-path', 'objects');
  const scratch = mkdtempSync(join(tmpdir(), 'pup-push-'));
  try {
    git(scratch, 'init', '--quiet', '--bare', '--template=');
    // Unlike the shared git() helper this gets a timeout: a stalled push would
    // otherwise hang while holding the merge lock. Hooks are off for the same
    // reason they are everywhere else in the gate (decision 28).
    execFileSync(
      'git',
      [
        ...GIT_SAFE_CONFIG,
        '--git-dir',
        scratch,
        'push',
        ...(leased ? [`--force-with-lease=refs/heads/${branch}:${leased}`] : []),
        originUrl,
        `${tip}:refs/heads/${branch}`,
      ],
      {
        encoding: 'utf8',
        timeout: GATE_COMMAND_TIMEOUT_MS,
        env: { ...scrubbedGitEnv(), GIT_OBJECT_DIRECTORY: objects },
      },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  git(repoPath, 'update-ref', tracking, tip);
}

function prTitle(goal: string): string {
  const line = (goal.split('\n')[0] as string).trim();
  return line.length <= PR_TITLE_MAX_CHARS ? line : `${line.slice(0, PR_TITLE_MAX_CHARS - 1)}…`;
}

function prBody(spec: TaskSpec, report: GateReport, commitSubjects: string[]): string {
  // Commit subjects and gate details quote session-authored text. Fenced so
  // GitHub renders it inert — no `Closes #n` auto-closing, no @mention pings,
  // no invisible HTML comments aimed at review bots.
  return [
    '## Goal',
    '',
    spec.goal,
    '',
    '## Acceptance',
    '',
    ...spec.acceptance.map((item) => `- ${item}`),
    '',
    '## Commits',
    '',
    '````',
    ...commitSubjects,
    '````',
    '',
    '## Gate report',
    '',
    '````',
    formatGateReport(report),
    '````',
  ].join('\n');
}

function rejectOrBlock(db: Database, report: GateReport): MergeOutcome {
  const rejectCount = incrementRejectCount(db, report.sessionId);
  transitionSession(db, report.sessionId, 'rejected', { report });
  if (rejectCount > MAX_REJECTS_BEFORE_BLOCKED) {
    transitionSession(db, report.sessionId, 'blocked', {
      reason: `reject cap of ${MAX_REJECTS_BEFORE_BLOCKED} reached`,
      rejectCount,
    });
    return { status: 'blocked', report, rejectCount };
  }
  try {
    steerSession(db, report.sessionId, formatGateReport(report));
  } catch (error) {
    // Two different sessions to walk up to, so two different reasons. A
    // refused paste (decision 45) leaves a live pane with an empty box and an
    // agent still working from its last turn; everything else — a gone
    // window, no pane recorded — leaves nothing to type into at all. The
    // error's own message names the session, the length and which of the two
    // refusals it was, which is what the human needs before deciding.
    transitionSession(db, report.sessionId, 'blocked', {
      reason:
        error instanceof SteerNotDeliveredError
          ? error.message
          : 're-steer failed — session unreachable',
      rejectCount,
    });
    return { status: 'blocked', report, rejectCount };
  }
  appendEvent(db, report.sessionId, 'steer', { kind: 'gate-rejection' });
  transitionSession(db, report.sessionId, 'running', { kind: 'gate-rejection-resteer' });
  return { status: 'rejected', report, rejectCount };
}
