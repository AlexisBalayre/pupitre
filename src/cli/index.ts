#!/usr/bin/env node
import { Command } from 'commander';

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
  .command('new <task>')
  .description('Create a task spec, compile profile, launch a session')
  .option('--role <role>')
  .option('--scope <glob...>')
  .action(stub('new'));
program
  .command('status')
  .description('Sessions by state, pending reviews, scope overlaps')
  .action(stub('status'));
program
  .command('steer <session> <message>')
  .description('Inject a correction into a running session')
  .action(stub('steer'));
program
  .command('kill <session>')
  .description('Stop a session')
  .option('--respawn')
  .action(stub('kill'));
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
  .action(stub('session done'));

program.parse();
