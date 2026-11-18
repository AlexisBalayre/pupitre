import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  killSession: vi.fn(),
  steerPane: vi.fn(),
}));

// Without this, every merging test would spawn a real `claude -p` call.
vi.mock('../claude/utility.service.js', () => ({
  runUtility: vi.fn(() => ({ ok: false, output: 'mocked out in tests' })),
}));

import {
  BRANCH,
  commitIn,
  initRepo,
  passingAdapter,
  SESSION_ID,
  seedSession,
  sh,
} from '@test/helpers/merge-gate.mock.js';
import { openStore } from './db.client.js';
import { runMergeGate } from './merge-gate.service.js';
import { HELD_SLOT_ENV } from './test-slot.service.js';

describe('fresh-base over rebase or merge state in the worktree (decision 204)', {
  timeout: 20_000,
}, () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openStore(':memory:');
    repo = initRepo();
    // As inside a slot already held, so a gate here never queues behind the
    // machine's real test runs (decision 96).
    vi.stubEnv(HELD_SLOT_ENV, 'merge-gate-in-progress.test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const revParse = (dir: string, rev: string): string => sh(dir, 'git', 'rev-parse', rev).trim();

  // A rebase dir names main and an older commit, which the gate's
  // `rebase --abort` would move main back to (Git 2.54): main moved, so a
  // rebase is due, and it refuses over the dir before the abort runs.
  it.each(['rebase-merge', 'rebase-apply', 'sequencer', 'MERGE_HEAD', 'REBASE_HEAD'])(
    'fails fresh-base naming a planted %s, running no rebase or merge',
    async (name) => {
      const worktree = seedSession(db, repo);
      const base = revParse(repo, 'main');
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      commitIn(repo, 'README.md', '# hello\n');
      const tip = revParse(repo, BRANCH);
      const target = revParse(repo, 'main');
      const planted = join(realpathSync(join(repo, '.git')), 'worktrees', SESSION_ID, name);
      if (name === 'MERGE_HEAD' || name === 'REBASE_HEAD') {
        writeFileSync(planted, `${base}\n`);
      } else {
        mkdirSync(planted);
        writeFileSync(join(planted, 'head-name'), 'refs/heads/main\n');
        writeFileSync(join(planted, 'orig-head'), `${base}\n`);
        writeFileSync(join(planted, 'onto'), `${base}\n`);
      }

      const outcome = await runMergeGate(db, {
        repoPath: repo,
        sessionId: SESSION_ID,
        adapters: [passingAdapter],
      });

      expect(outcome.status).toBe('rejected');
      const stage = outcome.report.stages.find((entry) => entry.stage === 'fresh-base');
      expect(stage?.status).toBe('fail');
      expect(stage?.detail).toContain(`${planted} is in this worktree's git dir`);
      // `pup merge`, `pup review` and a blocked session show it to unsandboxed readers.
      expect(stage?.detail).toContain('Anyone else should delete it without running git');
      expect(revParse(repo, BRANCH)).toBe(tip);
      expect(revParse(repo, 'main')).toBe(target);
    },
  );
});
