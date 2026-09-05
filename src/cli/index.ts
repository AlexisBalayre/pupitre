#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Database } from 'better-sqlite3';
import { Command, CommanderError } from 'commander';
import { stringify } from 'yaml';
import { detectAdapters } from '../adapters/adapter.registry.js';
import { sanitizeReason } from '../adapters/capability.utils.js';
import {
  interruptSession,
  killWatcher,
  launchWatcher,
  steerSession,
} from '../claude/session-runtime.service.js';
import { latestContextTokens } from '../claude/transcript.service.js';
import { auditProject, buildSweepTask, formatDebtTransition } from '../core/audit.service.js';
import { buildCodeMap, renderCodeMap } from '../core/code-map.service.js';
import {
  deleteDecisionRecord,
  getDecisionRecord,
  listDecisionRecords,
  updateDecisionRecordSummary,
} from '../core/decision-record.repository.js';
import { DEFAULT_BASE_PROFILE } from '../core/default-profile.constants.js';
import { parseGateEnv } from '../core/gate-env.utils.js';
import { initProject } from '../core/init.service.js';
import {
  closeLedgerEntry,
  listLedgerEntries,
  listOverdueLedgerEntries,
} from '../core/ledger.repository.js';
import { runMergeGate } from '../core/merge-gate.service.js';
import { renderMindMapHtml } from '../core/mind-map.service.js';
import { getWatcherBeat, listOverlaps } from '../core/overlap.repository.js';
import { scanOverlaps, WATCH_INTERVAL_MS, WATCH_STALE_AFTER_MS } from '../core/overlap.service.js';
import { projectId, projectPaths } from '../core/paths.utils.js';
import { InvalidProfileError } from '../core/profile.errors.js';
import { UnknownProfileError } from '../core/profile-store.errors.js';
import { getProfileLayer, listProfileLayers } from '../core/profile-store.service.js';
import { renderReportHtml } from '../core/report.service.js';
import { buildReviewQueue, buildSessionReview } from '../core/review.service.js';
import {
  appendEvent,
  deleteTask,
  findSessionByWorktree,
  getSession,
  getTask,
  listBacklogTasks,
  listSessions,
  type SessionRow,
  updateTaskSpec,
} from '../core/session.repository.js';
import {
  classifySessionActivity,
  formatStaleAge,
  isSessionStalled,
} from '../core/session-activity.utils.js';
import { dossierFileName, renderSessionDossierHtml } from '../core/session-dossier.service.js';
import {
  awaitHandoffReady,
  HANDOFF_WAIT_DEFAULT_MS,
  hardRespawnSession,
  isHandoffReady,
  markHandoffReady,
  RESPAWN_SUGGEST_TOKENS,
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
  killSession,
  launchTask,
  markSessionDone,
  planTask,
} from '../core/session-lifecycle.service.js';
import { isTerminal } from '../core/session-state.utils.js';
import { assertPlannableSpec } from '../core/task-spec.utils.js';
import type { DebtBaseline, InitReport } from '../core/types/init.types.js';
import type { GateReport, MergeOutcome } from '../core/types/merge-gate.types.js';
import type { TaskId, TaskSpec } from '../core/types/profile.types.js';
import { runOrReportNoAdapter } from './no-adapter-guard.utils.js';
import {
  enclosingProject,
  ProjectResolutionError,
  type ResolvedProject,
  resolveProject,
} from './project.utils.js';

/**
 * One-keystroke approval of the decision record a merge just drafted. TTY
 * only — scripted/CI merges keep the draft untouched, same as before this
 * existed, so nothing interactive ever blocks automation.
 */
