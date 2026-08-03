import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { isSandboxSupported, runGateChild, sandboxLabel, sandboxProfile } from './sandbox.utils.js';

const HOME = '/Users/dev';

/**
 * Restated rather than imported from the module under test: a test that reads
 * the very list it is checking passes whatever that list happens to say, and
 * the point here is that removing a path from the policy fails a test.
 */
const CURATED_SECRET_PATHS =
  '.ssh .aws .config/gh .netrc .npmrc .gnupg .kube .docker/config.json Library/Keychains .pupitre';

function profile(writablePaths: string[] = ['/repo'], protectedPaths: string[] = []): string {
  return sandboxProfile({
    writablePaths,
    protectedPaths,
    home: HOME,
    policyDir: '/scratch/pup-sandbox-x',
  });
}

describe('sandboxProfile', () => {
  it('denies every write before granting the paths a gate needs', () => {
    // Order is the policy: the blanket deny lands first and the enumerated
    // paths override it. Denying only HOME left `/opt/homebrew/bin` — writable
    // on a standard install — open to a child that could then replace the `gh`
    // or `git` binary pup itself runs afterwards, unsandboxed.
    const generated = profile([`${HOME}/code/repo/.worktrees/s1`]);

    expect(generated).toContain('(allow default)');
    expect(generated.indexOf('(deny file-write*)')).toBeLessThan(
      generated.indexOf(`(allow file-write*\n  (subpath "${HOME}/code/repo/.worktrees/s1")`),
    );
  });

  it('grants nothing beyond the enumerated paths and the device nodes', () => {
    const generated = profile(['/repo']);
    const allow = generated.slice(
      generated.indexOf('(allow file-write*'),
      generated.lastIndexOf('(deny file-write*'),
    );

    expect([...allow.matchAll(/\(subpath "([^"]*)"\)/g)].map((match) => match[1])).toEqual([
      '/repo',
      '/dev',
    ]);
  });

  it('keeps a granted checkout git directory unwritable, since git config is execution', () => {
    // `core.fsmonitor` in .git/config runs under pup's own later git calls,
    // which are unsandboxed and carry the operator's environment on purpose.
    const generated = profile(['/repo'], ['/repo/.git']);
    const lastDeny = generated.lastIndexOf('(deny file-write*');

    expect(lastDeny).toBeGreaterThan(generated.indexOf('(allow file-write*'));
    expect(generated.slice(lastDeny)).toContain('(subpath "/repo/.git")');
  });

  it('read-denies the curated secret paths', () => {
    const generated = profile();

    for (const path of CURATED_SECRET_PATHS.split(' ')) {
      expect(generated).toContain(`(subpath "${HOME}/${path}")`);
    }
  });

  it('keeps pup its own store and the profile file unwritable, whatever the caller passed', () => {
    // Last rule wins, so these two sit after the allow list on purpose: the
    // store holds the baselines a gate ratchets and the ledger it writes, and a
    // writable profile is a widened *next* stage.
    const generated = profile([HOME]);
    const lastDeny = generated.indexOf(`(deny file-write*\n  (subpath "${HOME}/.pupitre")`);

    expect(lastDeny).toBeGreaterThan(generated.indexOf('(allow file-write*'));
    expect(generated.slice(lastDeny)).toContain('(subpath "/scratch/pup-sandbox-x")');
  });

  it('escapes a path that would otherwise break out of the SBPL string', () => {
    const generated = profile([String.raw`/repo/a"b\c`]);

    expect(generated).toContain(String.raw`(subpath "/repo/a\"b\\c")`);
  });
});

describe('sandboxLabel', () => {
  it('names the mechanism, or says plainly that there is none', () => {
    // Measured, not assumed: on darwin it is `applied` normally and `inherited`
    // when pup's own gate runs this suite as a sandboxed stage, and the two are
    // different guarantees, so the report has to distinguish them.
    expect(sandboxLabel()).toMatch(
      isSandboxSupported()
        ? /^sandbox-exec \(macOS\)$|^inherited \(pup is itself sandboxed\)$/
        : /^none \(unsupported platform\)$/,
    );
  });
});

describe('sandboxMode, through the label it reports', () => {
  /** A fresh module registry, so the once-per-process probe runs again. */
  async function freshLabel(): Promise<string> {
    vi.resetModules();
    const module = await import('./sandbox.utils.js');
    return module.sandboxLabel();
  }

  it.runIf(isSandboxSupported())(
    'ignores a planted `true` claiming the nesting refusal',
    async () => {
      // The probe used to run a PATH-resolved `true` and grep the shared stderr
      // buffer for the refusal, so this stub forged `inherited` and every gate
      // child then ran unwrapped while the report still claimed containment.
      // Asserted against the honest answer rather than a fixed string: pup's own
      // gate runs this suite already sandboxed, where `inherited` is the truth
      // and there is nothing left to forge.
      const honest = await freshLabel();
      const binDir = mkdtempSync(join(tmpdir(), 'pup-forged-probe-'));
      writeFileSync(
        join(binDir, 'true'),
        '#!/bin/sh\necho "sandbox-exec: sandbox_apply: Operation not permitted" >&2\nexit 1\n',
        { mode: 0o755 },
      );
      vi.stubEnv('PATH', `${binDir}:${process.env.PATH}`);

      await expect(freshLabel()).resolves.toBe(honest);

      vi.unstubAllEnvs();
      rmSync(binDir, { recursive: true, force: true });
    },
  );

  it('refuses the run when the probe fails for any reason but nesting', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: () => {
        throw Object.assign(new Error('sandbox-exec: dyld image not found'), {
          stderr: 'dyld: image not found\n',
        });
      },
    }));

    const module = await import('./sandbox.utils.js');

    // Fail closed: a sandbox broken in a way pup does not recognise refuses the
    // stage rather than quietly running the child unconfined.
    expect(() => module.sandboxLabel()).toThrow(/dyld image not found/);
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });
});

