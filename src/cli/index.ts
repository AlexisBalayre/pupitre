#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { typescriptAdapter } from '../adapters/typescript.adapter.js';
import { steerSession } from '../claude/session-runtime.service.js';
import { listDecisionRecords } from '../core/decision-record.repository.js';
import { DEFAULT_BASE_PROFILE } from '../core/default-profile.constants.js';
import { initProject, NoAdapterError } from '../core/init.service.js';
import {
  closeLedgerEntry,
  listLedgerEntries,
  listOverdueLedgerEntries,
} from '../core/ledger.repository.js';
import { runMergeGate } from '../core/merge-gate.service.js';
import { projectId } from '../core/paths.utils.js';
import { buildReviewQueue, buildSessionReview } from '../core/review.service.js';
import { appendEvent, getSession, listSessions } from '../core/session.repository.js';
import { createSession, killSession, markSessionDone } from '../core/session-lifecycle.service.js';
import type { GateReport } from '../core/types/merge-gate.types.js';
import type { TaskId, TaskSpec } from '../core/types/profile.types.js';
import { resolveProject } from './project.utils.js';

const program = new Command();
program.name('pup').description('Control plane for parallel Claude Code sessions').version('0.1.0');

const stub = (name: string) => () => {
  console.error(`pup ${name}: not implemented yet`);
  process.exitCode = 1;
};