function reviewDecisionRecord(db: Database, recordId: number): void {
  const record = getDecisionRecord(db, recordId);
  if (!record || !process.stdin.isTTY) return;
  console.log(`\nDecision record #${record.id}:`);
  console.log(`  ${record.summary}`);
  if (record.alternatives) console.log(`  alternatives: ${record.alternatives}`);
  if (record.conventions) console.log(`  conventions: ${record.conventions}`);
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

function printInitReport(report: InitReport, repoPath: string): void {
  console.log(`Project ${report.projectId} (${repoPath})`);
  console.log(`adapters: ${report.baseline.adapters.join(', ')}`);
  for (const s of report.baseline.stages) {
    console.log(`  ${s.stage.padEnd(8)} ${s.status.toUpperCase().padEnd(8)} ${s.durationMs}ms`);
    if (s.status === 'fail' && s.detail) console.log(`    ${s.detail.split('\n').at(-1)}`);
  }
  console.log(`debt baseline: ${describeDebtBaseline(report.baseline.debt)}`);
  console.log(`sandbox: ${report.sandbox}`);
  if (report.findings.length > 0) {
    console.log('findings:');
    for (const f of report.findings) console.log(`  - ${f}`);
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
    console.error(`No session ${session}.`);
    process.exitCode = 1;
    return undefined;
  }
  if (isTerminal(row.state)) {
    console.error(`Session ${session} is ${row.state}; nothing to ${verb}.`);
    process.exitCode = 1;
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

/**
 * Width of the goal column in `pup plan` and `pup status`. Goals run to a
 * paragraph (decision 41's own backlog entries are 400+ chars), so the column
 * clips rather than pads: an unclipped goal pushed the scope column off the
 * row on the first real backlog this rendered.
 */
const GOAL_COLUMN_CHARS = 44;

/** One terminal-safe line of a task's goal, fitted to the goal column. */
function goalHeadline(spec: TaskSpec): string {
  const line = sanitizeReason((spec.goal ?? '').split('\n')[0] ?? '');
  const chars = [...line];
  return chars.length > GOAL_COLUMN_CHARS
    ? `${chars.slice(0, GOAL_COLUMN_CHARS - 1).join('')}\u2026`
    : line.padEnd(GOAL_COLUMN_CHARS);
}

const ALLOW_OVERLAP_DESCRIPTION =
  'launch even though a live session already holds files in this scope';

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
 * it declares, which counts only when it names a session that exists. Best
 * effort against a determined session, which can `cd` out of its worktree; it
 * makes the audit trail honest, not tamper-proof (decisions 26, 27).
 */
function callingSession(db: Database): string | undefined {
  const declared = process.env.PUP_SESSION_ID;
  return (
    findSessionByWorktree(db, process.cwd())?.id ??
    (declared && getSession(db, declared) ? declared : undefined)
  );
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
    try {
      // The variable alone refuses: a session that cd's outside every repo
      // has no own store to be found in, and decision 42's ceiling needed it
      // to also unset the variable — this keeps it so.
      if (process.env.PUP_SESSION_ID) throw operatorOnlyProject();
      if (own && callingSession(own.db)) throw operatorOnlyProject();
    } finally {
      own?.db.close();
    }
    return resolveProject(process.cwd(), selected);
  };

  program
    .command('init')
    .description('Onboard a repo: detect stack, baseline, conventions')
    .option('--gate-env <names>', GATE_ENV_DESCRIPTION)
    .action((opts: { gateEnv?: string }) => {
      const { repoPath, db } = project();
      const report = runOrReportNoAdapter(() =>
        initProject(db, repoPath, detectAdapters(repoPath), parseGateEnv(opts.gateEnv)),
      );
      if (!report) return;
      printInitReport(report, repoPath);
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
        console.error('`pup new` is operator-only; sessions cannot author task specs.');
        process.exitCode = 1;
        return;
      }
      const task: TaskSpec = {
        id: `t-${Date.now().toString(36)}` as TaskId,
        goal,
        scopeIn: opts.scope as string[],
        scopeOut: opts.scopeOut as string[] | undefined,
        acceptance: (opts.accept as string[] | undefined) ?? ['goal met and committed'],
      };
      let sessionId: string;
      try {
        sessionId = createSession(db, {
          repoPath,
          base: DEFAULT_BASE_PROFILE,
          task,
          claudeUserDir: join(homedir(), '.claude'),
          model: opts.model as string | undefined,
          allowOverlap: opts.allowOverlap === true,
        });
      } catch (error) {
        if (!(error instanceof ScopeConflictError)) throw error;
        console.error(error.message);
        process.exitCode = 1;
        return;
      }
      console.log(`Launched session ${sessionId} (tmux: pup-${sessionId}).`);
      console.log(`Attach with: tmux attach -t pup-${sessionId}`);
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
        console.error(`\`pup plan ${verb}\` is operator-only; sessions cannot author task specs.`);
        process.exitCode = 1;
        return;
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
            console.log(`${row.id.padEnd(14)}${goalHeadline(spec)}  ${scope}`);
          }
          return;
        }
        case 'add': {
          if (!target || !opts.scope) {
            console.error('Usage: pup plan add "<goal>" --scope <glob...>');
            process.exitCode = 1;
            return;
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
            });
          } catch (error) {
            if (!(error instanceof InvalidProfileError)) throw error;
            console.error(error.message);
            process.exitCode = 1;
            return;
          }
          console.log(`Planned ${id}. Launch it with \`pup launch ${id}\`.`);
          return;
        }
        case 'drop': {
          if (!target) {
            console.error('Usage: pup plan drop <task>');
            process.exitCode = 1;
            return;
          }
          if (!deleteTask(db, target)) {
            console.error(`No planned task ${target} (a session may already have claimed it).`);
            process.exitCode = 1;
            return;
          }
          console.log(`Dropped ${target}.`);
          return;
        }
        case 'edit': {
          if (!target) {
            console.error('Usage: pup plan edit <task> [--goal ...] [--scope ...]');
            process.exitCode = 1;
            return;
          }
          const row = getTask(db, target);
          if (!row) {
            console.error(`No task ${target}.`);
            process.exitCode = 1;
            return;
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
            console.error(error.message);
            process.exitCode = 1;
            return;
          }
          if (!updateTaskSpec(db, target, JSON.stringify(edited))) {
            console.error(`Task ${target} is already claimed by a session; its spec is frozen.`);
            process.exitCode = 1;
            return;
          }
          console.log(`Updated ${target}.`);
          return;
        }
        default:
          console.error(`Unknown plan action \`${action}\` (expected list|add|drop|edit).`);
          process.exitCode = 1;
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
        console.error('`pup launch` is operator-only; sessions cannot launch sessions.');
        process.exitCode = 1;
        return;
      }
      const planned = getTask(db, taskId);
      if (planned) {
        const spec = JSON.parse(planned.spec) as TaskSpec;
        console.log(`goal: ${sanitizeReason(spec.goal ?? '')}`);
        console.log(`scope-in: ${sanitizeReason((spec.scopeIn ?? []).join(', '))}`);
      }
      let sessionId: string;
      try {
        sessionId = launchTask(db, {
          repoPath,
          base: DEFAULT_BASE_PROFILE,
          taskId,
          claudeUserDir: join(homedir(), '.claude'),
          model: opts.model,
          allowOverlap: opts.allowOverlap,
        });
      } catch (error) {
        if (
          !(error instanceof UnknownTaskError) &&
          !(error instanceof TaskAlreadyClaimedError) &&
          !(error instanceof ScopeConflictError) &&
          !(error instanceof InvalidProfileError)
        ) {
          throw error;
        }
        console.error(error.message);
        process.exitCode = 1;
        return;
      }
      console.log(`Launched session ${sessionId} (tmux: pup-${sessionId}).`);
      console.log(`Attach with: tmux attach -t pup-${sessionId}`);
    });

  program
    .command('status')
    .description('Sessions by state, blocked and stalled first; planned work and overdue debt too')
    .action(() => {
      const { repoPath, db } = project();
      const overdue = listOverdueLedgerEntries(db, projectId(repoPath), new Date());
      for (const entry of overdue) {
        console.log(
          `OVERDUE DEBT #${entry.id}  ${entry.description}  (review by: ${entry.review_by})`,
        );
      }
      const rows = listSessions(db);
      const backlog = listBacklogTasks(db, projectId(repoPath));
      if (rows.length === 0 && backlog.length === 0) {
        console.log('Nothing running and nothing planned.');
        return;
      }
      const paths = projectPaths(repoPath);
      const stalledAges = new Map(
        findStalledSessions(db, repoPath, Date.now()).map((s) => [s.id, s.ageMs]),
      );
      const priorityFirst = [...rows].sort(
        (a, b) =>
          Number(b.state === 'blocked' || stalledAges.has(b.id)) -
          Number(a.state === 'blocked' || stalledAges.has(a.id)),
      );
      for (const r of priorityFirst) {
        const marker =
          r.state === 'blocked' ? `  needs a human (${r.reject_count} rejections)` : '';
        const tokens = r.transcript_path ? latestContextTokens(r.transcript_path) : undefined;
        const ctx =
          r.state === 'running' && tokens !== undefined
            ? `  ctx ~${Math.round(tokens / 1000)}k${tokens > RESPAWN_SUGGEST_TOKENS ? ` — consider \`pup respawn ${r.id}\`` : ''}`
            : '';
        console.log(
          `${r.state.padEnd(16)} ${r.id.padEnd(28)} ${r.branch}${marker}${activityMarker(r.state, paths.eventsFile(r.id), stalledAges.get(r.id))}${ctx}`,
        );
      }
      // Planned tasks share the session table's columns under `planned`, the
      // state docs/01 gives a task with no session row: what will be built
      // belongs beside what is being built, not in a separate command
      // (decision 41).
      for (const row of backlog) {
        const spec = JSON.parse(row.spec) as TaskSpec;
        console.log(`${'planned'.padEnd(16)} ${row.id.padEnd(28)} ${goalHeadline(spec)}`);
      }
      printConflictRadar(db, repoPath, rows);
    });

  /** The watcher's radar: same-file overlaps between live sessions (docs/08 v1.2). */
  function printConflictRadar(db: Database, repoPath: string, rows: SessionRow[]): void {
    const live = rows.filter((r) => r.state === 'running' || r.state === 'awaiting-review');
    const beat = getWatcherBeat(db, projectId(repoPath));
    const stale = !beat || Date.now() - beat.getTime() > WATCH_STALE_AFTER_MS;
    for (const pair of listOverlaps(db)) {
      const extra = pair.files.length > 1 ? ` (+${pair.files.length - 1} more)` : '';
      console.log(
        `OVERLAP  ${pair.sessionA} <-> ${pair.sessionB}  ${sanitizeReason(pair.files[0] ?? '')}${extra}${stale ? '  (stale)' : ''}`,
      );
    }
    if (live.length >= 2 && stale) {
      console.log('conflict radar off — start it with `pup watch --start`');
    }
  }

  /**
   * Decision 2: hook events, not pane contents, tell what a running session is
   * doing. Decision 35: staleness wins over activity kind — a session whose
   * events file has gone quiet too long is STALLED no matter what its last
   * classified event was.
   */
  function activityMarker(state: string, eventsFile: string, stalledAgeMs?: number): string {
    if (state !== 'running' || !existsSync(eventsFile)) return '';
    if (stalledAgeMs !== undefined) return `  STALLED (${formatStaleAge(stalledAgeMs)})`;
    const activity = classifySessionActivity(readFileSync(eventsFile, 'utf8'));
    if (activity.kind === 'awaiting-input') {
      return `  WAITING ON INPUT${activity.detail ? ` (${activity.detail})` : ''}`;
    }
    if (activity.kind === 'idle') return '  idle (turn ended, no done signal)';
    return '';
  }

  /** Running sessions whose events file has gone quiet past STALLED_AFTER_MS (decision 35). */
  function findStalledSessions(
    db: Database,
    repoPath: string,
    now: number,
  ): Array<{ id: string; ageMs: number }> {
    const paths = projectPaths(repoPath);
    const stalled: Array<{ id: string; ageMs: number }> = [];
    for (const r of listSessions(db, ['running'])) {
      const eventsFile = paths.eventsFile(r.id);
      if (!existsSync(eventsFile)) continue;
      const ageMs = now - statSync(eventsFile).mtimeMs;
      if (isSessionStalled(ageMs)) stalled.push({ id: r.id, ageMs });
    }
    return stalled;
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
              `${stamp}  OVERLAP  ${pair.sessionA} <-> ${pair.sessionB}  ${sanitizeReason(pair.files.join(', '))}`,
            );
          }
          for (const s of stalled) {
            console.log(`${stamp}  STALLED  ${s.id}  ${formatStaleAge(s.ageMs)}`);
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
    .action((session: string, message: string) => {
      const { db } = project();
      if (!resolveLiveSession(db, session, 'steer')) return;
      steerSession(session, message);
      appendEvent(db, session, 'steer', { kind: 'manual' });
      console.log(`Steered session ${session}.`);
    });

  program
    .command('interrupt <session> [message]')
    .description("Abort the session's in-flight tool call (Escape), optionally steering a message")
    .action((session: string, message?: string) => {
      const { db } = project();
      if (!resolveLiveSession(db, session, 'interrupt')) return;
      interruptSession(session);
      if (message) steerSession(session, message);
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
        console.error('`pup kill` is operator-only; sessions cannot kill sessions.');
        process.exitCode = 1;
        return;
      }
      if (opts.respawn) {
        try {
          hardRespawnSession(db, repoPath, session);
        } catch (error) {
          console.error((error as Error).message);
          process.exitCode = 1;
          return;
        }
        console.log(`Hard-respawned session ${session} (tmux: pup-${session}).`);
        return;
      }
      killSession(db, session);
      console.log(`Killed session ${session}.`);
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
      if (!isHandoffReady(db, session)) {
        const handoffPath = requestHandoff(db, repoPath, session);
        console.log(`Handoff requested; waiting for the session to write ${handoffPath} …`);
        if (!awaitHandoffReady(db, session, Number(opts.wait) * 1000)) {
          console.error(
            `Session ${session} has not signalled handoff-done yet (steers queue until its ` +
              'current turn ends). Re-run `pup respawn` to ask again and keep waiting.',
          );
          process.exitCode = 1;
          return;
        }
      }
      respawnSession(db, repoPath, session);
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
          console.log(
            `${e.risk.toFixed(1).padStart(5)}  ${e.sessionId.padEnd(28)} ${String(e.changedLines).padStart(5)}  ${String(e.filesChanged).padStart(5)}  ${String(e.rejectCount).padStart(3)}  ${String(e.scopeViolations).padStart(4)}  ${String(e.overlaps).padStart(7)}  ${e.goal}`,
          );
        }
        return;
      }
      const detail = buildSessionReview(db, repoPath, session);
      console.log(`${detail.entry.sessionId}  (${detail.state}, risk ${detail.entry.risk})`);
      console.log(`branch: ${detail.entry.branch}  worktree: ${detail.worktreePath}`);
      console.log(`goal: ${detail.spec.goal}`);
      console.log(`scope-in: ${detail.spec.scopeIn.join(', ')}`);
      if (detail.spec.scopeOut?.length)
        console.log(`scope-out: ${detail.spec.scopeOut.join(', ')}`);
      console.log(`acceptance: ${detail.spec.acceptance.join('; ')}`);
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
        for (const s of detail.lastGateReport.stages) {
          console.log(
            `  ${s.stage.padEnd(16)} ${s.status.toUpperCase()}${s.detail ? `  ${s.detail}` : ''}`,
          );
        }
      }
    });
  function printGateReport(report: GateReport): void {
    for (const stage of report.stages) {
      console.log(
        `  ${stage.stage.padEnd(16)} ${stage.status.toUpperCase()}${stage.detail ? `  ${stage.detail}` : ''}`,
      );
    }
    // Printed on every run, pass or fail: an operator who never sees this line
    // cannot tell a confined gate from an unconfined one (decision 36).
    console.log(`  ${'sandbox'.padEnd(16)} ${report.sandbox}`);
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
          console.error('--accept-debt and --review-by must be passed together.');
          process.exitCode = 1;
          return;
        }
        const { repoPath, db } = project();
        // Worktree first: it survives `env -u PUP_SESSION_ID`. Neither is proof
        // against a determined session (it can also `cd` out of its worktree) —
        // this makes the audit trail honest, not tamper-proof (decision 27). The
        // env var only counts when it names a session that exists, so it cannot
        // write arbitrary text into the ledger's acceptor column.
        const caller = callingSession(db);
        if (opts.pr && caller) {
          console.error('`pup merge --pr` is operator-only; sessions cannot open pull requests.');
          process.exitCode = 1;
          return;
        }
        const [adapter] = detectAdapters(repoPath);
        if (!adapter) {
          console.error(
            'No adapter detected for this repo (supported stacks: TypeScript, Python, or a .pupitre/adapter.yml).',
          );
          process.exitCode = 1;
          return;
        }
        let outcome: MergeOutcome;
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
                    // The ledger must name the real acceptor, not assume a human.
                    acceptedBy: caller ?? 'human',
                  }
                : undefined,
            openPr: opts.pr,
            gateEnv: parseGateEnv(opts.gateEnv),
          });
        } catch (error) {
          // Refusals here are expected outcomes with operator instructions in the
          // message (held lock, adoptable-PR checks) — a stack trace buries them.
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
          return;
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
                `This merge touched files of open debt #${c.id} (${c.description}) — if the shortcut is gone, run \`pup debt close ${c.id}\`.`,
              );
            }
            if (outcome.decisionRecordId !== undefined) {
              reviewDecisionRecord(db, outcome.decisionRecordId);
            }
            break;
          case 'refused': {
            const flagged = outcome.report.stages
              .filter((s) => s.status === 'flagged')
              .map((s) => s.stage)
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
            console.log('Gate failed; session parked as blocked — needs a human.');
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
        console.error(
          'No adapter detected for this repo (supported stacks: TypeScript, Python, or a .pupitre/adapter.yml).',
        );
        process.exitCode = 1;
        return;
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
      console.log(`#${entry.id}  ${entry.created_at}  ${entry.description}`);
      console.log(
        `  reason: ${entry.reason}  review by: ${entry.review_by}  accepted by: ${entry.accepted_by}`,
      );
    }
  });
  debt
    .command('close <id>')
    .description('Close a ledger entry once a merge has removed the shortcut')
    .action((id: string) => {
      const { db } = project();
      if (closeLedgerEntry(db, Number(id))) {
        console.log(`Closed ledger entry #${id}.`);
      } else {
        console.error(`No open ledger entry #${id}.`);
        process.exitCode = 1;
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
        console.log(`#${record.id}  ${record.created_at}  session ${record.session_id}`);
        console.log(`  ${record.summary}`);
        if (record.alternatives) console.log(`  alternatives: ${record.alternatives}`);
        if (record.conventions) console.log(`  conventions: ${record.conventions}`);
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
                `${layer.name.padEnd(18)}${(layer.extends ?? '-').padEnd(18)}${layer.contextBudget ?? '-'}`,
              );
            }
            return;
          }
          case 'show': {
            if (!name) {
              console.error('Usage: pup profile show <name>');
              process.exitCode = 1;
              return;
            }
            console.log(stringify(getProfileLayer(profilesDir, name)).trimEnd());
            return;
          }
          case 'edit':
          case 'stale':
            console.error(`pup profile ${action}: not implemented yet`);
            process.exitCode = 1;
            return;
          default:
            console.error(`Unknown profile action \`${action}\` (expected list|show|edit|stale).`);
            process.exitCode = 1;
        }
      } catch (error) {
        if (error instanceof UnknownProfileError || error instanceof InvalidProfileError) {
          console.error(error.message);
          process.exitCode = 1;
          return;
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
      const report = runOrReportNoAdapter(() =>
        auditProject(db, repoPath, detectAdapters(repoPath), parseGateEnv(opts.gateEnv)),
      );
      if (!report) return;
      if (opts.sweep) {
        if (report.hasRegression) {
          console.error('Baseline regressed — fix the regression before sweeping.');
          process.exitCode = 1;
          return;
        }
        const task = buildSweepTask(`sweep-${Date.now().toString(36)}` as TaskId, report.findings);
        const sessionId = createSession(db, {
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
        });
        console.log(`Launched sweep session ${sessionId} (tmux: pup-${sessionId}).`);
        console.log(`Attach with: tmux attach -t pup-${sessionId}`);
        return;
      }
      if (!report.previous) {
        console.log('No stored baseline yet — captured one now, like `pup init`.');
        printInitReport(report, repoPath);
        return;
      }
      console.log(`Project ${report.projectId} (${repoPath})`);
      const fresh = new Map(report.baseline.stages.map((s) => [s.stage, s]));
      for (const t of report.transitions) {
        const move =
          t.delta === 'unchanged'
            ? t.after.toUpperCase()
            : `${t.before.toUpperCase()} -> ${t.after.toUpperCase()}`;
        const marker = t.delta === 'unchanged' ? '' : `  ${t.delta.toUpperCase()}`;
        console.log(`  ${t.stage.padEnd(8)} ${move.padEnd(16)}${marker}`);
        const detail = fresh.get(t.stage)?.detail;
        if (t.delta === 'regressed' && detail) console.log(`    ${detail.split('\n').at(-1)}`);
      }
      console.log(`debt baseline: ${describeDebtBaseline(report.baseline.debt)}`);
      for (const t of report.debtTransitions) console.log(`  ${formatDebtTransition(t)}`);
      console.log(`sandbox: ${report.sandbox}`);
      // Same findings `pup init` prints: a stage that cannot measure says why
      // here too, or the repeat path is where the gap goes quiet (decision 29).
      if (report.findings.length > 0) {
        console.log('findings:');
        for (const f of report.findings) console.log(`  - ${f}`);
      }
      console.log('Baseline refreshed.');
      if (report.hasRegression) process.exitCode = 1;
    });

  const session = program.command('session').description('Session-internal protocol commands');
  session
    .command('done <summary>')
    .description('Signal task completion (run by the agent)')
    .action((summary: string) => {
      const sessionId = process.env.PUP_SESSION_ID;
      if (!sessionId) {
        console.error('pup session done must run inside a Pupitre session (PUP_SESSION_ID unset).');
        process.exitCode = 1;
        return;
      }
      const { db } = project();
      markSessionDone(db, sessionId, summary);
      console.log(`Session ${sessionId} marked done: ${summary}`);
    });
  session
    .command('handoff-done')
    .description('Signal that the requested handoff document is written (run by the agent)')
    .action(() => {
      const sessionId = process.env.PUP_SESSION_ID;
      if (!sessionId) {
        console.error(
          'pup session handoff-done must run inside a Pupitre session (PUP_SESSION_ID unset).',
        );
        process.exitCode = 1;
        return;
      }
      const { db } = project();
      markHandoffReady(db, sessionId);
      console.log(`Session ${sessionId} handoff recorded; Pupitre will respawn you shortly.`);
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
