import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Test repos must not inherit the developer's global git config (hooks, signing)
// nor GIT_DIR & co. — when a suite runs inside a git hook (pre-commit), those
// would redirect every git call at the pupitre repo instead of the temp repo.
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

/** Run a command in `cwd` under GIT_ENV; its stdout, trimmed. */
export function sh(cwd: string, ...args: string[]): string {
  return execFileSync(args[0] as string, args.slice(1), {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
  }).trim();
}

/** Write `file` and commit everything as `author`; the new HEAD sha. */
export function commitAs(
  author: { email: string; name: string },
  dir: string,
  file: string,
  content: string,
): string {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
  sh(dir, 'git', 'add', '.');
  sh(
    dir,
    'git',
    '-c',
    `user.email=${author.email}`,
    '-c',
    `user.name=${author.name}`,
    'commit',
    '-q',
    '-m',
    file,
  );
  return sh(dir, 'git', 'rev-parse', 'HEAD');
}