program
  .command('init')
  .description('Onboard a repo: detect stack, baseline, conventions')
  .action(() => {
    const { repoPath, db } = resolveProject();
    let report: ReturnType<typeof initProject>;
    try {
      report = initProject(db, repoPath, [typescriptAdapter]);
    } catch (error) {
      if (error instanceof NoAdapterError) {
        console.error(error.message);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    console.log(`Project ${report.projectId} (${repoPath})`);
    console.log(`adapters: ${report.baseline.adapters.join(', ')}`);
    for (const s of report.baseline.stages) {
      console.log(`  ${s.stage.padEnd(8)} ${s.status.toUpperCase().padEnd(8)} ${s.durationMs}ms`);
      if (s.status === 'fail' && s.detail) console.log(`    ${s.detail.split('\n').at(-1)}`);
    }
    if (report.findings.length > 0) {
      console.log('findings:');
      for (const f of report.findings) console.log(`  - ${f}`);
    }
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
  .option('--role <role>', 'role layer name (informational for now)')
  .option('--model <model>', 'claude model for the session')
  .action((goal: string, opts: Record<string, string[] | string | undefined>) => {
    const { repoPath, db } = resolveProject();
    const task: TaskSpec = {
      id: `t-${Date.now().toString(36)}` as TaskId,
      goal,
      scopeIn: opts.scope as string[],
      scopeOut: opts.scopeOut as string[] | undefined,
      acceptance: (opts.accept as string[] | undefined) ?? ['goal met and committed'],
    };
    const sessionId = createSession(db, {
      repoPath,
      base: DEFAULT_BASE_PROFILE,
      task,
      claudeUserDir: join(homedir(), '.claude'),
      model: opts.model as string | undefined,
    });
    console.log(`Launched session ${sessionId} (tmux: pup-${sessionId}).`);
    console.log(`Attach with: tmux attach -t pup-${sessionId}`);
  });

program
  .command('status')
  .description('Sessions by state, blocked first; overdue debt on top')
  .action(() => {
    const { repoPath, db } = resolveProject();
    const overdue = listOverdueLedgerEntries(db, projectId(repoPath), new Date());
    for (const entry of overdue) {
      console.log(
        `OVERDUE DEBT #${entry.id}  ${entry.description}  (review by: ${entry.review_by})`,
      );
    }
    const rows = listSessions(db);
    if (rows.length === 0) {
      console.log('No sessions.');
      return;
    }
    const blockedFirst = [...rows].sort(
      (a, b) => Number(b.state === 'blocked') - Number(a.state === 'blocked'),
    );
    for (const r of blockedFirst) {
      const marker = r.state === 'blocked' ? `  needs a human (${r.reject_count} rejections)` : '';
      console.log(`${r.state.padEnd(16)} ${r.id.padEnd(28)} ${r.branch}${marker}`);
    }
  });

program
  .command('steer <session> <message>')
  .description('Inject a correction into a running session')
  .action((session: string, message: string) => {
    const { db } = resolveProject();
    const row = getSession(db, session);
    if (!row) {
      console.error(`No session ${session}.`);
      process.exitCode = 1;
      return;
    }
    steerSession(session, message);
    appendEvent(db, session, 'steer', { kind: 'manual' });
    console.log(`Steered session ${session}.`);
  });

program
  .command('kill <session>')
  .description('Stop a session')
  .action((session: string) => {
    const { db } = resolveProject();
    killSession(db, session);
    console.log(`Killed session ${session}.`);
  });

program
  .command('review [session]')
  .description('Risk-ordered review queue, or one branch in detail')
  .action((session?: string) => {
    const { repoPath, db } = resolveProject();
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
    if (detail.spec.scopeOut?.length) console.log(`scope-out: ${detail.spec.scopeOut.join(', ')}`);
    console.log(`acceptance: ${detail.spec.acceptance.join('; ')}`);
    console.log(
      `rejections: ${detail.entry.rejectCount}  scope violations: ${detail.entry.scopeViolations}  overlaps: ${detail.entry.overlaps}`,
    );
    console.log('files:');
    for (const f of detail.files) {
      const added = f.added === null ? '-' : `+${f.added}`;
      const deleted = f.deleted === null ? '-' : `-${f.deleted}`;
      console.log(`  ${added.padStart(6)} ${deleted.padStart(6)}  ${f.path}`);
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
}

program
  .command('merge <session>')
  .description('Run the gate pipeline and merge on pass')
  .option('--accept-debt <reason>', 'merge despite a flagged shortcut, creating a ledger entry')
  .option('--review-by <condition>', 'review-by condition for the ledger entry')
  .action((session: string, opts: { acceptDebt?: string; reviewBy?: string }) => {
    if (Boolean(opts.acceptDebt) !== Boolean(opts.reviewBy)) {
      console.error('--accept-debt and --review-by must be passed together.');
      process.exitCode = 1;
      return;
    }
    const { repoPath, db } = resolveProject();
    if (!typescriptAdapter.detect(repoPath)) {
      console.error('No adapter detected for this repo (v1 supports TypeScript only).');
      process.exitCode = 1;
      return;
    }
    const outcome = runMergeGate(db, {
      repoPath,
      sessionId: session,
      adapter: typescriptAdapter,
      acceptDebt:
        opts.acceptDebt && opts.reviewBy
          ? { reason: opts.acceptDebt, reviewBy: opts.reviewBy }
          : undefined,
    });
    printGateReport(outcome.report);
    switch (outcome.status) {
      case 'merged':
        console.log(`Merged ${session}; worktree and branch cleaned up.`);
        for (const c of outcome.debtCandidates ?? []) {
          console.log(
            `This merge touched files of open debt #${c.id} (${c.description}) — if the shortcut is gone, run \`pup debt close ${c.id}\`.`,
          );
        }
        break;
      case 'refused':
        console.log(
          'Merge refused: diff-size flagged. Re-run with --accept-debt "<reason>" --review-by "<condition>", or steer the session to shrink the diff.',
        );
        break;
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
  });
program.command('map [module]').description('Code map').option('--open').action(stub('map'));
const debt = program.command('debt').description('Open ledger entries, oldest first');
debt.action(() => {
  const { repoPath, db } = resolveProject();
  const entries = listLedgerEntries(db, projectId(repoPath));
  if (entries.length === 0) {
    console.log('No open ledger entries.');
    return;
  }
  for (const entry of entries) {
    console.log(`#${entry.id}  ${entry.created_at}  ${entry.description}`);
    console.log(`  reason: ${entry.reason}  review by: ${entry.review_by}`);
  }
});
debt
  .command('close <id>')
  .description('Close a ledger entry once a merge has removed the shortcut')
  .action((id: string) => {
    const { db } = resolveProject();
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
    const { db } = resolveProject();
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
      console.log(`  files: ${(JSON.parse(record.files) as string[]).join(', ')}`);
    }
  });
program
  .command('profile <action> [name]')
  .description('Manage profile layers (list|show|edit|stale)')
  .action(stub('profile'));
program.command('audit').description('Re-run the audit').option('--sweep').action(stub('audit'));

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
    const { db } = resolveProject();
    markSessionDone(db, sessionId, summary);
    console.log(`Session ${sessionId} marked done: ${summary}`);
  });

program.parse();
