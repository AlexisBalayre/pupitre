#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Database } from 'better-sqlite3';
import { Command, CommanderError } from 'commander';
import { render } from 'ink';
import { createElement } from 'react';
import { stringify } from 'yaml';
import { detectAdapters } from '../adapters/adapter.registry.js';
import { failureSummary, sanitizeReason } from '../adapters/capability.utils.js';
import {
  conductorName,
  conductorSocket,
  killWatcher,
  launchWatcher,
  SessionPaneMissingError,
  SteerNotDeliveredError,
} from '../claude/session-runtime.service.js';
import { auditProject, buildSweepTask, formatDebtTransition } from '../core/audit.service.js';
import { briefPath, ensureBrief, readBrief } from '../core/brief.service.js';
import { buildCodeMap, renderCodeMap } from '../core/code-map.service.js';
import { codegraphLabel } from '../core/codegraph.client.js';
import { isConductorRunning, startConductor, stopConductor } from '../core/conductor.service.js';
import {
  blockedReason,
  buildDashboardSnapshot,
  findStalledSessions,
  goalHeadline,
} from '../core/dashboard.service.js';
import {
  type DecisionRecordRow,
  deleteDecisionRecord,
  getDecisionRecord,
  listDecisionRecords,
  updateDecisionRecordSummary,
} from '../core/decision-record.repository.js';
import { DEFAULT_BASE_PROFILE } from '../core/default-profile.constants.js';
import { fleetReading, readFleet } from '../core/fleet.service.js';
import { parseGateEnv } from '../core/gate-env.utils.js';
import { initProject } from '../core/init.service.js';
import { closeLedgerEntry, listLedgerEntries } from '../core/ledger.repository.js';
import { MAX_REJECTS_BEFORE_BLOCKED, MERGE_LOCK_DIRNAME } from '../core/merge-gate.constants.js';
import { runMergeGate } from '../core/merge-gate.service.js';
import { renderMindMapHtml } from '../core/mind-map.service.js';
import { getWatcherBeat } from '../core/overlap.repository.js';
import { scanOverlaps, WATCH_INTERVAL_MS, WATCH_STALE_AFTER_MS } from '../core/overlap.service.js';
import { projectId, projectPaths } from '../core/paths.utils.js';
import { InvalidProfileError } from '../core/profile.errors.js';
import { UnknownProfileError } from '../core/profile-store.errors.js';
import { getProfileLayer, listProfileLayers } from '../core/profile-store.service.js';
import { listProjects, putProjectToSleep, wakeProject } from '../core/project.service.js';
import { renderReportHtml } from '../core/report.service.js';
import { buildReviewQueue, buildSessionReview } from '../core/review.service.js';
import {
  appendEvent,
  deleteTask,
  findSessionByWorktree,
  getProject,
  getSession,
  getTask,
  listBacklogTasks,
  listSessions,
  type SessionRow,
  transitionSession,
  updateTaskSpec,
} from '../core/session.repository.js';
import { formatStaleAge } from '../core/session-activity.utils.js';
import { dossierFileName, renderSessionDossierHtml } from '../core/session-dossier.service.js';
import {
  awaitHandoffReady,
  HANDOFF_WAIT_DEFAULT_MS,
  HandoffMissingError,
  hardRespawnSession,
  isHandoffReady,
  markHandoffReady,
  requestHandoff,
  respawnSession,
} from '../core/session-handoff.service.js';
import {
  ScopeConflictError,
  TaskAlreadyClaimedError,
  UnknownTaskError,
} from '../core/session-lifecycle.errors.js';
import {
  createSession,
  interruptSession,
  killSession,
  launchTask,
  markSessionDone,
  planTask,
  steerSession,
} from '../core/session-lifecycle.service.js';
import { isTerminal } from '../core/session-state.utils.js';
import { assertPlannableSpec } from '../core/task-spec.utils.js';
import { sweepDeadTurns } from '../core/turn-watchdog.service.js';
import type { ConductorHandle } from '../core/types/conductor.types.js';
import type { DashboardSnapshot } from '../core/types/dashboard.types.js';
import type { DebtBaseline, InitReport } from '../core/types/init.types.js';
import type { GateReport, GateStageResult, MergeOutcome } from '../core/types/merge-gate.types.js';
import type { TaskId, TaskSpec } from '../core/types/profile.types.js';
import { runOrReportNoAdapter } from './no-adapter-guard.utils.js';
import {
  enclosingProject,
  fleetProjects,
  listRegisteredProjects,
  ProjectResolutionError,
  type ResolvedProject,
  registryLine,
  resolveProject,
} from './project.utils.js';
import type { ActionDeps } from './ui/actions.service.js';
import { App, type AppProps } from './ui/app.component.js';
import {
  fleetLines,
  goalColumn,
  originMarker,
  sessionLine,
  trailing,
} from './ui/dashboard-text.utils.js';

/**
 * One prose field of a decision record, scrubbed line by line under its label
 * so a field the session wrote across several lines stays several lines
 * (decision 68). A single line over 300 characters is still cut, which the
 * mechanical summary a merge drafts — the goal and the commit subjects joined
 * by `|` — routinely is.
 */
function printRecordField(label: string, value: string): void {
  // One print site, and the field it prints is named on it: a first line lifted
  // out into a `head` of its own would be a line the source scan cannot see.
  let prefix = label;
  for (const detail of value.split('\n')) {
    console.log(`  ${prefix}${sanitizeReason(detail)}`);
    prefix = ' '.repeat(label.length);
  }
}

/**
 * The three prose fields of a decision record, under whichever heading the
 * reader printed. The merging session wrote every one of them, so every one
 * goes through the sanitizer (decision 68) — in one place, because the two
 * readers printing the same fields two different ways is how one of them came
 * to be scrubbed and the other not.
 */
function printDecisionRecordBody(record: DecisionRecordRow): void {
  printRecordField('', record.summary);
  if (record.alternatives) printRecordField('alternatives: ', record.alternatives);
  if (record.conventions) printRecordField('conventions: ', record.conventions);
}

/**
 * One stage of a gate report on the operator's terminal, for the live report
 * `pup merge` prints and `pup review`'s copy of the stored one alike — they
 * printed the same stage two different ways, which is how one of them came to
 * be scrubbed and the other not (decision 68).
 *
 * The detail is scrubbed line by line, never whole: `plainDetail` keeps
 * newlines and 2000 characters of output on purpose, because `scope-audit`
 * prints one path per line and `worktree-clean` one file per line, and
 * `sanitizeReason` collapses whitespace and cuts at 300 characters. Scrubbed
 * in one piece, a twelve-path audit would reach the operator as six paths on
 * one line with nothing to say the rest was dropped. A single line still over
 * 300 characters is still cut, as every other scrubbed string is.
 */
function printGateStage(stage: GateStageResult): void {
  const [head = '', ...rest] = (stage.detail ?? '').split('\n');
  console.log(
    `  ${sanitizeReason(stage.stage).padEnd(16)} ${sanitizeReason(stage.status).toUpperCase()}${stage.detail ? `  ${sanitizeReason(head)}` : ''}`,
  );
  for (const detail of rest) console.log(`    ${sanitizeReason(detail)}`);
}

/**
 * One-keystroke approval of the decision record a merge just drafted. TTY
 * only — scripted/CI merges keep the draft untouched, same as before this
 * existed, so nothing interactive ever blocks automation.
 */
function reviewDecisionRecord(db: Database, recordId: number): void {
  const record = getDecisionRecord(db, recordId);
  if (!record || !process.stdin.isTTY) return;
  console.log(`\nDecision record #${record.id}:`);
  printDecisionRecordBody(record);
  process.stdout.write('[Enter/k] keep   [e] edit summary   [d] discard > ');
  const key = readKeystroke();
  console.log('');
  if (key === 'd') {
    deleteDecisionRecord(db, record.id);
    console.log(`Discarded decision record #${record.id}.`);
    return;
  }
  if (key === 'e') {
    const draft = join(mkdtempSync(join(tmpdir(), 'pup-record-')), 'summary.txt');
    writeFileSync(draft, `${record.summary}\n`);
    const editor = process.env.EDITOR ?? 'vi';
    const edit = spawnSync(editor, [draft], { stdio: 'inherit' });
    const edited = readFileSync(draft, 'utf8').trim();
    if (edit.status === 0 && edited) {
      updateDecisionRecordSummary(db, record.id, edited);
      console.log(`Updated decision record #${record.id}.`);
    } else {
      console.log('Edit aborted; keeping the draft.');
    }
    return;
  }
  console.log(`Kept decision record #${record.id}.`);
}

