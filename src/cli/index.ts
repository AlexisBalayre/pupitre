#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { DEFAULT_BASE_PROFILE } from '../core/default-profile.constants.js';
import { listSessions } from '../core/session.repository.js';
import { createSession, killSession, markSessionDone } from '../core/session-lifecycle.service.js';
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
  .action(stub('init'));

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
  .description('Sessions by state')
  .action(() => {
    const { db } = resolveProject();
    const rows = listSessions(db);
    if (rows.length === 0) {
      console.log('No sessions.');
      return;
    }
    for (const r of rows) {
      console.log(`${r.state.padEnd(16)} ${r.id.padEnd(28)} ${r.branch}`);
    }
  });

program
  .command('steer <session> <message>')
  .description('Inject a correction into a running session')
  .action(stub('steer'));

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
  .action(stub('review'));
program
  .command('merge <session>')
  .description('Run the gate pipeline and merge on pass')
  .option('--accept-debt <reason>')
  .option('--review-by <condition>')
  .action(stub('merge'));
program.command('map [module]').description('Code map').option('--open').action(stub('map'));
program.command('debt').description('Open ledger entries, oldest first').action(stub('debt'));
program.command('log [module]').description('Decision records').action(stub('log'));
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
