import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { isSandboxSupported, runGateChild, sandboxLabel } from './sandbox.utils.js';

/** The label pup reports when it applied its own profile rather than inheriting one. */
const APPLIED_LABEL = 'sandbox-exec (macOS)';

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

  it.runIf(isSandboxSupported())(
    'refuses the run when the probe fails for any reason but nesting',
    async () => {
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        execFileSync: () => {
          throw Object.assign(new Error('sandbox-exec: dyld image not found'), {
            stderr: 'dyld: image not found\n',
          });
        },
      }));

      const module = await import('./sandbox.utils.js');

      // Fail closed: a sandbox broken in a way pup does not recognise refuses
      // the stage rather than quietly running the child unconfined.
      expect(() => module.sandboxLabel()).toThrow(/dyld image not found/);
      vi.doUnmock('node:child_process');
      vi.resetModules();
    },
  );
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

  it('hands the child a var pup computed, which the operator never exported', () => {
    // COVERAGE_FILE because it is the settable list: any other name throws
    // before a child is spawned, which gate-env's own tests pin.
    const cwd = fakeCheckout();

    const output = runGateChild('sh', ['-c', 'printf %s "$COVERAGE_FILE"'], {
      cwd,
      repoPath: cwd,
      env: { COVERAGE_FILE: '/reports/.coverage' },
    });

    expect(output).toBe('/reports/.coverage');
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

    /**
     * These assert pup's *own* policy, so they only run where pup applied it:
     * under `inherited` the outer profile governs and grants a different set,
     * which is a real guarantee but not this one.
     */
    describe.runIf(sandboxLabel() === APPLIED_LABEL)('with pup own profile applied', () => {
      it('cannot write outside every granted path', () => {
        const cwd = fakeCheckout();
        // The real TMPDIR root, which is nobody's grant — the child's own
        // TMPDIR is a subdirectory of it that pup does grant.
        const target = join(tmpdir(), 'pup-ungranted-canary');
        // A canary left by an earlier failing run must not decide this one.
        rmSync(target, { force: true });

        expect(() =>
          runGateChild('sh', ['-c', `printf x > ${target}`], { cwd, repoPath: cwd }),
        ).toThrow();
        expect(existsSync(target)).toBe(false);
      });

      it('cannot write the git directory of the checkout it measures', () => {
        // `core.fsmonitor` in .git/config is executed by pup's own later git
        // calls, which are unsandboxed and carry the operator's environment.
        const cwd = fakeCheckout();
        mkdirSync(join(cwd, '.git'));

        expect(() =>
          runGateChild('sh', ['-c', 'printf x > .git/config'], { cwd, repoPath: cwd }),
        ).toThrow();
        expect(existsSync(join(cwd, '.git', 'config'))).toBe(false);
        // The control: an ordinary file in the same checkout still writes.
        runGateChild('sh', ['-c', 'printf ok > ordinary.txt'], { cwd, repoPath: cwd });
        expect(readFileSync(join(cwd, 'ordinary.txt'), 'utf8')).toBe('ok');
      });

      it('cannot write the git directory of a checkout nested inside the grant', () => {
        // `protectedPaths` is derived one level deep — granting P denies
        // P/.git and nothing deeper — so this .git sits inside the grant with
        // no per-path deny of its own. That is the exact shape of #49's
        // sibling-worktree attack. The regex deny covers .git at any depth,
        // which is what this asserts.
        const cwd = fakeCheckout();
        const nestedGit = join(cwd, '.worktrees', 's1', '.git');
        mkdirSync(nestedGit, { recursive: true });

        expect(() =>
          runGateChild('sh', ['-c', 'printf x > .worktrees/s1/.git/config'], {
            cwd,
            repoPath: cwd,
          }),
        ).toThrow(/Operation not permitted/);
        expect(existsSync(join(nestedGit, 'config'))).toBe(false);
        // The control: an ordinary file in the same nested checkout still
        // writes, so the denial above is the .git rule and not a lost grant.
        runGateChild('sh', ['-c', 'printf ok > .worktrees/s1/ordinary.txt'], {
          cwd,
          repoPath: cwd,
        });
        expect(readFileSync(join(cwd, '.worktrees', 's1', 'ordinary.txt'), 'utf8')).toBe('ok');
      });

      it('cannot write the trusted checkout it is measured against', () => {
        // The trusted checkout is decision 29's whole basis: writable, a build
        // stage drops `@vitest/coverage-v8` from the manifest the *next* stage
        // reads and the coverage stage stops measuring with nobody the wiser.
        // It also carried every sibling worktree's `.git` pointer file, one
        // level below the `.git` deny.
        const repoPath = fakeCheckout();
        const cwd = fakeCheckout();
        writeFileSync(join(repoPath, 'package.json'), '{"devDependencies":{}}');

        expect(() =>
          runGateChild('sh', ['-c', `printf {} > ${repoPath}/package.json`], { cwd, repoPath }),
        ).toThrow();
        expect(readFileSync(join(repoPath, 'package.json'), 'utf8')).toBe('{"devDependencies":{}}');
      });
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
