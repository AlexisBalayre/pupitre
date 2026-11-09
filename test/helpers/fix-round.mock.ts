import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Adapter } from '@src/adapters/types/adapter.types.js';

// Test repos must not inherit the developer's global git config nor GIT_DIR &
// co., which a pre-commit hook run would aim at the pupitre repo instead.
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync(args[0] as string, args.slice(1), {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
  }).trim();
}

export function commitIn(dir: string, file: string, content: string): string {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
  sh(dir, 'git', 'add', '.');
  sh(dir, 'git', '-c', 'user.email=f@test', '-c', 'user.name=fix', 'commit', '-q', '-m', file);
  return sh(dir, 'git', 'rev-parse', 'HEAD');
}

export const SESSION_ID = 's1';

export const BRANCH = `pup/${SESSION_ID}`;

export const ORIGIN_URL = 'git@github.com:owner/repo.git';

export const PR_URL = 'https://github.com/owner/repo/pull/7';

export const BOT = { __typename: 'Bot', login: 'github-actions' };

export const OTHER_SHA = 'a'.repeat(40);

export const failingAdapter: Adapter = {
  id: 'fake',
  detect: () => true,
  gateCommands: () => [{ stage: 'test', command: 'false', args: [] }],
};

export const passingAdapter: Adapter = {
  id: 'fake',
  detect: () => true,
  gateCommands: () => [
    { stage: 'build', command: 'true', args: [] },
    { stage: 'test', command: 'true', args: [] },
    { stage: 'lint', command: 'true', args: [] },
  ],
};

export interface ThreadSeed {
  id: string;
  body: string;
  path?: string | null;
  line?: number | null;
  originalLine?: number | null;
  isResolved?: boolean;
  author?: unknown;
  /** Opened by the bot's review before its newest one, on another commit. */
  earlier?: boolean;
  /** Who last edited the finding, with `lastEditedAt`; unedited when absent. */
  editor?: unknown;
  isMinimized?: boolean;
}
