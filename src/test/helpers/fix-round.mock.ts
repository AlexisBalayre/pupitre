import type { Adapter } from '../../adapters/types/adapter.types.js';
import { commitAs } from './git.mock.js';

export { GIT_ENV, sh } from './git.mock.js';
export { passingAdapter } from './merge-gate.mock.js';

export function commitIn(dir: string, file: string, content: string): string {
  return commitAs({ email: 'f@test', name: 'fix' }, dir, file, content);
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
