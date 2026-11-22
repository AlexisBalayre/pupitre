import { cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectId } from '@src/core/paths.utils.js';
import { TOOLCHAIN_CACHE_DIRNAME } from '@src/core/sandbox.utils.js';
import { afterAll, beforeAll, onTestFinished } from 'vitest';

/**
 * A fresh directory under the OS temp dir, removed when the test that made it
 * finishes, passed or failed (decision 100). Resolved, because macOS's temp
 * dir is a symlink and git, the sandbox and `process.cwd()` all report the
 * resolved path. Call it from a test or a `beforeEach`: outside a running test
 * there is nothing to tie the removal to, and vitest throws.
 *
 * A gate child run against it as a repo leaves a toolchain cache keyed on its
 * path, built to outlive the run but not the repo, so that goes too.
 */
export function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  removeToolchainCacheAfterTest(dir);
  return dir;
}

function removeToolchainCacheAfterTest(repo: string): void {
  const cache = join(realpathSync(tmpdir()), TOOLCHAIN_CACHE_DIRNAME, projectId(repo));
  onTestFinished(() => {
    rmSync(cache, { recursive: true, force: true, maxRetries: 3 });
  });
}

/**
 * Builds a directory once per file, in `beforeAll`, and returns a function that
 * hands each test its own copy, removed like a `tempDir`. Call it in a `describe`
 * body or at the top of a file. The copy sits at a new path, so keep anything
 * that records absolute paths (worktrees) out of `build` and make it per test.
 * When the repo lives in the subdirectory `repoSub`, its toolchain cache goes
 * with the copy, as it does for a `tempDir` repo.
 */
export function fixtureCopier(
  prefix: string,
  build: (dir: string) => void,
  repoSub?: string,
): () => string {
  let template = '';
  beforeAll(() => {
    template = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}tpl-`)));
    build(template);
  });
  afterAll(() => {
    rmSync(template, { recursive: true, force: true, maxRetries: 3 });
  });
  return () => {
    const dir = tempDir(prefix);
    cpSync(template, dir, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    if (repoSub) removeToolchainCacheAfterTest(join(dir, repoSub));
    return dir;
  };
}
