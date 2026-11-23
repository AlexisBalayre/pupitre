import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MergeLockHeldError, MergeLockLostError } from '@src/core/errors/merge-gate.errors.js';
import { assertMergeLockHeld, withMergeLock } from '@src/core/merge-lock.service.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { describe, expect, it, vi } from 'vitest';

/** A repo with only the `.git` directory the merge lock lives in. */
const lockedRepo = (): string => {
  const repo = tempDir('pup-merge-lock-');
  mkdirSync(join(repo, '.git'));
  return repo;
};

const lockPath = (repo: string): string => join(repo, '.git', 'pup-merge.lock');

/** A pid that was alive a moment ago and is not now. */
const deadPid = (): string => execFileSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).trim();

describe('withMergeLock', () => {
  it('takes the lock for the section, recording its pid, and releases it after', async () => {
    const repo = lockedRepo();

    const pid = await withMergeLock(repo, () => readFileSync(join(lockPath(repo), 'pid'), 'utf8'));

    expect(pid).toBe(`${process.pid}\n`);
    expect(readdirSync(join(repo, '.git'))).toEqual([]);
  });

  it('reclaims a lock whose holder died without releasing it', async () => {
    const repo = lockedRepo();
    mkdirSync(lockPath(repo));
    writeFileSync(join(lockPath(repo), 'pid'), `${deadPid()}\n`);

    await expect(withMergeLock(repo, () => 'ran')).resolves.toBe('ran');
    expect(readdirSync(join(repo, '.git'))).toEqual([]);
  });

  it('refuses a second taker while a live run holds the lock', async () => {
    const repo = lockedRepo();
    const second = vi.fn();

    await withMergeLock(repo, async () => {
      const refused = withMergeLock(repo, second);
      await expect(refused).rejects.toThrow(MergeLockHeldError);
      await expect(refused).rejects.toThrow(
        `Another merge is in progress: pid ${process.pid} holds the lock at ${lockPath(repo)}.`,
      );
    });

    expect(second).not.toHaveBeenCalled();
    expect(readdirSync(join(repo, '.git'))).toEqual([]);
  });
});

describe('assertMergeLockHeld', () => {
  it('passes inside the section that holds the lock', async () => {
    const repo = lockedRepo();

    await expect(
      withMergeLock(repo, () => assertMergeLockHeld(repo, 'the push of main')),
    ).resolves.toBeUndefined();
  });

  it('refuses a step outside any locked section', () => {
    const repo = lockedRepo();

    expect(() => assertMergeLockHeld(repo, 'the push of main')).toThrow(
      `The merge lock at ${lockPath(repo)} is no longer the one this run took, so another ` +
        'merge or land may be running: the push of main was refused',
    );
  });

  it('refuses a step once the lock the section took is no longer its take', async () => {
    const repo = lockedRepo();
    let refusal: unknown;

    await expect(
      withMergeLock(repo, () => {
        rmSync(join(lockPath(repo), 'token'));
        try {
          assertMergeLockHeld(repo, 'the push of main');
        } catch (error) {
          refusal = error;
        }
      }),
    ).rejects.toThrow(MergeLockLostError);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain('the push of main was refused');
  });
});
