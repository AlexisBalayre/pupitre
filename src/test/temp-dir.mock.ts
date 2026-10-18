import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import { projectId } from '../core/paths.utils.js';
import { TOOLCHAIN_CACHE_DIRNAME } from '../core/sandbox.utils.js';

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
  const cache = join(realpathSync(tmpdir()), TOOLCHAIN_CACHE_DIRNAME, projectId(dir));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(cache, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}