describe('runGateChild', () => {
  const checkouts: string[] = [];

  /**
   * A checkout under HOME, where "writable because it was passed as writable"
   * is worth asserting at all — everywhere else the default-allow policy would
   * have let the write through anyway. Falls back to tmp when HOME is already
   * denied, which is what pup's own gate does to this suite by running it as a
   * sandboxed stage.
   */
  function fakeCheckout(): string {
    const path = (() => {
      try {
        return mkdtempSync(join(homedir(), '.pup-sandbox-test-'));
      } catch {
        return mkdtempSync(join(tmpdir(), 'pup-sandbox-test-'));
      }
    })();
    checkouts.push(path);
    return path;
  }

  afterAll(() => {
    for (const path of checkouts) rmSync(path, { recursive: true, force: true });
  });

  /** Under pup's own gate, HOME is already denied — and then it already exists. */
  function mkdirSafely(path: string): void {
    try {
      mkdirSync(path, { recursive: true });
    } catch {
      // Denied by an outer sandbox, which is the condition under test anyway.
    }
  }

  it('passes through the names the operator allowed, and only those', () => {
    vi.stubEnv('PUP_TEST_TOKEN', 'shh');
    const cwd = fakeCheckout();

    const withFlag = runGateChild('sh', ['-c', 'printf %s "$PUP_TEST_TOKEN"'], {
      cwd,
      repoPath: cwd,
      gateEnv: ['PUP_TEST_TOKEN'],
    });
    const without = runGateChild('sh', ['-c', 'printf %s "$PUP_TEST_TOKEN"'], {
      cwd,
      repoPath: cwd,
    });

    expect(withFlag).toBe('shh');
    expect(without).toBe('');
    vi.unstubAllEnvs();
  });

  describe.runIf(isSandboxSupported())('on darwin', () => {
    it('cannot read the curated secret paths that exist on this machine', () => {
      const cwd = fakeCheckout();
      writeFileSync(join(cwd, 'ordinary'), 'aws-key');
      // `~/.pupitre` carries the assertion on any machine: it is on the deny
      // list, and pup creates it, so it is there whenever pup runs. Nothing is
      // planted in a real credential store to make the point — those are read
      // where they already exist, and a path that does not exist is skipped,
      // since the kernel answers ENOENT before the policy is consulted.
      mkdirSafely(join(homedir(), '.pupitre'));
      const secrets = ['.pupitre', '.ssh', '.aws', '.config/gh', '.gnupg', 'Library/Keychains']
        .map((path) => join(homedir(), path))
        .filter((path) => existsSync(path));

      for (const secret of secrets) {
        // On the denial, not on a bare non-zero exit: without the rule this
        // same read answers "Is a directory", which also fails the command.
        expect(() => runGateChild('cat', [secret], { cwd, repoPath: cwd })).toThrow(
          /Operation not permitted/,
        );
      }
      // The control: the identical command reads a file elsewhere, so the
      // failures above are the policy and not a broken invocation.
      expect(runGateChild('cat', [join(cwd, 'ordinary')], { cwd, repoPath: cwd })).toBe('aws-key');
    });

    it('cannot write under HOME, and leaves nothing behind when it tries', () => {
      const cwd = fakeCheckout();
      const target = join(homedir(), '.pup-sandbox-write-canary');

      expect(() =>
        runGateChild('sh', ['-c', `printf x > ${target}`], { cwd, repoPath: cwd }),
      ).toThrow();
      expect(existsSync(target)).toBe(false);
    });

    it('writes in the checkout it measures and in the scratch dir the caches point at', () => {
      const cwd = fakeCheckout();

      runGateChild(
        'sh',
        ['-c', 'printf built > out.txt && printf cached > "$TMPDIR/blob" && cat "$TMPDIR/blob"'],
        { cwd, repoPath: cwd },
      );

      expect(readFileSync(join(cwd, 'out.txt'), 'utf8')).toBe('built');
      // TMPDIR is the redirect every denied HOME cache lands in, so a child
      // that cannot write there fails on tooling, not on the code it measures.
      expect(runGateChild('sh', ['-c', 'cat "$TMPDIR/blob"'], { cwd, repoPath: cwd })).toBe(
        'cached',
      );
    });
  });
});
