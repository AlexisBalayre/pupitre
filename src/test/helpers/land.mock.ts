import { commitAs } from './git.mock.js';

export { sh } from './git.mock.js';

export function commitIn(dir: string, file: string, content: string): string {
  return commitAs({ email: 'l@test', name: 'land' }, dir, file, content);
}

export const SESSION_ID = 's1';
export const BRANCH = `pup/${SESSION_ID}`;
export const ORIGIN_URL = 'git@github.com:owner/repo.git';
export const PR_URL = 'https://github.com/owner/repo/pull/7';