/** Read one raw keypress from the tty; Ctrl-C aborts like it would anywhere. */
function readKeystroke(): string {
  process.stdin.setRawMode?.(true);
  const buf = Buffer.alloc(8);
  let n = 0;
  try {
    // Node keeps the tty non-blocking, so a bare readSync throws EAGAIN until
    // a key arrives — poll instead of erroring out of the merge.
    for (;;) {
      try {
        n = readSync(0, buf, 0, 8, null);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  } finally {
    process.stdin.setRawMode?.(false);
  }
  const key = buf.subarray(0, n).toString('utf8');
  if (key === '\u0003') process.exit(130);
  return key.toLowerCase();
}

function printInitReport(db: Database, report: InitReport, repoPath: string): void {
  console.log(`Project ${report.projectId} (${sanitizeReason(repoPath)})`);
  console.log(`adapters: ${sanitizeReason(report.baseline.adapters.join(', '))}`);
  for (const s of report.baseline.stages) {
    console.log(
      `  ${sanitizeReason(s.stage).padEnd(8)} ${sanitizeReason(s.status).toUpperCase().padEnd(8)} ${s.durationMs}ms`,
    );
    if (s.status === 'fail' && s.detail)
      console.log(`    ${sanitizeReason(s.detail.split('\n').at(-1) ?? '')}`);
  }
  printBaselineTail(db, report, repoPath);
}

/**
 * What `pup init` and `pup audit` both end on: the debt baseline, with the
 * audit's per-metric moves under it, then the sandbox, codegraph and push
 * target lines and the findings. The audit prints the same findings, so a
 * stage that cannot measure says why on the repeat path too, or that is where
 * the gap goes quiet (decision 29).
 */
function printBaselineTail(
  db: Database,
  report: InitReport,
  repoPath: string,
  debtTransitions: readonly string[] = [],
): void {
  console.log(`debt baseline: ${describeDebtBaseline(report.baseline.debt)}`);
  for (const t of debtTransitions) console.log(`  ${t}`);
  console.log(`sandbox: ${sanitizeReason(report.sandbox)}`);
  printCodegraphLine(repoPath);
  printPushTargetLine(db, report.projectId);
  if (report.findings.length > 0) {
    console.log('findings:');
    for (const finding of report.findings) console.log(`  - ${sanitizeReason(finding)}`);
  }
}

/**
 * Beside the sandbox line, and for the same reason (decision 36): an operator
 * who never sees it cannot tell a fleet whose sessions get a code graph from one
 * whose sessions grep. Probed here rather than carried in the report, because
 * what it reports is the operator's machine and not the baseline the stages
 * measured (decision 51).
 */
function printCodegraphLine(repoPath: string): void {
  console.log(`codegraph: ${codegraphLabel(repoPath)}`);
}

/**
 * Beside the sandbox line for the third time (decisions 36, 51): the recorded
 * push target is the value `pup merge --pr` refuses to differ from, so the
 * operator has to be able to see what they are being held to — and, on a
 * project set up before it was recorded, that they are being held to nothing
 * yet. Read from the row rather than carried in the report, because the row is
 * what the gate reads (decision 56).
 */
function printPushTargetLine(db: Database, id: string): void {
  const recorded = getProject(db, id)?.origin_url;
  // Sanitized on the way out as well as on the way in: a row written before
  // `recordOriginUrl` refused control characters would otherwise repaint the
  // lines above it on the way past (decisions 29, 56).
  console.log(
    `push target: ${recorded ? sanitizeReason(recorded) : 'not recorded — `pup merge --pr` refuses until `pup init` records one'}`,
  );
}

/**
 * The record is written before the stages run, so that a capture dying in one —
 * a broken toolchain, decision 55 — still leaves it made; this keeps the line
 * that reports it from dying with the capture, where a first record would land
 * with no output at all.
 */
function withPushTargetLine<TResult>(db: Database, repoPath: string, run: () => TResult): TResult {
  try {
    return run();
  } catch (error) {
    printPushTargetLine(db, projectId(repoPath));
    throw error;
  }
}

/** The gate flags only increases over these numbers, so the human should see the bar. */
function describeDebtBaseline(debt: DebtBaseline | undefined): string {
  if (!debt) return 'not measured — the debt-delta gate stages will be skipped';
  const parts = [
    debt.deadExports ? `${debt.deadExports.length} unused exports` : 'dead code not measured',
    debt.duplicatedLines !== undefined
      ? `${debt.duplicatedLines} duplicated lines`
      : 'duplication not measured',
    debt.coverageRatio !== undefined
      ? `coverage ${Math.round(debt.coverageRatio * 1000) / 10}%`
      : 'coverage not measured',
  ];
  return parts.join(', ');
}

/**
 * Session lookup for commands that drive a live tmux pane (`steer`,
 * `interrupt`). Terminal sessions are refused, not just missing ones: their
 * pane is long gone, and a dead name is exactly what tmux would have
 * prefix-matched onto a live sibling before targets were pinned. Prints the
 * refusal and sets the exit code; callers just bail on undefined.
 */
function resolveLiveSession(db: Database, session: string, verb: string): SessionRow | undefined {
  const row = getSession(db, session);
  if (!row) {
    refuse(`No session ${session}.`);
    return undefined;
  }
  if (isTerminal(row.state)) {
    refuse(`Session ${session} is ${row.state}; nothing to ${verb}.`);
    return undefined;
  }
  return row;
}

/**
 * Shared by `merge`, `init` and `audit`: the three commands that run children a
 * session wrote. A flag rather than the `PUP_GATE_ENV` variable it replaces —
 * direnv, a CI job or a shell wrapper supplies a variable without anyone
 * editing the command, and widening a gate child's environment should take
 * rewriting what the operator typed (decision 36).
 */
const GATE_ENV_DESCRIPTION =
  'extra env var names to pass through to gate children, comma-separated';

const ALLOW_OVERLAP_DESCRIPTION =
  'launch even though a live session already holds files in this scope';

/**
 * The only way to move a recorded push target, and it exists because origin
 * does legitimately move — a repo renamed, a fork promoted. Operator-only, and
 * a flag rather than a silent refresh on every `pup init`, so that re-aiming
 * where sessions' work is pushed takes someone typing it (decision 56).
 */
const ORIGIN_MOVED_DESCRIPTION =
  "re-record origin's URL as this project's push target, after origin legitimately moved";

/**
 * Undo a launch whose kickoff was refused, in the order both refused launches
 * need: the refusal first — an `undo` that throws must not hide why the launch
 * failed — then the window, then the line naming the rollback and the retry.
 * `undo` and that line are the callers' own: a session's launch kills a
 * session, the conductor's kills a window, and each says so in its own words.
 */
function rollBackRefusedLaunch(error: RefusedSteer, undo: () => void, rolledBack: string): void {
  console.error(error.message);
  undo();
  console.error(rolledBack);
  process.exitCode = 1;
}

/**
 * The two ways a steer, a kickoff included, is refused with nothing typed: the
 * paste never landed whole (decision 45), or the pane recorded at launch is
 * not there to type into (decision 46) — for a launch, a window that died
 * before its context arrived.
 */
type RefusedSteer = SteerNotDeliveredError | SessionPaneMissingError;

function isRefusedSteer(error: unknown): error is RefusedSteer {
  return error instanceof SteerNotDeliveredError || error instanceof SessionPaneMissingError;
}

/**
 * Refuse the command the caller may not run, or the one it asked for that
 * cannot be done: the reason on stderr and a failing exit code, never a throw.
 * Every guard below reads `return refuse(…)`, so a refusal is one line and
 * cannot silently forget the exit code that makes it a refusal.
 */
function refuse(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

/** An error class a launch answers for rather than crashes on. */
type ExpectedLaunchError = new (...args: never[]) => Error;

/**
 * The tail every command that opens a session shares. A kickoff the session
 * refused is rolled back: the launch has already claimed its task, inserted
 * its row as `running` and opened its window — `startSession` throws after all
 * three — so left as is the task reads as claimed (a re-launch raises
 * TaskAlreadyClaimedError) and the window sits empty. Killing the session
 * undoes it: the window goes, the row is `killed`, and the task returns to the
 * backlog (decision 40), where it now sits — so the retry is always
 * `pup launch <task>`, for a sweep too: `createSession` had already planned the
 * sweep task, and a `--sweep` re-run would mint a second one beside the orphan.
 * An error the caller could not have avoided — the scope it collides with, a
 * task already claimed — is printed as a refusal; anything else is a bug and
 * is rethrown, so widening one caller's `expected` never widens another's.
 * Returns the session id, or undefined once a refusal has been printed.
 */
function launchOrRefuse(
  db: Database,
  taskId: string,
  expected: readonly ExpectedLaunchError[],
  start: () => string,
): string | undefined {
  try {
    return start();
  } catch (error) {
    if (isRefusedSteer(error)) {
      const { sessionId } = error;
      rollBackRefusedLaunch(
        error,
        () => killSession(db, sessionId),
        `Launch rolled back (session ${sessionId} killed). Re-run \`pup launch ${taskId}\`.`,
      );
      return undefined;
    }
    if (!expected.some((type) => error instanceof type)) throw error;
    refuse((error as Error).message);
    return undefined;
  }
}

/** How every launch reports the window it opened. */
function reportLaunched(sessionId: string, what = 'session'): void {
  // Sanitized on each interpolation rather than once into a local: a local is
  // a name the source scan can no longer see the field through (decision 68).
  console.log(
    `Launched ${what} ${sanitizeReason(sessionId)} (tmux: pup-${sanitizeReason(sessionId)}).`,
  );
  console.log(`Attach with: tmux attach -t pup-${sanitizeReason(sessionId)}`);
}

/**
 * Builds the commander program without parsing argv — the executable entry
 * point below is the only caller that actually parses; tests build a fresh
 * program and drive command actions in-process instead. exitOverride keeps
 * commander's own error/help/version paths from calling process.exit
 * directly, so both the entry point and tests observe them as thrown
 * CommanderErrors.
 */
/**
 * The session running this command, if any — worktree first, then the env var
 * it declares. Any non-empty declaration counts: it once had to name a session
 * that exists so it could not write garbage into the ledger's acceptor, but the
 * acceptor is the constant `human` now, and a variable naming no session is a
 * session that changed it, not an operator (decision 44). Best effort against
 * a determined session, which can `cd` out of its worktree and unset the
 * variable; it makes the audit trail honest, not tamper-proof (decisions 26, 27).
 */
function callingSession(db: Database): string | undefined {
  const declared = process.env.PUP_SESSION_ID;
  return findSessionByWorktree(db, process.cwd())?.id ?? (declared || undefined);
}

/**
 * The conductor running this command, if any: the project id its launch
 * exported as `PUP_CONDUCTOR`. The conductor is the operator's delegate for
 * planning, launching, steering and killing, and is refused the merge, the
 * respawn and other projects; what it plans is recorded as its own. The
 * variable is its word, at decision 27's ceiling, like a session's (decision 47).
 */
function callingConductor(): string | undefined {
  return process.env.PUP_CONDUCTOR || undefined;
}

/**
 * What a plan, launch or `pup new` records about who asked for it. A task the
 * conductor authors is a later session's kickoff prompt, so its origin says
 * so rather than wearing the operator's `human` (decision 40's rule); an
 * overlap it waves through is answered for by it. Empty for the operator, so
 * the defaults stand.
 */
function conductorAttribution(): { origin?: 'conductor'; overlapVia?: 'conductor' } {
  return callingConductor() ? { origin: 'conductor', overlapVia: 'conductor' } : {};
}

/**
 * The session a `pup session …` command reports for: the one `PUP_SESSION_ID`
 * declares, and only when cwd is inside that session's own worktree. The
 * variable is the session's word; the worktree is decision 26's detection
 * turned on the protocol itself. Requiring the match, not merely the absence
 * of a contradiction, is what closes the plain path: a session that exports a
 * victim's id and `cd`s to the repo root is inside no worktree, and would
 * otherwise pass on the variable alone (decision 44). Only sessions run these
 * commands, and the protocol launches them with cwd in the worktree, so no
 * legitimate caller is refused. Prints the refusal and returns undefined.
 */
function ownSession(db: Database, command: string): string | undefined {
  const declared = process.env.PUP_SESSION_ID;
  if (!declared) {
    refuse(`pup session ${command} must run inside a Pupitre session (PUP_SESSION_ID unset).`);
    return undefined;
  }
  if (!getSession(db, declared)) {
    // The one message here that prints a value the store did not validate; a
    // session sets the variable, so it reaches the terminal by decision 29's rule.
    refuse(
      `pup session ${command}: PUP_SESSION_ID names no session (${sanitizeReason(declared)}).`,
    );
    return undefined;
  }
  const enclosing = findSessionByWorktree(db, process.cwd());
  if (enclosing?.id !== declared) {
    const where = enclosing
      ? `this worktree belongs to ${enclosing.id}, not ${declared}`
      : `this directory is not inside ${declared}'s worktree`;
    refuse(`\`pup session ${command}\` reports only its own session; ${where}.`);
    return undefined;
  }
  return declared;
}

function operatorOnlyProject(): ProjectResolutionError {
  return new ProjectResolutionError(
    'Reaching another project is operator-only; a session controls only the project it runs in.',
  );
}

interface PlanOptions {
  scope?: string[];
  scopeOut?: string[];
  accept?: string[];
  goal?: string;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('pup')
    .description('Control plane for parallel Claude Code sessions')
    .version('0.1.0')
    .option('--project <id>', 'control a registered project by id, from anywhere');
  program.exitOverride().configureOutput({
    writeOut: (str) => process.stdout.write(str),
    writeErr: (str) => process.stderr.write(str),
  });
  /**
   * The one resolver every command shares, so `--project` needs no
   * per-command branch. The repo around cwd is the only project a session
   * may reach; `--project` and the store's auto-select outside any repo both
   * hand a command another project's store, where every operator-only guard
   * asks `callingSession` and a session is unknown — so both are refused for
   * a session here, by the variable first and by its own store's rows second
   * (decision 43).
   */
  const project = (): ResolvedProject => {
    const selected = program.opts().project as string | undefined;
    const own = enclosingProject(process.cwd());
    if (own && selected === undefined) return own;
    refuseUnlessOperator(own);
    return resolveProject(process.cwd(), selected);
  };

  /**
   * Every door to a store other than the caller's own — `--project`, the
   * auto-select, and the fleet view (decision 60) — is the operator's. Closes
   * the caller's own store, which it only reads to ask this.
   */
  const refuseUnlessOperator = (own: ResolvedProject | undefined): void => {
    try {
      // The variable alone refuses: a session that cd's outside every repo
      // has no own store to be found in, and decision 42's ceiling needed it
      // to also unset the variable — this keeps it so.
      if (process.env.PUP_SESSION_ID || callingConductor()) throw operatorOnlyProject();
      if (own && callingSession(own.db)) throw operatorOnlyProject();
    } finally {
      own?.db.close();
    }
  };

  program
    .command('init')
    .description('Onboard a repo: detect stack, baseline, conventions')
    .option('--gate-env <names>', GATE_ENV_DESCRIPTION)
    .option('--origin-moved', ORIGIN_MOVED_DESCRIPTION)
    .action((opts: { gateEnv?: string; originMoved?: boolean }) => {
      const { repoPath, db } = project();
      // `pup init` stamps the debt baseline through the same `initProject` the
      // audit does, and records the push target the gate holds a session's
      // `--pr` merge to — so a session running it would choose the moment its
      // own bar moves, and where its own work is pushed (decisions 48, 56, 64).
      // Refused before anything measures; `--origin-moved` needs no refusal of
      // its own.
      if (callingSession(db)) {
        return refuse('`pup init` is operator-only; sessions cannot move the baseline.');
      }
      const recording = opts.originMoved ? 're-record' : 'record';
      const report = withPushTargetLine(db, repoPath, () =>
        runOrReportNoAdapter(() =>
          initProject(
            db,
            repoPath,
            detectAdapters(repoPath),
            parseGateEnv(opts.gateEnv),
            recording,
          ),
        ),
      );
      if (!report) return;
      printInitReport(db, report, repoPath);
      console.log(
        'Baseline stored. Review the resolved commands above (package.json scripts win), then launch sessions with `pup new`.',
      );
    });

  program
    .command('new <goal>')
    .description('Compile a profile, create a worktree, and launch a session')
    .requiredOption('--scope <glob...>', 'scope-in globs the session may edit')
    .option('--scope-out <glob...>', 'globs the session must not edit')
    .option('--accept <criterion...>', 'acceptance criteria')
    .option('--model <model>', 'claude model for the session')
    .option('--allow-overlap', ALLOW_OVERLAP_DESCRIPTION)
    .action((goal: string, opts: Record<string, string[] | string | boolean | undefined>) => {
      const { repoPath, db } = project();
      // `pup new` is `pup plan add` plus a launch, so it carries the same rule:
      // a session authoring a spec writes a later session's kickoff prompt and
      // the hook allowlist the gate audits against, and would also mint itself a
      // fresh session past decision 7's reject cap (decisions 26, 40).
      if (callingSession(db)) {
        return refuse('`pup new` is operator-only; sessions cannot author task specs.');
      }
      const task: TaskSpec = {
        id: `t-${Date.now().toString(36)}` as TaskId,
        goal,
        scopeIn: opts.scope as string[],
        scopeOut: opts.scopeOut as string[] | undefined,
        acceptance: (opts.accept as string[] | undefined) ?? ['goal met and committed'],
      };
      // `InvalidProfileError` too: the compile validates the spec AND reads the
      // project brief, so an oversized brief must refuse in one line here
      // rather than crash out of a launch (decision 57).
      const sessionId = launchOrRefuse(db, task.id, [ScopeConflictError, InvalidProfileError], () =>
        createSession(db, {
          repoPath,
          base: DEFAULT_BASE_PROFILE,
          task,
          claudeUserDir: join(homedir(), '.claude'),
          model: opts.model as string | undefined,
          allowOverlap: opts.allowOverlap === true,
          ...conductorAttribution(),
        }),
      );
      if (sessionId === undefined) return;
      reportLaunched(sessionId);
    });

  program
    .command('plan [action] [target]')
    .description('Backlog of tasks with no session yet (list|add|drop|edit)')
    .option('--scope <glob...>', 'scope-in globs the task may edit')
    .option('--scope-out <glob...>', 'globs the task must not edit')
    .option('--accept <criterion...>', 'acceptance criteria')
    .option('--goal <goal>', 'replacement goal (edit)')
    .action((action: string | undefined, target: string | undefined, opts: PlanOptions) => {
      const { repoPath, db } = project();
      const verb = action ?? 'list';
      // Writing a spec is operator-only: `goal` becomes a later session's
      // kickoff prompt verbatim and `scopeIn` becomes the hook allowlist the
      // gate audits against, so a session authoring one is prompt injection
      // with the operator's attribution on it (decision 26's rule, decision 40).
      if (verb !== 'list' && callingSession(db)) {
        return refuse(`\`pup plan ${verb}\` is operator-only; sessions cannot author task specs.`);
      }
      switch (verb) {
        case 'list': {
          const backlog = listBacklogTasks(db, projectId(repoPath));
          if (backlog.length === 0) {
            console.log('Backlog empty. Add one with `pup plan add "<goal>" --scope <glob>`.');
            return;
          }
          for (const row of backlog) {
            const spec = JSON.parse(row.spec) as TaskSpec;
            const scope = sanitizeReason((spec.scopeIn ?? []).join(' '));
            console.log(
              `${sanitizeReason(row.id).padEnd(14)}${goalColumn(goalHeadline(spec.goal))}  ${scope}${originMarker(row.origin)}`,
            );
          }
          return;
        }
        case 'add': {
          if (!target || !opts.scope) {
            return refuse('Usage: pup plan add "<goal>" --scope <glob...>');
          }
          let id: string;
          try {
            id = planTask(db, {
              repoPath,
              task: {
                id: `t-${Date.now().toString(36)}` as TaskId,
                goal: target,
                scopeIn: opts.scope,
                scopeOut: opts.scopeOut,
                acceptance: opts.accept ?? ['goal met and committed'],
              },
              origin: conductorAttribution().origin,
            });
          } catch (error) {
            if (!(error instanceof InvalidProfileError)) throw error;
            return refuse(error.message);
          }
          console.log(
            `Planned ${sanitizeReason(id)}. Launch it with \`pup launch ${sanitizeReason(id)}\`.`,
          );
          return;
        }
        case 'drop': {
          if (!target) {
            return refuse('Usage: pup plan drop <task>');
          }
          if (!deleteTask(db, target)) {
            return refuse(`No planned task ${target} (a session may already have claimed it).`);
          }
          console.log(`Dropped ${target}.`);
          return;
        }
        case 'edit': {
          if (!target) {
            return refuse('Usage: pup plan edit <task> [--goal ...] [--scope ...]');
          }
          const row = getTask(db, target);
          if (!row) {
            return refuse(`No task ${target}.`);
          }
          const spec = JSON.parse(row.spec) as TaskSpec;
          const edited: TaskSpec = {
            ...spec,
            goal: opts.goal ?? spec.goal,
            scopeIn: opts.scope ?? spec.scopeIn ?? [],
            scopeOut: opts.scopeOut ?? spec.scopeOut,
            acceptance: opts.accept ?? spec.acceptance,
          };
          // The only `UPDATE tasks SET spec` there is, so it runs exactly the
          // validation `plan add` runs — otherwise edit could store a spec add
          // would have refused, and the failure would surface at launch.
          try {
            assertPlannableSpec(edited);
          } catch (error) {
            if (!(error instanceof InvalidProfileError)) throw error;
            return refuse(error.message);
          }
          if (!updateTaskSpec(db, target, JSON.stringify(edited))) {
            return refuse(`Task ${target} is already claimed by a session; its spec is frozen.`);
          }
          console.log(`Updated ${target}.`);
          return;
        }
        default:
          refuse(`Unknown plan action \`${action}\` (expected list|add|drop|edit).`);
      }
    });

  program
    .command('launch <task>')
    .description('Start a session for a task already in the backlog')
    .option('--model <model>', 'claude model for the session')
    .option('--allow-overlap', ALLOW_OVERLAP_DESCRIPTION)
    .action((taskId: string, opts: { model?: string; allowOverlap?: boolean }) => {
      const { repoPath, db } = project();
      // Admitting work belongs to whoever answers for the collision it may
      // cause. Guarding only `--allow-overlap` left the command itself open, so
      // a session could kill the holder of a scope and launch a conflicting
      // task plainly — the same rule and detection that keep `--pr` and spec
      // authoring operator-only (decisions 26, 42).
      if (callingSession(db)) {
        return refuse('`pup launch` is operator-only; sessions cannot launch sessions.');
      }
      const planned = getTask(db, taskId);
      if (planned) {
        const spec = JSON.parse(planned.spec) as TaskSpec;
        console.log(`goal: ${sanitizeReason(spec.goal ?? '')}`);
        console.log(`scope-in: ${sanitizeReason((spec.scopeIn ?? []).join(', '))}`);
      }
      const sessionId = launchOrRefuse(
        db,
        taskId,
        [UnknownTaskError, TaskAlreadyClaimedError, ScopeConflictError, InvalidProfileError],
        () =>
          launchTask(db, {
            repoPath,
            base: DEFAULT_BASE_PROFILE,
            taskId,
            claudeUserDir: join(homedir(), '.claude'),
            model: opts.model,
            allowOverlap: opts.allowOverlap,
            overlapVia: conductorAttribution().overlapVia,
          }),
      );
      if (sessionId === undefined) return;
      reportLaunched(sessionId);
    });

  program
    .command('conductor [action]')
    .description(
      'Start a Claude session that plans, launches, steers and reports on sessions (start|stop)',
    )
    .option('--model <model>', 'claude model for the conductor itself')
    .option('--worker-model <model>', 'claude model the conductor launches sessions on')
    .action((action: string | undefined, opts: { model?: string; workerModel?: string }) => {
      const { repoPath, db } = project();
      const verb = action ?? 'start';
      // The conductor holds every operator power but the merge, so only the
      // operator starts one — a session or a conductor minting a conductor
      // would be a session launching sessions under another name (decision 47).
      if (callingSession(db) || callingConductor()) {
        return refuse(`\`pup conductor ${verb}\` is operator-only.`);
      }
      if (verb === 'stop') {
        stopConductor(repoPath);
        console.log('Conductor stopped.');
        return;
      }
      if (verb !== 'start') {
        return refuse(`Unknown conductor action \`${action}\` (expected start|stop).`);
      }
      let handle: ConductorHandle;
      try {
        handle = startConductor({
          repoPath,
          base: DEFAULT_BASE_PROFILE,
          claudeUserDir: join(homedir(), '.claude'),
          model: opts.model,
          workerModel: opts.workerModel,
        });
      } catch (error) {
        if (!isRefusedSteer(error)) throw error;
        // Rolled back like a session launch whose kickoff never landed, so
        // nothing runs on an empty prompt; the window is the conductor's
        // whole footprint, so killing it is the whole rollback.
        rollBackRefusedLaunch(
          error,
          () => stopConductor(repoPath),
          'Conductor launch rolled back (window killed). Re-run `pup conductor`.',
        );
        return;
      }
      // A window with no context is a bypass-permissions agent in the main
      // checkout that has read none of its tier; killed, not left to inspect.
      if (!handle.delivered) {
        stopConductor(repoPath);
        return refuse(
          `Conductor window ${handle.name} never became ready, so its context was not ` +
            'delivered and the window was killed. Re-run `pup conductor`.',
        );
      }
      // Scrubbed like every other named field a print interpolates, rather
      // than allowlisted as another derivation of the repo path: `handle.name`
      // is a local, and chasing its provenance per line is the carve-out
      // decision 68 dropped. The call is idempotent on the composed name.
      console.log(`Conductor running (tmux: ${sanitizeReason(handle.name)}).`);
      // Its own socket, so the attach names it: a plain `tmux attach` asks the
      // default server, which the conductor's window is deliberately not on
      // (decision 47).
      console.log(
        `Attach with: tmux -L ${conductorSocket(projectId(repoPath))} attach -t ${sanitizeReason(handle.name)}`,
      );
      // The radar is the turn watchdog's host, and the conductor is the thing
      // the watchdog exists to keep going: its own waiting turn dies with the
      // worker's, and then nobody resumes either (addendum to decision 35). So
      // a conductor without a radar is started with one, and told so — the
      // operator asked for a fleet that runs itself, not for two commands.
      // Whether one is up is the store's word, not a window name a session
      // could mint: a radar that sweeps records its beat every sweep, and
      // `launchWatcher` replaces whatever stale window wears the name.
      const beat = getWatcherBeat(db, projectId(repoPath));
      if (beat === undefined || Date.now() - beat.getTime() > WATCH_STALE_AFTER_MS) {
        const { target } = launchWatcher(projectId(repoPath), repoPath);
        console.log(
          `Conflict radar started with it (tmux: ${target}) — it runs the turn watchdog.`,
        );
      }
    });

  program
    .command('brief [action]')
    .description(
      'Read or edit the project brief carried into the conductor and every session (show|edit)',
    )
    .action((action: string | undefined) => {
      const { repoPath, db } = project();
      const verb = action ?? 'show';
      // The brief is the operator's direction to the whole fleet, and the
      // conductor and every session read it as theirs. A session that could
      // write it would be rewriting its own kickoff and the next session's; a
      // conductor that could would be promoting its plan to the operator's
      // direction. Both are refused, on `show` as well as `edit`: the
      // Priorities half is the conductor's to act on, not a session's to read
      // (decision 57).
      if (callingSession(db) || callingConductor()) {
        return refuse(`\`pup brief ${verb}\` is operator-only.`);
      }
      if (verb === 'show') {
        let brief: string | undefined;
        try {
          brief = readBrief(repoPath);
        } catch (error) {
          // The one refusal a read can raise: a brief over the cap. One line
          // naming the file, not a stack trace (decision 57).
          if (!(error instanceof InvalidProfileError)) throw error;
          return refuse(error.message);
        }
        if (!brief) {
          console.log(
            `No project brief yet. \`pup brief edit\` creates one at ${briefPath(repoPath)}.`,
          );
          return;
        }
        console.log(brief.trimEnd());
        return;
      }
      if (verb !== 'edit') {
        return refuse(`Unknown brief action \`${action}\` (expected show|edit).`);
      }
      const { path, created } = ensureBrief(repoPath);
      const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
      const edit = spawnSync(editor, [path], { stdio: 'inherit' });
      if (edit.error || edit.status !== 0) {
        // The file stays: a template just written is the start the operator
        // asked for, and an editor that failed to open is not a reason to
        // throw it away. An editor that is not installed says so — `exited on
        // a signal` would send the operator looking at the wrong thing.
        const why = edit.error
          ? `could not run: ${sanitizeReason(edit.error.message)}`
          : `exited ${edit.status ?? 'on a signal'}`;
        return refuse(`\`${editor} ${path}\` ${why}. The brief is there to edit by hand.`);
      }
      if (created) console.log(`Created ${sanitizeReason(path)} from the template.`);
      // Named, not counted: the windows listed here are running on the brief as
      // it was when they opened, and the operator is the only one who can
      // decide whether that is worth a restart (decision 57).
      // Scrubbed like every other store-read id printed here (decisions 29, 61):
      // this line names rows a session wrote, on the operator's terminal.
      const running = listSessions(db, ['running']).map((session) => sanitizeReason(session.id));
      const conductor = isConductorRunning(repoPath) ? [conductorName(projectId(repoPath))] : [];
      const already = [...conductor, ...running];
      console.log(
        already.length === 0
          ? 'Saved. It takes effect at the next launch and the next conductor start.'
          : `Saved. It takes effect at the next launch and the next conductor start; ${already.join(', ')} ${already.length === 1 ? 'is' : 'are'} already running on the brief as it was.`,
      );
    });

  program
    .command('project <action> [id]')
    .description(
      'The registered projects: list them, or put one to sleep and wake it (list|dormant|wake)',
    )
    .action((action: string, id: string | undefined) => {
      // The registry is every project's, and dormancy is what the fleet views
      // and the radar read to pass a project over: a session could hide its
      // own project from the operator, and the conductor could put the project
      // it runs to sleep. Both are refused, on `list` and on a mistyped action
      // too, as every door to another project's store is (decisions 43, 62).
      refuseUnlessOperator(enclosingProject(process.cwd()));
      if (!['list', 'dormant', 'wake'].includes(action)) {
        return refuse(
          `Unknown project action \`${sanitizeReason(action)}\` (expected list|dormant|wake).`,
        );
      }
      const selected = program.opts().project as string | undefined;
      if (action === 'list') {
        if (id !== undefined) return refuse('`pup project list` takes no id; use --project <id>.');
        const listed = listProjects(listRegisteredProjects(), selected);
        if ('refusal' in listed) return refuse(listed.refusal);
        for (const entry of listed.projects) {
          console.log(registryLine(entry.project, entry.isConductorRunning));
        }
        return;
      }
      if (id !== undefined && selected !== undefined && id !== selected) {
        return refuse(
          `\`pup project ${action}\` was given two projects (${sanitizeReason(id)} and --project ${sanitizeReason(selected)}); name one.`,
        );
      }
      const { repoPath, db } = resolveProject(process.cwd(), id ?? selected);
      try {
        const outcome =
          action === 'wake'
            ? wakeProject(db, repoPath)
            : putProjectToSleep(db, repoPath, new Date());
        if ('refusal' in outcome) refuse(outcome.refusal);
        else console.log(outcome.said);
      } finally {
        db.close();
      }
    });

  program
    .command('status')
    .description('Sessions by state, blocked and stalled first; planned work and overdue debt too')
    .option(
      '--all',
      'every registered project, what needs you in each (the default outside a repo)',
    )
    .option('--dormant', 'include dormant projects in the fleet view')
    .action((opts: { all?: boolean; dormant?: boolean }) => {
      // Outside a repo, or with `--all`, the fleet view; `--project` names one
      // project's full table and so wins over `--all` (decision 60).
      const selected = program.opts().project as string | undefined;
      const own = selected === undefined ? enclosingProject(process.cwd()) : undefined;
      if (own && !opts.all) {
        printDashboard(own.db, buildDashboardSnapshot(own.db, own.repoPath, Date.now()));
        return;
      }
      if (selected === undefined) {
        refuseUnlessOperator(own);
        printFleet(opts.dormant === true);
        return;
      }
      const { repoPath, db } = project();
      printDashboard(db, buildDashboardSnapshot(db, repoPath, Date.now()));
    });

  program
    .command('ui')
    .description('Live dashboard: the status table, backlog, debt and conflict radar, in place')
    .option('--all', 'every registered project in one table (the default outside a repo)')
    .option('--dormant', 'include dormant projects in the fleet table')
    .action((opts: { all?: boolean; dormant?: boolean }) => {
      // The bin the merge child is re-entered with — `process.argv[1]`, the
      // same path a session's environment carries as `PUP_BIN`.
      const pupBin = realpathSync(process.argv[1] ?? 'pup');
      // Resolved as `pup status` resolves it: outside a repo, or with `--all`,
      // every project; `--project` names one and wins (decisions 60, 61).
      const selected = program.opts().project as string | undefined;
      const own = selected === undefined ? enclosingProject(process.cwd()) : undefined;
      const isSingleProject = selected !== undefined || (own !== undefined && !opts.all);
      if (!isSingleProject) refuseUnlessOperator(own);
      // Piped, redirected or captured by a hook, there is no screen to hold in
      // place and no key to press, so the dashboard degrades to the one reading
      // `pup status` would have printed and exits 0 — a `pup ui` in a script is
      // a reasonable thing to have typed, not an error (decision 52).
      if (!process.stdout.isTTY) {
        if (!isSingleProject) return printFleet(opts.dormant === true);
        const { repoPath, db } = own ?? project();
        printDashboard(db, buildDashboardSnapshot(db, repoPath, Date.now()));
        return;
      }
      let props: AppProps;
      if (isSingleProject) {
        const { repoPath, db } = own ?? project();
        // The store and repo the keys write through.
        const deps: ActionDeps = { db, repoPath, pupBin };
        const readOnlyReason = uiReadOnlyReason(db);
        props = {
          read: () => ({
            projects: [{ deps, snapshot: buildDashboardSnapshot(db, repoPath, Date.now()) }],
            unreadable: [],
          }),
          showAttach: showAttachCommand(db),
          ...(readOnlyReason ? { readOnlyReason } : {}),
        };
      } else {
        // Only the operator gets here, refused above like `pup status --all`,
        // so the fleet is always driven and always shown the attach command.
        props = {
          read: fleetReading(fleetProjects(), opts.dormant === true, pupBin),
          showAttach: true,
        };
      }
      const instance = render(createElement(App, props), {
        // vim's and htop's buffer: the fleet is watched for a while and then
        // left, and the scrollback the operator was reading before is theirs
        // to get back untouched.
        alternateScreen: true,
      });
      // Ink restores the primary screen on unmount, so every way out has to
      // reach unmount. `q` and Ctrl-C already do; a SIGINT or SIGTERM sent from
      // elsewhere would otherwise leave the operator's terminal on the
      // alternate buffer with their scrollback hidden and no prompt.
      const restore = (): void => {
        instance.unmount();
      };
      process.once('SIGINT', restore);
      process.once('SIGTERM', restore);
      void instance.waitUntilExit().then(() => {
        process.off('SIGINT', restore);
        process.off('SIGTERM', restore);
      });
    });

  /** `pup status`'s fleet view, and a piped `pup ui --all`'s (decisions 60, 65). */
  function printFleet(shouldShowDormant: boolean): void {
    for (const line of fleetLines(readFleet(fleetProjects(), Date.now(), shouldShowDormant))) {
      console.log(line);
    }
  }

  /**
   * The whole of `pup status`, printed from one snapshot — and the whole of
   * `pup ui` when its stdout is not a terminal. A piped `pup ui` prints this
   * rather than refusing, so a dashboard key in a script degrades to the text
   * the operator would have read anyway; sharing the function is what keeps the
   * two from drifting into two different accounts of the same store
   * (decision 52).
   */
  function printDashboard(db: Database, snapshot: DashboardSnapshot): void {
    for (const entry of snapshot.overdueDebt) {
      console.log(
        `OVERDUE DEBT #${entry.id}  ${sanitizeReason(entry.description)}  (review by: ${sanitizeReason(entry.reviewBy)})`,
      );
    }
    if (snapshot.conductor.running) {
      // The attach line is for the operator, who is the only caller that
      // attaches: a session and the conductor are told the conductor is up
      // and nothing more, so pup is not the thing that hands a session the
      // socket its window lives on (decision 47).
      console.log(
        showAttachCommand(db)
          ? `conductor running (attach: ${snapshot.conductor.attachCommand})`
          : 'conductor running',
      );
    }
    if (snapshot.sessions.length === 0 && snapshot.backlog.length === 0) {
      console.log('Nothing running and nothing planned.');
      return;
    }
    for (const session of snapshot.sessions) console.log(sessionLine(session));
    // Planned tasks share the session table's columns under `planned`, the
    // state docs/01 gives a task with no session row: what will be built
    // belongs beside what is being built, not in a separate command
    // (decision 41).
    for (const task of snapshot.backlog) {
      console.log(
        `${'planned'.padEnd(16)} ${sanitizeReason(task.id).padEnd(28)} ${goalColumn(goalHeadline(task.goal))}${trailing(originMarker(task.origin))}`,
      );
    }
    printConflictRadar(snapshot);
  }

  /**
   * Why this caller gets the dashboard without its controls, or nothing at all
   * for the operator. Every key `pup ui` binds runs a command that is
   * operator-only somewhere — the merge, the respawn and the unblock are
   * refused to the conductor as well as to sessions, and the launch, the kill
   * and the steer are refused to sessions (decisions 42, 44, 47). A screen
   * that offered them and refused each keystroke one at a time would be a menu
   * of things that do not work, so the whole set goes and the reason is on
   * screen instead. The keys that only look — the cursor, `r`, `q` — stay.
   */
  function uiReadOnlyReason(db: Database): string | undefined {
    if (callingSession(db)) {
      return 'read-only: sessions do not drive sessions (decisions 42, 44).';
    }
    if (callingConductor()) {
      return "read-only: the conductor drives sessions with `pup` commands, and the merge, respawn and unblock are the operator's (decision 47).";
    }
    return undefined;
  }

  /**
   * Whether this caller may be shown the socket the conductor's window lives
   * on. The operator attaches; a session and the conductor itself are told it
   * is up and nothing more (decision 47). Asked once here so `pup status` and
   * `pup ui` cannot answer it differently.
   */
  function showAttachCommand(db: Database): boolean {
    return !(callingSession(db) || callingConductor());
  }

  /** The watcher's radar: same-file overlaps between live sessions (docs/08 v1.2). */
  function printConflictRadar(snapshot: DashboardSnapshot): void {
    const live = snapshot.sessions.filter(
      (s) => s.state === 'running' || s.state === 'awaiting-review',
    );
    for (const pair of snapshot.overlaps) {
      const extra = pair.files.length > 1 ? ` (+${pair.files.length - 1} more)` : '';
      console.log(
        `OVERLAP  ${sanitizeReason(pair.sessionA)} <-> ${sanitizeReason(pair.sessionB)}  ${sanitizeReason(pair.files[0] ?? '')}${extra}${snapshot.radarStale ? '  (stale)' : ''}`,
      );
    }
    if (live.length >= 2 && snapshot.radarStale) {
      console.log('conflict radar off — start it with `pup watch --start`');
    }
  }

  program
    .command('watch')
    .description('Conflict radar: scan live session diffs for same-file overlaps')
    .option('--once', 'run a single scan, print it, and exit')
    .option('--start', 'run the radar in a detached tmux session')
    .option('--stop', 'stop the detached radar')
    .option('--interval <seconds>', 'seconds between scans', String(WATCH_INTERVAL_MS / 1000))
    .action((opts: { once?: boolean; start?: boolean; stop?: boolean; interval: string }) => {
      const { repoPath, db } = project();
      const pid = projectId(repoPath);
      // The sweep types into panes and records resumes in the watcher's name,
      // so a session or the conductor running it could forge a resume against
      // another session. The detached radar passes: `launchWatcher` runs it
      // from the main checkout, and `tmuxEnv` strips both variables.
      if (callingSession(db) || callingConductor()) {
        return refuse('`pup watch` is operator-only; the radar resumes sessions.');
      }
      if (opts.stop) {
        killWatcher(pid);
        console.log('Conflict radar stopped.');
        return;
      }
      if (opts.start) {
        const { target } = launchWatcher(pid, repoPath);
        console.log(`Conflict radar running (tmux: ${target}). Watch it: tmux attach -t ${target}`);
        return;
      }
      const intervalMs = Math.max(1, Number(opts.interval)) * 1000;
      let previous = '';
      for (;;) {
        const pairs = scanOverlaps(db, repoPath);
        // The turn watchdog rides the same sweep (addendum to decision 35).
        // Printed outside the dedup below: a resume happens once, and the
        // STALLED line that follows it on this sweep is still true — the
        // events file only moves when the resumed session fires its next hook.
        // A sweep that throws — tmux failing some new way, a locked store —
        // is reported and the loop goes on: the overlap scan above has
        // already recorded this sweep's beat, so a death here would be a
        // radar `pup status` reads as running while nothing sweeps.
        try {
          for (const turn of sweepDeadTurns(db, repoPath, Date.now())) {
            const outcome = turn.refusal ? `resume REFUSED (${turn.refusal})` : 'resumed';
            console.log(
              `${new Date().toISOString()}  TURN DIED  ${sanitizeReason(turn.id)}  ${outcome}  ${sanitizeReason(turn.reason)}`,
            );
          }
        } catch (error) {
          console.error(
            `${new Date().toISOString()}  watchdog sweep failed  ${failureSummary(error)}`,
          );
        }
        const stalled = findStalledSessions(db, repoPath, Date.now());
        // ageMs ticks up every sweep, so it's excluded from the dedup key —
        // only a session newly going stalled (or un-stalling) is a change.
        const snapshot = JSON.stringify({
          pairs,
          stalledIds: stalled.map((s) => s.id).sort(),
        });
        if (snapshot !== previous) {
          const stamp = new Date().toISOString();
          if (pairs.length === 0 && stalled.length === 0) {
            console.log(`${stamp}  clear — no overlaps`);
          }
          for (const pair of pairs) {
            console.log(
              `${stamp}  OVERLAP  ${sanitizeReason(pair.sessionA)} <-> ${sanitizeReason(pair.sessionB)}  ${sanitizeReason(pair.files.join(', '))}`,
            );
          }
          for (const s of stalled) {
            console.log(`${stamp}  STALLED  ${sanitizeReason(s.id)}  ${formatStaleAge(s.ageMs)}`);
          }
          previous = snapshot;
        }
        if (opts.once) return;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
      }
    });

  program
    .command('steer <session> <message>')
    .description('Inject a correction into a running session')
    .option('--sent', 'record a steer already delivered by cross-session message; type nothing')
    .action((session: string, message: string, opts: { sent?: boolean }) => {
      const { db } = project();
      if (!resolveLiveSession(db, session, 'steer')) return;
      // A message sent over the peer socket lands whole and never touches the
      // input box, so it needs no typing — but it needs the record, or the
      // report and last-steer queries would show a session corrected by
      // nobody. The event names the sender, and a session pup can identify is
      // named as one before its word is taken (decisions 44, 47).
      if (opts.sent) {
        const sender = callingSession(db);
        appendEvent(db, session, 'steer', {
          kind: 'message',
          by: sender ? `session:${sender}` : callingConductor() ? 'conductor' : 'operator',
        });
        console.log(`Recorded a message steer to session ${session}.`);
        return;
      }
      try {
        steerSession(db, session, message);
      } catch (error) {
        if (!isRefusedSteer(error)) throw error;
        return refuse(error.message);
      }
      appendEvent(db, session, 'steer', { kind: 'manual' });
      console.log(`Steered session ${session}.`);
    });

  program
    .command('interrupt <session> [message]')
    .description("Abort the session's in-flight tool call (Escape), optionally steering a message")
    .action((session: string, message?: string) => {
      const { db } = project();
      if (!resolveLiveSession(db, session, 'interrupt')) return;
      try {
        interruptSession(db, session);
      } catch (error) {
        // Nothing landed, so nothing is on record.
        if (!(error instanceof SessionPaneMissingError)) throw error;
        return refuse(error.message);
      }
      try {
        if (message) steerSession(db, session, message);
      } catch (error) {
        if (!isRefusedSteer(error)) throw error;
        // Escape already landed, so the interrupt is on record; only the
        // steer is refused.
        appendEvent(db, session, 'interrupt', { steered: false });
        return refuse(error.message);
      }
      appendEvent(db, session, 'interrupt', { steered: Boolean(message) });
      // The message is a real steer — log it as one too, so last-steer queries
      // see it no matter which path delivered it.
      if (message) appendEvent(db, session, 'steer', { kind: 'interrupt' });
      console.log(
        message ? `Interrupted and steered session ${session}.` : `Interrupted session ${session}.`,
      );
    });

  program
    .command('kill <session>')
    .description(
      'Stop a session; --respawn relaunches it fresh instead (wedged-window escape hatch)',
    )
    .option('--respawn', 'kill the window but relaunch the session fresh, no handoff')
    .action((session: string, opts: { respawn?: boolean }) => {
      const { repoPath, db } = project();
      // `killed` releases the session's scope and returns its task to the
      // backlog (decision 40), so a session that could kill could clear the
      // way for any launch; `--respawn` is the same authority over another
      // session's window (decisions 26, 42).
      if (callingSession(db)) {
        return refuse('`pup kill` is operator-only; sessions cannot kill sessions.');
      }
      // The plain kill is the conductor's; the hard respawn is not. It kicks
      // the session off again on the `context.md` under the store's compiled
      // dir, a file the conductor's shell can rewrite — the same authored
      // kickoff `pup respawn` refuses it (decision 47).
      if (opts.respawn && callingConductor()) {
        return refuse(
          '`pup kill --respawn` is operator-only; the conductor kills, the operator respawns.',
        );
      }
      if (opts.respawn) {
        try {
          hardRespawnSession(db, repoPath, session);
        } catch (error) {
          return refuse((error as Error).message);
        }
        console.log(`Hard-respawned session ${session} (tmux: pup-${session}).`);
        return;
      }
      killSession(db, session);
      console.log(`Killed session ${session}.`);
    });

  program
    .command('unblock <session>')
    .description('Return a blocked session to running once a human has dealt with the block')
    .option('--reason <text>', 'what was done about it, recorded on the event')
    .action((session: string, opts: { reason?: string }) => {
      const { db } = project();
      // `blocked` is decision 7's parking brake: the gate has stopped steering
      // this session and asked for a human. A session releasing its own brake
      // would undo the parking by the very thing it was parked for, and a
      // session releasing another's is the same authority `pup kill` is
      // refused (decisions 26, 42).
      if (callingSession(db)) {
        return refuse('`pup unblock` is operator-only; sessions cannot unblock sessions.');
      }
      // Refused for the reason the merge is: deciding that a gate failure has
      // been addressed is the human's judgement, and the conductor is what the
      // failing session was working for (decision 47).
      if (callingConductor()) {
        return refuse(
          '`pup unblock` is operator-only; the conductor reports a blocked session and the operator unblocks it.',
        );
      }
      const row = getSession(db, session);
      if (!row) return refuse(`No session ${session}.`);
      // Not `canTransition`: `queued -> running` is a legal edge that this
      // command must still refuse, because there is no block to lift.
      if (row.state !== 'blocked') {
        return refuse(`Session ${session} is ${row.state}; only blocked sessions unblock.`);
      }
      // Printed before the transition and read out of the store rather than
      // taken from the operator: unblocking is a claim that the block was
      // addressed, and nobody can make that claim about a reason they were
      // never shown — decision 45's addendum left it reachable only through
      // the store, and this is the surface it asked for.
      console.log(
        `Session ${session} was blocked: ${blockedReason(db, session) ?? '(no reason recorded)'}`,
      );
      transitionSession(db, session, 'running', {
        kind: 'operator-unblock',
        ...(opts.reason ? { reason: opts.reason } : {}),
      });
      // Nothing else is reset, the reject count least of all: the cap is what
      // parked the session, and a count silently rolled back would let the
      // same failure loop through the gate forever.
      const capped =
        row.reject_count > MAX_REJECTS_BEFORE_BLOCKED
          ? ` Its ${row.reject_count} rejections are kept, so the next gate failure parks it again.`
          : '';
      console.log(`Unblocked ${session}; it is running again.${capped}`);
      console.log(`Its window is untouched — \`pup kill --respawn ${session}\` if it is gone.`);
    });

  program
    .command('respawn <session>')
    .description('Ask the session for a handoff, then relaunch it on a fresh context window')
    .option(
      '--wait <seconds>',
      'how long to wait for the handoff',
      String(HANDOFF_WAIT_DEFAULT_MS / 1000),
    )
    .action((session: string, opts: { wait: string }) => {
      const { repoPath, db } = project();
      // A respawn replaces another session's window with a kickoff that quotes
      // its handoff file — context a session could author for it (decision 44).
      if (callingSession(db)) {
        return refuse('`pup respawn` is operator-only; sessions cannot respawn sessions.');
      }
      // The conductor too: the same authored-context kickoff, from a window
      // that can write any handoff file in the store (decision 47).
      if (callingConductor()) {
        return refuse(
          '`pup respawn` is operator-only; the conductor asks the operator to respawn.',
        );
      }
      // Both the handoff request and the relaunch kickoff are steers, and
      // either can be refused as never having landed whole.
      try {
        if (!isHandoffReady(db, repoPath, session)) {
          const handoffPath = requestHandoff(db, repoPath, session);
          console.log(`Handoff requested; waiting for the session to write ${handoffPath} …`);
          if (!awaitHandoffReady(db, repoPath, session, Number(opts.wait) * 1000)) {
            return refuse(
              `Session ${session} has not signalled handoff-done yet (steers queue until its ` +
                'current turn ends). Re-run `pup respawn` to ask again and keep waiting.',
            );
          }
        }
        respawnSession(db, repoPath, session);
      } catch (error) {
        if (!isRefusedSteer(error)) throw error;
        console.error(error.message);
        // A paste that never landed is worth asking again; a pane that is not
        // there to ask needs a fresh window, and that is the hard respawn.
        return refuse(
          error instanceof SteerNotDeliveredError
            ? `Re-run \`pup respawn ${session}\`.`
            : `Relaunch it without a handoff: \`pup kill --respawn ${session}\`.`,
        );
      }
      console.log(`Respawned ${session} on a fresh context window with its handoff.`);
    });

  program
    .command('review [session]')
    .description('Risk-ordered review queue, or one branch in detail')
    .action((session?: string) => {
      const { repoPath, db } = project();
      if (!session) {
        const queue = buildReviewQueue(db, repoPath);
        if (queue.length === 0) {
          console.log('Nothing awaiting review.');
          return;
        }
        console.log('RISK   SESSION                      ±LINES  FILES  REJ  VIOL  OVERLAP  GOAL');
        for (const e of queue) {
          // The id and the goal are store text — the row is a session's own,
          // and with the conductor the goal is a string an agent chose — on
          // their way to the operator's terminal, and a goal runs to a
          // paragraph, so it is a headline here as it is everywhere a queue
          // lists one (decisions 29, 41).
          console.log(
            `${e.risk.toFixed(1).padStart(5)}  ${sanitizeReason(e.sessionId).padEnd(28)} ${String(e.changedLines).padStart(5)}  ${String(e.filesChanged).padStart(5)}  ${String(e.rejectCount).padStart(3)}  ${String(e.scopeViolations).padStart(4)}  ${String(e.overlaps).padStart(7)}  ${goalHeadline(e.goal)}`,
          );
        }
        return;
      }
      const detail = buildSessionReview(db, repoPath, session);
      // Every string on this page is read out of the store — the session row,
      // the spec the conductor may have written, the gate report the events
      // hold — so every one of them is scrubbed on the way out, as the
      // dashboard's reading of the same rows is (decisions 29, 47).
      console.log(
        `${sanitizeReason(detail.entry.sessionId)}  (${sanitizeReason(detail.state)}, risk ${detail.entry.risk})`,
      );
      console.log(
        `branch: ${sanitizeReason(detail.entry.branch)}  worktree: ${sanitizeReason(detail.worktreePath)}`,
      );
      console.log(`goal: ${sanitizeReason(detail.spec.goal)}`);
      console.log(`scope-in: ${sanitizeReason(detail.spec.scopeIn.join(', '))}`);
      if (detail.spec.scopeOut?.length)
        console.log(`scope-out: ${sanitizeReason(detail.spec.scopeOut.join(', '))}`);
      console.log(`acceptance: ${sanitizeReason(detail.spec.acceptance.join('; '))}`);
      console.log(
        `rejections: ${detail.entry.rejectCount}  scope violations: ${detail.entry.scopeViolations}  overlaps: ${detail.entry.overlaps}`,
      );
      console.log('files:');
      for (const f of detail.files) {
        const added = f.added === null ? '-' : `+${f.added}`;
        const deleted = f.deleted === null ? '-' : `-${f.deleted}`;
        console.log(`  ${added.padStart(6)} ${deleted.padStart(6)}  ${sanitizeReason(f.path)}`);
      }
      if (detail.lastGateReport) {
        console.log('last gate report:');
        for (const s of detail.lastGateReport.stages) printGateStage(s);
      }
    });
  function printGateReport(report: GateReport): void {
    for (const stage of report.stages) printGateStage(stage);
    // Printed on every run, pass or fail: an operator who never sees this line
    // cannot tell a confined gate from an unconfined one (decision 36).
    console.log(`  ${'sandbox'.padEnd(16)} ${sanitizeReason(report.sandbox)}`);
  }

  program
    .command('merge <session>')
    .description('Run the gate pipeline and merge on pass')
    .option('--accept-debt <reason>', 'merge despite a flagged shortcut, creating a ledger entry')
    .option('--review-by <condition>', 'review-by condition for the ledger entry')
    .option('--pr', 'on pass, push the branch and open a pull request instead of merging locally')
    .option('--gate-env <names>', GATE_ENV_DESCRIPTION)
    .action(
      (
        session: string,
        opts: { acceptDebt?: string; reviewBy?: string; pr?: boolean; gateEnv?: string },
      ) => {
        if (Boolean(opts.acceptDebt) !== Boolean(opts.reviewBy)) {
          return refuse('--accept-debt and --review-by must be passed together.');
        }
        const { repoPath, db } = project();
        // The gate's verdict moves another session's branch and parks it
        // `blocked` on failure, so the whole command is operator-only, not only
        // `--pr` (decisions 26, 44). Best effort against a determined session
        // (decision 27): the guard refuses the plain path and keeps the ledger's
        // acceptor honest.
        if (callingSession(db)) {
          return refuse('`pup merge` is operator-only; sessions cannot merge sessions.');
        }
        // The merge is the one act the conductor hands back: the verdict moves
        // a branch onto main, and the human is the reviewer (decision 47).
        if (callingConductor()) {
          return refuse(
            '`pup merge` is operator-only; the conductor reports a finished branch and the operator merges it.',
          );
        }
        const [adapter] = detectAdapters(repoPath);
        if (!adapter) {
          return refuse(
            'No adapter detected for this repo (supported stacks: TypeScript, Python, or a .pupitre/adapter.yml).',
          );
        }
        let outcome: MergeOutcome;
        // The gate holds a lock directory it removes in a `finally`, which a
        // process killed by a signal never reaches — and the next merge then
        // refuses against a lock nobody holds. Ctrl-C at the terminal and the
        // SIGTERM `pup ui`'s `q` sends to this child are both that case, so the
        // lock goes on the way out. Only if this run took it: a lock that was
        // already there when the command started belongs to another merge, and
        // is not this one's to remove.
        const lockPath = join(repoPath, '.git', MERGE_LOCK_DIRNAME);
        const heldOnEntry = existsSync(lockPath);
        const releaseLock = (signal: NodeJS.Signals): void => {
          if (!heldOnEntry) rmSync(lockPath, { recursive: true, force: true });
          process.exit(signal === 'SIGTERM' ? 143 : 130);
        };
        process.once('SIGINT', releaseLock);
        process.once('SIGTERM', releaseLock);
        try {
          outcome = runMergeGate(db, {
            repoPath,
            sessionId: session,
            adapter,
            acceptDebt:
              opts.acceptDebt && opts.reviewBy
                ? {
                    reason: opts.acceptDebt,
                    reviewBy: opts.reviewBy,
                    // True by the guard above: only an operator reaches this line.
                    acceptedBy: 'human',
                  }
                : undefined,
            openPr: opts.pr,
            gateEnv: parseGateEnv(opts.gateEnv),
          });
        } catch (error) {
          // Refusals here are expected outcomes with operator instructions in the
          // message (held lock, adoptable-PR checks) — a stack trace buries them.
          return refuse(error instanceof Error ? error.message : String(error));
        } finally {
          // The gate has released its own lock by now, so a later signal must
          // not reach a handler that would delete the next run's.
          process.off('SIGINT', releaseLock);
          process.off('SIGTERM', releaseLock);
        }
        printGateReport(outcome.report);
        switch (outcome.status) {
          case 'merged':
            if (outcome.prUrl) {
              console.log(
                outcome.prWasAdopted
                  ? `Gate passed; reused the open PR ${outcome.prUrl} and rewrote its description with this gate report — check it, merge it there, then run \`pup audit\`.`
                  : `Gate passed; opened ${outcome.prUrl} — merge it there, then run \`pup audit\`.`,
              );
            } else {
              console.log(`Merged ${session}; worktree and branch cleaned up.`);
            }
            for (const c of outcome.debtCandidates ?? []) {
              console.log(
                `This merge touched files of open debt #${c.id} (${sanitizeReason(c.description)}) — if the shortcut is gone, run \`pup debt close ${c.id}\`.`,
              );
            }
            if (outcome.decisionRecordId !== undefined) {
              reviewDecisionRecord(db, outcome.decisionRecordId);
            }
            break;
          case 'refused': {
            const flagged = outcome.report.stages
              .filter((s) => s.status === 'flagged')
              .map((s) => sanitizeReason(s.stage))
              .join(', ');
            console.log(
              `Merge refused: ${flagged} flagged. Re-run with --accept-debt "<reason>" --review-by "<condition>", or steer the session to address the flags.`,
            );
            break;
          }
          case 'rejected':
            console.log(
              `Gate failed; report re-injected into the session (rejection ${outcome.rejectCount}/2).`,
            );
            break;
          case 'blocked':
            console.log(
              `Gate failed; session parked as blocked — needs a human. Address it, then \`pup unblock ${session}\`.`,
            );
            break;
        }
        if (outcome.status !== 'merged') process.exitCode = 1;
      },
    );
  program
    .command('map [module]')
    .description('Code map: text tree, or one module in detail; --open for the mind-map')
    .option('--open', 'render the interactive mind-map and open it in the browser')
    .action((module: string | undefined, opts: { open?: boolean }) => {
      const { repoPath, db } = project();
      const [adapter] = detectAdapters(repoPath);
      if (!adapter) {
        return refuse(
          'No adapter detected for this repo (supported stacks: TypeScript, Python, or a .pupitre/adapter.yml).',
        );
      }
      const nodes = buildCodeMap(db, projectId(repoPath), repoPath, adapter);
      if (!opts.open) {
        console.log(renderCodeMap(nodes, module));
        return;
      }
      const html = renderMindMapHtml(repoPath, nodes, listDecisionRecords(db));
      const outFile = join(projectPaths(repoPath).root, 'map.html');
      writeFileSync(outFile, html);
      console.log(`Mind-map written to ${outFile}`);
      try {
        execFileSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [outFile]);
      } catch {
        console.log('Could not open a browser; open the file manually.');
      }
    });
  program
    .command('report')
    .description('Render the project report (sessions with intent, drift, debt, decisions) as HTML')
    .option('--open', 'open the rendered report in the browser')
    .action((opts: { open?: boolean }) => {
      const { repoPath, db } = project();
      const outDir = projectPaths(repoPath).root;
      let dossiers = 0;
      for (const session of listSessions(db)) {
        const fileName = dossierFileName(session.id);
        if (!fileName) continue;
        writeFileSync(join(outDir, fileName), renderSessionDossierHtml(db, repoPath, session));
        dossiers += 1;
      }
      const html = renderReportHtml(db, repoPath);
      const outFile = join(outDir, 'report.html');
      writeFileSync(outFile, html);
      console.log(`Report written to ${outFile}`);
      if (dossiers > 0) {
        console.log(`${dossiers} session ${dossiers === 1 ? 'dossier' : 'dossiers'} alongside.`);
      }
      if (!opts.open) return;
      try {
        execFileSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [outFile]);
      } catch {
        console.log('Could not open a browser; open the file manually.');
      }
    });
  const debt = program.command('debt').description('Open ledger entries, oldest first');
  debt.action(() => {
    const { repoPath, db } = project();
    const entries = listLedgerEntries(db, projectId(repoPath));
    if (entries.length === 0) {
      console.log('No open ledger entries.');
      return;
    }
    for (const entry of entries) {
      console.log(
        `#${entry.id}  ${sanitizeReason(entry.created_at)}  ${sanitizeReason(entry.description)}`,
      );
      console.log(
        `  reason: ${sanitizeReason(entry.reason)}  review by: ${sanitizeReason(entry.review_by)}  accepted by: ${sanitizeReason(entry.accepted_by)}`,
      );
    }
  });
  debt
    .command('close <id>')
    .description('Close a ledger entry once a merge has removed the shortcut')
    .action((id: string) => {
      const { db } = project();
      // Closing an entry is the operator's judgement that the shortcut is
      // gone; a session or the conductor closing one erases the operator's
      // own overdue-debt reminder (decisions 30, 47).
      if (callingSession(db) || callingConductor()) {
        return refuse(
          '`pup debt close` is operator-only; only the operator retires a ledger entry.',
        );
      }
      if (closeLedgerEntry(db, Number(id))) {
        console.log(`Closed ledger entry #${sanitizeReason(id)}.`);
      } else {
        refuse(`No open ledger entry #${id}.`);
      }
    });
  program
    .command('log [module]')
    .description('Decision records, newest first, optionally filtered by module or file')
    .action((module?: string) => {
      const { db } = project();
      const records = listDecisionRecords(db, module);
      if (records.length === 0) {
        console.log(module ? `No decision records touching ${module}.` : 'No decision records.');
        return;
      }
      for (const record of records) {
        console.log(
          `#${record.id}  ${sanitizeReason(record.created_at)}  session ${sanitizeReason(record.session_id)}`,
        );
        printDecisionRecordBody(record);
        console.log(
          `  files: ${sanitizeReason((JSON.parse(record.files) as string[]).join(', '))}`,
        );
      }
    });
  program
    .command('profile <action> [name]')
    .description('Manage profile layers (list|show|edit|stale)')
    .action((action: string, name?: string) => {
      const { profilesDir } = projectPaths(project().repoPath);
      try {
        switch (action) {
          case 'list': {
            console.log('NAME              EXTENDS           BUDGET');
            for (const layer of listProfileLayers(profilesDir)) {
              console.log(
                `${sanitizeReason(layer.name).padEnd(18)}${sanitizeReason(layer.extends ?? '-').padEnd(18)}${sanitizeReason(String(layer.contextBudget ?? '-'))}`,
              );
            }
            return;
          }
          case 'show': {
            if (!name) {
              return refuse('Usage: pup profile show <name>');
            }
            // Line by line, never whole: the dump is multi-line YAML and
            // `sanitizeReason` collapses whitespace, so one call over the lot
            // would fold the layer onto a single row (decision 68's per-line
            // rule). The source scan cannot see this one — the field names are
            // gone by the time the lines exist — so the tests carry it.
            //
            // The leading spaces and tabs are re-applied because `sanitizeReason`
            // trims, and in YAML the indentation is the nesting: scrubbed away,
            // a layer with `skills` or `hooks` prints as something that no
            // longer parses. Only ` ` and `\t` are copied through, so nothing a
            // layer wrote rides along in front of the scrubbed text.
            for (const line of stringify(getProfileLayer(profilesDir, name))
              .trimEnd()
              .split('\n')) {
              console.log(`${/^[ \t]*/.exec(line)?.[0] ?? ''}${sanitizeReason(line)}`);
            }
            return;
          }
          case 'edit':
          case 'stale':
            return refuse(`pup profile ${action}: not implemented yet`);
          default:
            refuse(`Unknown profile action \`${action}\` (expected list|show|edit|stale).`);
        }
      } catch (error) {
        if (error instanceof UnknownProfileError || error instanceof InvalidProfileError) {
          return refuse(error.message);
        }
        throw error;
      }
    });
  program
    .command('audit')
    .description('Re-run the baseline stages and report drift against the stored baseline')
    .option('--sweep', 'spawn a deletion-only session from the audit findings')
    .option('--model <model>', 'claude model for the sweep session (with --sweep)')
    .option('--gate-env <names>', GATE_ENV_DESCRIPTION)
    .action((opts: { sweep?: boolean; model?: string; gateEnv?: string }) => {
      const { repoPath, db } = project();
      // Outside a merge the audit is the only thing that re-stamps the debt
      // baseline, and on a `--pr` repo it is the only thing at all (decisions
      // 26, 30) — so a session running it from its worktree chooses the moment
      // its own bar moves. `--sweep` is a launch besides, and launches are
      // operator-only for their own reasons (decision 42).
      if (callingSession(db)) {
        return refuse('`pup audit` is operator-only; sessions cannot move the baseline.');
      }
      const report = withPushTargetLine(db, repoPath, () =>
        runOrReportNoAdapter(() =>
          auditProject(db, repoPath, detectAdapters(repoPath), parseGateEnv(opts.gateEnv)),
        ),
      );
      if (!report) return;
      if (opts.sweep) {
        if (report.hasRegression) {
          return refuse('Baseline regressed — fix the regression before sweeping.');
        }
        const task = buildSweepTask(`sweep-${Date.now().toString(36)}` as TaskId, report.findings);
        // The task was just minted and the sweep waives the one conflict a
        // launch can raise, so the only refusal left for the operator to answer
        // is the project brief, which the compile reads and can refuse for
        // being oversized (decision 57).
        const sessionId = launchOrRefuse(db, task.id, [InvalidProfileError], () =>
          createSession(db, {
            repoPath,
            base: DEFAULT_BASE_PROFILE,
            task,
            claudeUserDir: join(homedir(), '.claude'),
            model: opts.model,
            origin: 'audit',
            // A sweep is scoped to the whole repo by construction, so it overlaps
            // every live session there is. Refusing it would make `--sweep`
            // unrunnable whenever anything else is running, with no flag to say
            // otherwise; the `scope_overlap` event records which sessions it
            // stepped on, which is what the refusal was protecting (decision 41).
            allowOverlap: true,
          }),
        );
        if (sessionId === undefined) return;
        reportLaunched(sessionId, 'sweep session');
        return;
      }
      if (!report.previous) {
        console.log('No stored baseline yet — captured one now, like `pup init`.');
        printInitReport(db, report, repoPath);
        return;
      }
      console.log(`Project ${report.projectId} (${sanitizeReason(repoPath)})`);
      const fresh = new Map(report.baseline.stages.map((s) => [s.stage, s]));
      for (const t of report.transitions) {
        const move =
          t.delta === 'unchanged'
            ? t.after.toUpperCase()
            : `${t.before.toUpperCase()} -> ${t.after.toUpperCase()}`;
        const marker = t.delta === 'unchanged' ? '' : `  ${t.delta.toUpperCase()}`;
        console.log(
          `  ${sanitizeReason(t.stage).padEnd(8)} ${sanitizeReason(move).padEnd(16)}${marker}`,
        );
        const detail = fresh.get(t.stage)?.detail;
        if (t.delta === 'regressed' && detail)
          console.log(`    ${sanitizeReason(detail.split('\n').at(-1) ?? '')}`);
      }
      printBaselineTail(db, report, repoPath, report.debtTransitions.map(formatDebtTransition));
      console.log('Baseline refreshed.');
      if (report.hasRegression) process.exitCode = 1;
    });

  const session = program.command('session').description('Session-internal protocol commands');
  session
    .command('done <summary>')
    .description('Signal task completion (run by the agent)')
    .action((summary: string) => {
      const { db } = project();
      const sessionId = ownSession(db, 'done');
      if (!sessionId) return;
      markSessionDone(db, sessionId, summary);
      console.log(`Session ${sanitizeReason(sessionId)} marked done: ${sanitizeReason(summary)}`);
    });
  session
    .command('handoff-done')
    .description('Signal that the requested handoff document is written (run by the agent)')
    .action(() => {
      const { repoPath, db } = project();
      const sessionId = ownSession(db, 'handoff-done');
      if (!sessionId) return;
      // The signal names the document by its content (decision 49), so there
      // has to be one: signalling for a file that is not there is the agent
      // reporting done a step early, and says so rather than arming a respawn
      // the next thing to write that path would ride in on.
      try {
        markHandoffReady(db, repoPath, sessionId);
      } catch (error) {
        if (!(error instanceof HandoffMissingError)) throw error;
        return refuse(error.message);
      }
      console.log(
        `Session ${sanitizeReason(sessionId)} handoff recorded; Pupitre will respawn you shortly.`,
      );
    });

  return program;
}

/**
 * `import.meta.url` is the resolved file, but `process.argv[1]` is whatever was
 * invoked — the `bin/pup` symlink `npm link` installs. Without the realpath the
 * two never match and the CLI exits 0 having done nothing, which is exactly
 * how the linked binary shipped: silent, not broken.
 */
function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

/**
 * The exit code for an error that escaped `parse`: commander's own (help,
 * version, usage) already wrote their message; a project that cannot be
 * resolved gets its one line here. Anything else is a bug and stays a crash.
 */
export function fatalExitCode(error: unknown): number {
  if (error instanceof CommanderError) return error.exitCode;
  if (error instanceof ProjectResolutionError) {
    console.error(error.message);
    return 1;
  }
  throw error;
}

if (isMainModule()) {
  try {
    buildProgram().parse();
  } catch (error) {
    // exitCode, not exit(): when stderr is a pipe the write is asynchronous
    // and exit() would drop the one line that explains the failure.
    process.exitCode = fatalExitCode(error);
  }
}
