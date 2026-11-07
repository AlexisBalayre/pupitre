import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

// The real rmSync, wrapped so one test can make a removal fail as a busy
// directory does.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

import { tempDir } from '../test/temp-dir.mock.js';
import { projectId } from './paths.utils.js';
import {
  endSandboxRun,
  GateInterruptedError,
  isSandboxSupported,
  removeGateDir,
  runGateChild,
  sandboxLabel,
  TOOLCHAIN_CACHE_DIRNAME,
  UndeclaredSandboxError,
} from './sandbox.utils.js';

// A test worker exits without the `exit` event the run's removal waits for,
// so each test ends the run its children started.
afterEach(() => {
  endSandboxRun();
});

/** The label pup reports when it applied its own profile rather than inheriting one. */
const APPLIED_LABEL = 'sandbox-exec (macOS)';

// Same isolation the other suites use: a test repo must not inherit the
// developer's global git config, nor the GIT_DIR family a pre-commit run sets —
// unscrubbed, `git init` re-initialised the hook's repo and set it bare.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

/** Both darwin answers: which one depends on whether this suite runs inside pup's own gate. */
const DARWIN_LABEL = /^sandbox-exec \(macOS\)$|^inherited \(pup is itself sandboxed\)$/;

/** Pretend to be another platform for one test; `process.platform` is a plain property. */
function onPlatform(platform: NodeJS.Platform): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  onTestFinished(() => {
    Object.defineProperty(process, 'platform', original);
  });
}

describe('sandboxLabel', () => {
  it.runIf(isSandboxSupported())('names the mechanism on darwin', () => {
    // Measured, not assumed: on darwin it is `applied` normally and `inherited`
    // when pup's own gate runs this suite as a sandboxed stage, and the two are
    // different guarantees, so the report has to distinguish them.
    expect(sandboxLabel()).toMatch(DARWIN_LABEL);
  });

  it.runIf(isSandboxSupported())('ignores the VM declaration on darwin', () => {
    vi.stubEnv('PUP_SANDBOX', 'vm');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    expect(sandboxLabel()).toMatch(DARWIN_LABEL);
  });

  describe('off darwin (decision 78)', () => {
    it('refuses without the declaration, naming the variable and the risk', () => {
      onPlatform('linux');
      vi.stubEnv('PUP_SANDBOX', undefined);
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });

      expect(() => sandboxLabel()).toThrow(UndeclaredSandboxError);
      expect(() => sandboxLabel()).toThrow(/PUP_SANDBOX=vm/);
      expect(() => sandboxLabel()).toThrow(/unconfined/);
    });

    it('names the declared VM when the operator sets PUP_SANDBOX=vm', () => {
      onPlatform('linux');
      vi.stubEnv('PUP_SANDBOX', 'vm');
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });

      expect(sandboxLabel()).toBe('vm (declared by operator)');
    });

    it.each(['VM', '1', 'true', ' vm', ''])('treats PUP_SANDBOX=%j as unset', (value) => {
      onPlatform('linux');
      vi.stubEnv('PUP_SANDBOX', value);
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });

      expect(() => sandboxLabel()).toThrow(UndeclaredSandboxError);
    });
  });
});

describe('sandboxMode, through the label it reports', () => {
  /**
   * A fresh module registry, so the once-per-process probe runs again. The
   * probe starts a run of the fresh module's own, which the file's hook
   * cannot reach.
   */
  async function freshLabel(): Promise<string> {
    vi.resetModules();
    const module = await import('./sandbox.utils.js');
    onTestFinished(() => {
      module.endSandboxRun();
    });
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
      const binDir = tempDir('pup-forged-probe-');
      writeFileSync(
        join(binDir, 'true'),
        '#!/bin/sh\necho "sandbox-exec: sandbox_apply: Operation not permitted" >&2\nexit 1\n',
        { mode: 0o755 },
      );
      vi.stubEnv('PATH', `${binDir}:${process.env.PATH}`);

      await expect(freshLabel()).resolves.toBe(honest);

      vi.unstubAllEnvs();
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
      onTestFinished(() => {
        module.endSandboxRun();
      });

      // Fail closed: a sandbox broken in a way pup does not recognise refuses
      // the stage rather than quietly running the child unconfined.
      expect(() => module.sandboxLabel()).toThrow(/dyld image not found/);
      vi.doUnmock('node:child_process');
      vi.resetModules();
    },
  );
});

describe('runGateChild', () => {
  /**
   * A checkout under HOME, where "writable because it was passed as writable"
   * is worth asserting at all — everywhere else the default-allow policy would
   * have let the write through anyway. Falls back to tmp when HOME is already
   * denied, which is what pup's own gate does to this suite by running it as a
   * sandboxed stage. Removed with the toolchain cache a child keys on it, as
   * `tempDir` removes its own (decision 100).
   */
  function fakeCheckout(): string {
    let path: string;
    try {
      path = mkdtempSync(join(homedir(), '.pup-sandbox-test-'));
    } catch {
      return tempDir('pup-sandbox-test-');
    }
    const cache = join(realpathSync(tmpdir()), TOOLCHAIN_CACHE_DIRNAME, projectId(path));
    onTestFinished(() => {
      rmSync(path, { recursive: true, force: true });
      rmSync(cache, { recursive: true, force: true });
    });
    return path;
  }

  /** The pid a child wrote to `file` in `cwd`, once it has. */
  function pidIn(cwd: string, file: string): Promise<number> {
    return vi.waitFor(
      () => {
        const pid = Number(readFileSync(join(cwd, file), 'utf8'));
        if (!pid) throw new Error(`no pid in ${file} yet`);
        return pid;
      },
      { timeout: 10_000 },
    );
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** So a test that fails on a group still running does not leave it running after it. */
  function killGroup(leader: number): void {
    try {
      process.kill(-leader, 'SIGKILL');
    } catch {
      // Gone already, which is what the test asserted.
    }
  }

  /** Under pup's own gate, HOME is already denied — and then it already exists. */
  function mkdirSafely(path: string): void {
    try {
      mkdirSync(path, { recursive: true });
    } catch {
      // Denied by an outer sandbox, which is the condition under test anyway.
    }
  }

  it('passes through the names the operator allowed, and only those', async () => {
    vi.stubEnv('PUP_TEST_TOKEN', 'shh');
    const cwd = fakeCheckout();

    const withFlag = await runGateChild('sh', ['-c', 'printf %s "$PUP_TEST_TOKEN"'], {
      cwd,
      repoPath: cwd,
      gateEnv: ['PUP_TEST_TOKEN'],
    });
    const without = await runGateChild('sh', ['-c', 'printf %s "$PUP_TEST_TOKEN"'], {
      cwd,
      repoPath: cwd,
    });

    expect(withFlag).toBe('shh');
    expect(without).toBe('');
    vi.unstubAllEnvs();
  });

  it('rejects a failed child as execFileSync did: status, output and the message', async () => {
    const cwd = fakeCheckout();

    const failure = await runGateChild('sh', ['-c', 'printf out; printf err >&2; exit 3'], {
      cwd,
      repoPath: cwd,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ status: 3, signal: null, stdout: 'out', stderr: 'err' });
    expect((failure as Error).message).toMatch(/^Command failed: .*\nerr$/s);
  });

  it('feeds the child its input, and stops one that floods a pipe with ENOBUFS', async () => {
    const cwd = fakeCheckout();

    expect(await runGateChild('cat', [], { cwd, repoPath: cwd, input: 'piped' })).toBe('piped');
    await expect(
      runGateChild('sh', ['-c', 'head -c 4096 /dev/zero'], { cwd, repoPath: cwd, maxBuffer: 1024 }),
    ).rejects.toMatchObject({ code: 'ENOBUFS' });
  });

  // A helper that left the group keeps the pipes open after the timeout stops
  // the group, and `'close'` waits for every holder of them.
  it('stops a timed-out child whose helper left the group still holding its pipes', async () => {
    const cwd = fakeCheckout();
    const helper = join(cwd, 'helper.pid');

    // The parent waits for the helper's pid before sleeping, so the helper
    // exists before the timeout can fire however loaded the machine is.
    const failure = await runGateChild(
      'perl',
      [
        '-MPOSIX',
        '-e',
        `if (!fork) { setsid; open my $f, '>', '${helper}.tmp'; print $f $$; close $f; rename '${helper}.tmp', '${helper}'; sleep 30; exit } ` +
          `select(undef, undef, undef, 0.05) until -e '${helper}'; sleep 30`,
      ],
      { cwd, repoPath: cwd, timeout: 2_000 },
    ).catch((error: unknown) => error);

    try {
      expect(failure).toMatchObject({ code: 'ETIMEDOUT' });
    } finally {
      try {
        process.kill(Number(readFileSync(helper, 'utf8')), 'SIGKILL');
      } catch {
        // Never forked: nothing to clean up.
      }
    }
  }, 15_000);

  it('kills a timed-out child that ignores SIGTERM, and its group, once the grace runs out', async () => {
    const cwd = fakeCheckout();

    const failure = await runGateChild(
      'sh',
      ['-c', "trap '' TERM; echo $$ > sh.pid; while :; do sleep 0.1; done"],
      { cwd, repoPath: cwd, timeout: 1_000 },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'ETIMEDOUT', signal: 'SIGKILL' });
    // The child leads its own group, so its pid names the group, and the
    // negative pid asks whether anything in it is left.
    const child = await pidIn(cwd, 'sh.pid');
    onTestFinished(() => killGroup(child));
    await vi.waitFor(() => expect(alive(-child)).toBe(false));
  }, 15_000);

  // Decision 132. The case that ran for three days: vitest stops a worker with
  // SIGTERM, which pup forwards and gives a grace, then SIGKILLs it 500 ms
  // later, before the grace ends.
  it('takes a child that ignores SIGTERM down with a pup killed inside its grace', {
    timeout: 20_000,
  }, async () => {
    const tmp = tempDir('pup-killed-');
    const cwd = fakeCheckout();
    const script = join(tmp, 'killed.mts');
    writeFileSync(
      script,
      [
        `import { runGateChild } from ${JSON.stringify(join(process.cwd(), 'src', 'core', 'sandbox.utils.ts'))};`,
        `const cwd = ${JSON.stringify(cwd)};`,
        `void runGateChild('sh', ['-c', "trap '' TERM; echo $$ > sh.pid; while :; do sleep 0.1; done"], { cwd, repoPath: cwd }).catch(() => undefined);`,
        `setInterval(() => undefined, 1_000);`,
      ].join('\n'),
    );
    // TMPDIR too, so the run pup never ends is removed with the rest.
    const pup = spawn(process.execPath, ['--import', 'tsx', script], {
      env: { ...process.env, TMPDIR: tmp },
      cwd: process.cwd(),
      stdio: 'ignore',
    });
    onTestFinished(() => {
      pup.kill('SIGKILL');
    });
    const child = await pidIn(cwd, 'sh.pid');
    onTestFinished(() => killGroup(child));

    pup.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    pup.kill('SIGKILL');

    await vi.waitFor(() => expect(alive(-child)).toBe(false), { timeout: 5_000 });
  });

  // A stage child is in a process group of its own, out of reach of the
  // terminal's Ctrl-C, so pup forwards what it receives (decision 95).
  describe('an interrupt of pup itself', () => {
    /** What node does with a signal: call every listener added since `before`. */
    function deliver(signal: NodeJS.Signals, before: readonly unknown[]): void {
      for (const listener of process.listeners(signal) as NodeJS.SignalsListener[]) {
        if (!before.includes(listener)) listener(signal);
      }
    }

    it('stops the child and everything it started, then rejects and stops listening', async () => {
      const cwd = fakeCheckout();
      const before = process.listeners('SIGTERM');
      const run = runGateChild('sh', ['-c', 'sleep 47.7 & echo $! > bg.pid; wait'], {
        cwd,
        repoPath: cwd,
      });
      const grandchild = await pidIn(cwd, 'bg.pid');

      deliver('SIGTERM', before);
      const failure = await run.catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(GateInterruptedError);
      expect((failure as GateInterruptedError).signal).toBe('SIGTERM');
      await vi.waitFor(() => expect(alive(grandchild)).toBe(false));
      expect(process.listeners('SIGTERM')).toEqual(before);
    });

    it('forwards to every child still running, the concurrent ones included', async () => {
      const cwd = fakeCheckout();
      const before = process.listeners('SIGINT');
      const runs = ['one', 'two'].map((name) =>
        runGateChild('sh', ['-c', `echo $$ > ${name}.pid; sleep 47.8`], { cwd, repoPath: cwd }),
      );
      await Promise.all([pidIn(cwd, 'one.pid'), pidIn(cwd, 'two.pid')]);

      expect(process.listeners('SIGINT')).toHaveLength(before.length + 1);
      deliver('SIGINT', before);
      const failures = await Promise.all(runs.map((run) => run.catch((error: unknown) => error)));

      expect(failures.map((failure) => (failure as GateInterruptedError).signal)).toEqual([
        'SIGINT',
        'SIGINT',
      ]);
      expect(process.listeners('SIGINT')).toEqual(before);
    });

    it('kills a child that ignores the interrupt once its grace runs out', async () => {
      const cwd = fakeCheckout();
      const before = process.listeners('SIGINT');
      const run = runGateChild('sh', ['-c', "trap '' INT; echo $$ > sh.pid; sleep 47.9"], {
        cwd,
        repoPath: cwd,
      });
      const child = await pidIn(cwd, 'sh.pid');

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        deliver('SIGINT', before);
        expect(alive(child)).toBe(true);
        vi.runOnlyPendingTimers();
      } finally {
        vi.useRealTimers();
      }

      expect(await run.catch((error: unknown) => error)).toBeInstanceOf(GateInterruptedError);
      expect(alive(child)).toBe(false);
    });
  });

  // A directory still being written to cannot be removed whole: rmSync's
  // rmdir fails ENOTEMPTY, and a writer that recreates its path brings it back.
  describe('the scratch dir (decision 100)', () => {
    it('kills what a passed stage left running in its group', async () => {
      const cwd = fakeCheckout();

      await runGateChild('sh', ['-c', 'sleep 48.1 >/dev/null 2>&1 & echo $! > bg.pid'], {
        cwd,
        repoPath: cwd,
      });

      const straggler = await pidIn(cwd, 'bg.pid');
      await vi.waitFor(() => expect(alive(straggler)).toBe(false));
    });

    it('ends the run with a child still writing into it, and removes it whole', async () => {
      const cwd = fakeCheckout();
      const scratch = await runGateChild('sh', ['-c', 'printf %s "$TMPDIR"'], {
        cwd,
        repoPath: cwd,
      });
      const writer = runGateChild(
        'sh',
        ['-c', 'echo $$ > w.pid; i=0; while :; do i=$((i+1)); mkdir -p "$TMPDIR/d$i"; done'],
        { cwd, repoPath: cwd },
      ).catch((error: unknown) => error);
      const pid = await pidIn(cwd, 'w.pid');
      await vi.waitFor(() => expect(readdirSync(scratch).length).toBeGreaterThan(5));

      endSandboxRun();

      expect(existsSync(scratch)).toBe(false);
      expect(await writer).toMatchObject({ signal: 'SIGKILL' });
      expect(alive(pid)).toBe(false);
    });

    // The crash that opened decision 100: pup exited with a stage child still
    // writing, and its exit handler's removal threw ENOTEMPTY.
    it('leaves nothing behind when pup exits with a child still writing into it', {
      timeout: 20_000,
    }, () => {
      const tmp = tempDir('pup-exit-');
      const script = join(tmp, 'exit.mts');
      writeFileSync(
        script,
        [
          `import { readdirSync } from 'node:fs';`,
          `import { runGateChild } from ${JSON.stringify(join(process.cwd(), 'src', 'core', 'sandbox.utils.ts'))};`,
          `const cwd = ${JSON.stringify(fakeCheckout())};`,
          `const scratch = await runGateChild('sh', ['-c', 'printf %s "$TMPDIR"'], { cwd, repoPath: cwd });`,
          `void runGateChild('sh', ['-c', 'i=0; while :; do i=$((i+1)); mkdir -p "$TMPDIR/d$i"; done'], { cwd, repoPath: cwd }).catch(() => undefined);`,
          `const poll = setInterval(() => { if (readdirSync(scratch).length > 5) { clearInterval(poll); process.exit(0); } }, 10);`,
        ].join('\n'),
      );

      const run = spawnSync(process.execPath, ['--import', 'tsx', script], {
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: tmp },
        cwd: process.cwd(),
      });

      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
      expect(readdirSync(tmp).filter((name) => /^pup-(gate|sandbox)-/.test(name))).toEqual([]);
    });
  });

  it('moves aside a corepack install with an empty bin/ before the child runs', async () => {
    // The shape a half-extracted download left twice: corepack reuses the
    // directory, every stage dies on MODULE_NOT_FOUND for pnpm.cjs, and the
    // audit stored that as the baseline. A fresh TMPDIR is a fresh cache root.
    const tmp = tempDir('pup-cache-root-');
    vi.stubEnv('TMPDIR', tmp);
    const cwd = fakeCheckout();
    const pnpmDir = join(tmp, 'pup-toolchain-cache', projectId(cwd), 'corepack', 'v1', 'pnpm');
    mkdirSync(join(pnpmDir, '10.34.5', 'bin'), { recursive: true });
    mkdirSync(join(pnpmDir, '9.15.0', 'bin'), { recursive: true });
    writeFileSync(join(pnpmDir, '9.15.0', 'bin', 'pnpm.cjs'), '');

    // Checked from inside the child: the repair has to land before it runs.
    const seen = await runGateChild('ls', [pnpmDir], { cwd, repoPath: cwd });
    vi.unstubAllEnvs();

    const entries = readdirSync(pnpmDir).sort();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatch(/^10\.34\.5\.corrupt-\d+$/);
    // The control: a healthy install next to it stays where corepack looks.
    expect(entries[1]).toBe('9.15.0');
    expect(seen.trim().split('\n').sort()).toEqual(entries);
  });

  describe('off darwin (decision 78)', () => {
    it('runs nothing without the declaration', async () => {
      onPlatform('linux');
      vi.stubEnv('PUP_SANDBOX', undefined);
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      const cwd = fakeCheckout();

      await expect(
        runGateChild('sh', ['-c', 'printf x > ran'], { cwd, repoPath: cwd }),
      ).rejects.toThrow(UndeclaredSandboxError);
      expect(existsSync(join(cwd, 'ran'))).toBe(false);
    });

    it('runs the child bare under the declaration', async () => {
      onPlatform('linux');
      vi.stubEnv('PUP_SANDBOX', 'vm');
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      const cwd = fakeCheckout();

      expect(await runGateChild('sh', ['-c', 'printf ok'], { cwd, repoPath: cwd })).toBe('ok');
    });

    // Self-gating: the test stage is a child that reaches sandboxLabel() itself.
    it('hands the declaration to the child, which is in the same VM', async () => {
      onPlatform('linux');
      vi.stubEnv('PUP_SANDBOX', 'vm');
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      const cwd = fakeCheckout();

      expect(
        await runGateChild('sh', ['-c', 'printf %s "$PUP_SANDBOX"'], { cwd, repoPath: cwd }),
      ).toBe('vm');
    });
  });

  it('hands the child a var pup computed, which the operator never exported', async () => {
    // COVERAGE_FILE because it is the settable list: any other name throws
    // before a child is spawned, which gate-env's own tests pin.
    const cwd = fakeCheckout();

    const output = await runGateChild('sh', ['-c', 'printf %s "$COVERAGE_FILE"'], {
      cwd,
      repoPath: cwd,
      env: { COVERAGE_FILE: '/reports/.coverage' },
    });

    expect(output).toBe('/reports/.coverage');
  });

  describe.runIf(isSandboxSupported())('on darwin', () => {
    it('cannot read the curated secret paths that exist on this machine', async () => {
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
        await expect(runGateChild('cat', [secret], { cwd, repoPath: cwd })).rejects.toThrow(
          /Operation not permitted/,
        );
      }
      // The control: the identical command reads a file elsewhere, so the
      // failures above are the policy and not a broken invocation.
      expect(await runGateChild('cat', [join(cwd, 'ordinary')], { cwd, repoPath: cwd })).toBe(
        'aws-key',
      );
    });

    it('cannot write under HOME, and leaves nothing behind when it tries', async () => {
      const cwd = fakeCheckout();
      const target = join(homedir(), '.pup-sandbox-write-canary');

      await expect(
        runGateChild('sh', ['-c', `printf x > ${target}`], { cwd, repoPath: cwd }),
      ).rejects.toThrow();
      expect(existsSync(target)).toBe(false);
    });

    /**
     * These assert pup's *own* policy, so they only run where pup applied it:
     * under `inherited` the outer profile governs and grants a different set,
     * which is a real guarantee but not this one.
     */
    describe.runIf(sandboxLabel() === APPLIED_LABEL)('with pup own profile applied', () => {
      it('cannot write outside every granted path', async () => {
        const cwd = fakeCheckout();
        // The real TMPDIR root, which is nobody's grant — the child's own
        // TMPDIR is a subdirectory of it that pup does grant.
        const target = join(tmpdir(), 'pup-ungranted-canary');
        // A canary left by an earlier failing run must not decide this one.
        rmSync(target, { force: true });

        await expect(
          runGateChild('sh', ['-c', `printf x > ${target}`], { cwd, repoPath: cwd }),
        ).rejects.toThrow();
        expect(existsSync(target)).toBe(false);
      });

      // Started together, as the gate starts its read-only stages beside the
      // test run (decision 95): each keeps the grants it was spawned with.
      it('gives children started together each its own grants', async () => {
        const cwd = fakeCheckout();
        const granted = Array.from({ length: 6 }, () => tempDir('pup-grant-'));

        await Promise.all(
          granted.map((dir) =>
            runGateChild('sh', ['-c', `printf ok > "${dir}/mine"`], {
              cwd,
              repoPath: cwd,
              writablePaths: [dir],
            }),
          ),
        );

        for (const dir of granted) expect(readFileSync(join(dir, 'mine'), 'utf8')).toBe('ok');
      });

      it('cannot write the git directory of the checkout it measures', async () => {
        // `core.fsmonitor` in .git/config is executed by pup's own later git
        // calls, which are unsandboxed and carry the operator's environment.
        const cwd = fakeCheckout();
        mkdirSync(join(cwd, '.git'));

        await expect(
          runGateChild('sh', ['-c', 'printf x > .git/config'], { cwd, repoPath: cwd }),
        ).rejects.toThrow();
        expect(existsSync(join(cwd, '.git', 'config'))).toBe(false);
        // The control: an ordinary file in the same checkout still writes.
        await runGateChild('sh', ['-c', 'printf ok > ordinary.txt'], { cwd, repoPath: cwd });
        expect(readFileSync(join(cwd, 'ordinary.txt'), 'utf8')).toBe('ok');
      });

      it('cannot write the git directory of a checkout nested inside the grant', async () => {
        // `protectedPaths` is derived one level deep — granting P denies
        // P/.git and nothing deeper — so this .git sits inside the grant with
        // no per-path deny of its own. That is the exact shape of #49's
        // sibling-worktree attack. The regex deny covers .git at any depth,
        // which is what this asserts, on a vendored repo: `.worktrees` itself
        // is not writable at all.
        const cwd = fakeCheckout();
        const nestedGit = join(cwd, 'vendor', 'dep', '.git');
        mkdirSync(nestedGit, { recursive: true });

        await expect(
          runGateChild('sh', ['-c', 'printf x > vendor/dep/.git/config'], {
            cwd,
            repoPath: cwd,
          }),
        ).rejects.toThrow(/Operation not permitted/);
        expect(existsSync(join(nestedGit, 'config'))).toBe(false);
        // The control: an ordinary file in the same nested checkout still
        // writes, so the denial above is the .git rule and not a lost grant.
        await runGateChild('sh', ['-c', 'printf ok > vendor/dep/ordinary.txt'], {
          cwd,
          repoPath: cwd,
        });
        expect(readFileSync(join(cwd, 'vendor', 'dep', 'ordinary.txt'), 'utf8')).toBe('ok');
      });

      it('cannot move the checkout it runs in out from under its .git deny and back', async () => {
        // `pup init` and `pup audit` run the child in the operator's own repo.
        // Its grant covered its own name, so the child moved the repo into its
        // TMPDIR, where no .git rule reaches, set `core.hooksPath` and moved it
        // back: pup's next unsandboxed git call ran the hook (decision 117).
        const cwd = fakeCheckout();
        execFileSync('git', ['init', '-q', cwd], { env: GIT_ENV });
        const config = join(cwd, '.git', 'config');
        expect(existsSync(config)).toBe(true);

        await expect(
          runGateChild(
            'sh',
            [
              '-c',
              'mv "$1" "$TMPDIR/moved" && git -C "$TMPDIR/moved" config core.hooksPath /tmp/pup-hooks && mv "$TMPDIR/moved" "$1"',
              'sh',
              cwd,
            ],
            { cwd, repoPath: cwd },
          ),
        ).rejects.toThrow(/Operation not permitted/);
        // Read as a file: git would follow a GIT_DIR a pre-commit run sets.
        expect(readFileSync(config, 'utf8')).not.toContain('hooksPath');
      });

      it('cannot move or remove its scratch, its cache, or a grant above its checkout', async () => {
        // The same move through a directory above the checkout, where another
        // grant covers it, and the symlink swaps of the scratch and cache roots
        // at the source: none of these names can be freed. Each destination is
        // granted, so only the pin refuses the move.
        const outer = tempDir('pup-outer-grant-');
        const cwd = join(outer, 'repo');
        mkdirSync(cwd);
        const cache = join(realpathSync(tmpdir()), TOOLCHAIN_CACHE_DIRNAME, projectId(cwd));
        onTestFinished(() => {
          rmSync(cache, { recursive: true, force: true });
        });
        const options = { cwd, repoPath: cwd, writablePaths: [outer] };

        for (const script of [
          'mv "$1" "$TMPDIR/moved"',
          'mv "$TMPDIR" "$1/moved"',
          'mv "$2" "$1/moved"',
          'rm -r -f "$2" && ln -s "$1" "$2"',
        ]) {
          await expect(
            runGateChild('sh', ['-c', script, 'sh', outer, cache], options),
          ).rejects.toThrow(/Operation not permitted/);
        }
        expect(existsSync(cwd)).toBe(true);
        expect(lstatSync(cache).isDirectory()).toBe(true);
        // The control: below those names, moving and removing still works.
        expect(
          await runGateChild(
            'sh',
            ['-c', 'mkdir a "$TMPDIR/b" && mv a c && rmdir c "$TMPDIR/b" && printf ok'],
            options,
          ),
        ).toBe('ok');
      });

      it('cannot move a nested checkout out from under its .git deny and back', async () => {
        // The same move one level down. Moved into scratch, `.worktrees/s1`
        // had its `.git` pointer file aimed at a git dir the child wrote, and
        // moved back, it ran that dir's config on pup's next git call there
        // (decision 117). `.worktrees` is now unwritable whole; the walk pins
        // any other nested repo, a vendored one here.
        const cwd = fakeCheckout();
        const worktree = join(cwd, 'vendor', 's1');
        mkdirSync(join(cwd, 'vendor', 'plain'), { recursive: true });
        mkdirSync(worktree);
        writeFileSync(join(worktree, '.git'), 'gitdir: /repo/.git/worktrees/s1\n');

        for (const script of [
          'mv vendor/s1 "$TMPDIR/s1" && printf "gitdir: /evil" > "$TMPDIR/s1/.git" && mv "$TMPDIR/s1" vendor/s1',
          'mv vendor "$TMPDIR/vendor"',
        ]) {
          await expect(runGateChild('sh', ['-c', script], { cwd, repoPath: cwd })).rejects.toThrow(
            /Operation not permitted/,
          );
        }
        expect(readFileSync(join(worktree, '.git'), 'utf8')).toBe(
          'gitdir: /repo/.git/worktrees/s1\n',
        );
        // The control: a directory that leads to no .git still moves.
        await runGateChild('sh', ['-c', 'mv vendor/plain vendor/moved'], {
          cwd,
          repoPath: cwd,
        });
        expect(existsSync(join(cwd, 'vendor', 'moved'))).toBe(true);
      });

      it('cannot hide a nested checkout from the next profile, then move it', async () => {
        // One child makes `vendor` unreadable, so the walk behind the next
        // child's profile cannot see `s1`; the next child makes it readable
        // again and runs the same move. The unreadable directory is sealed.
        const cwd = fakeCheckout();
        const worktree = join(cwd, 'vendor', 's1');
        mkdirSync(worktree, { recursive: true });
        writeFileSync(join(worktree, '.git'), 'gitdir: /repo/.git/worktrees/s1\n');
        const options = { cwd, repoPath: cwd };

        try {
          await runGateChild('chmod', ['000', 'vendor'], options);
          await expect(
            runGateChild(
              'sh',
              [
                '-c',
                'chmod 755 vendor && mv vendor/s1 "$TMPDIR/s1" && printf "gitdir: /evil" > "$TMPDIR/s1/.git" && mv "$TMPDIR/s1" vendor/s1',
              ],
              options,
            ),
          ).rejects.toThrow(/Operation not permitted/);
        } finally {
          chmodSync(join(cwd, 'vendor'), 0o755);
        }
        expect(readFileSync(join(worktree, '.git'), 'utf8')).toBe(
          'gitdir: /repo/.git/worktrees/s1\n',
        );
      });

      it('cannot take a worktree pup adds after its profile was written, nor plant one', async () => {
        // `pup init` and `pup audit` run the child in the operator's repo while
        // pup adds worktrees there, which no walk at profile time can see: `s2`
        // appears once the child runs, and the child moves it into scratch,
        // rewrites its pointer and moves it back under a new name (decision 117).
        const cwd = fakeCheckout();
        const worktree = join(cwd, '.worktrees', 's2');
        mkdirSync(join(cwd, '.worktrees'));
        const options = { cwd, repoPath: cwd };

        // The profile is written before runGateChild returns.
        const child = runGateChild(
          'sh',
          [
            '-c',
            'i=0; until [ -f .worktrees/s2/.git ]; do i=$((i+1)); [ $i -gt 200 ] && exit 3; sleep 0.05; done; mv .worktrees/s2 "$TMPDIR/s2" && printf "gitdir: /evil" > "$TMPDIR/s2/.git" && mv "$TMPDIR/s2" .worktrees/s3',
          ],
          options,
        );
        mkdirSync(worktree);
        writeFileSync(join(worktree, '.git'), 'gitdir: /repo/.git/worktrees/s2\n');

        await expect(child).rejects.toThrow(/Operation not permitted/);
        expect(readFileSync(join(worktree, '.git'), 'utf8')).toBe(
          'gitdir: /repo/.git/worktrees/s2\n',
        );
        // A link at a name pup has yet to use, or at `.worktrees` itself before
        // pup makes it, in any case, would aim pup's next worktree at scratch.
        const fresh = fakeCheckout();
        for (const [script, dir] of [
          ['ln -s "$TMPDIR" .worktrees/s4', cwd],
          ['ln -s "$TMPDIR" .WORKTREES', fresh],
        ] as const) {
          await expect(
            runGateChild('sh', ['-c', script], { cwd: dir, repoPath: dir }),
          ).rejects.toThrow(/Operation not permitted/);
        }
        expect(existsSync(join(fresh, '.worktrees'))).toBe(false);
        // The control: the same link anywhere else in the checkout is made.
        await runGateChild('sh', ['-c', 'ln -s "$TMPDIR" elsewhere'], options);
        expect(lstatSync(join(cwd, 'elsewhere')).isSymbolicLink()).toBe(true);
      });

      it('cannot swap its checkout with a directory in its scratch, in either order', async () => {
        // `renamex_np` with RENAME_SWAP moves both names at once; each is
        // checked as a source, so neither side frees a pin. The swap is made
        // through ctypes because no shell tool makes one.
        const swap =
          'import ctypes, os, sys\n' +
          'libc = ctypes.CDLL(None, use_errno=True)\n' +
          'if libc.renamex_np(sys.argv[1].encode(), sys.argv[2].encode(), 2):\n' +
          '    sys.exit(os.strerror(ctypes.get_errno()))';
        const cwd = fakeCheckout();
        const inScratch = (pair: string) =>
          runGateChild(
            'sh',
            [
              '-c',
              `mkdir -p "$TMPDIR/d" "$TMPDIR/e" && python3 -I -B -c "$1" ${pair}`,
              'sh',
              swap,
              cwd,
            ],
            { cwd, repoPath: cwd },
          );

        await expect(inScratch('"$TMPDIR/d" "$2"')).rejects.toThrow(/Operation not permitted/);
        await expect(inScratch('"$2" "$TMPDIR/d"')).rejects.toThrow(/Operation not permitted/);
        // The control: the same swap of two names nobody pinned goes through.
        await expect(inScratch('"$TMPDIR/d" "$TMPDIR/e"')).resolves.toBe('');
      });

      it('creates a git repo in its own scratch space, where nothing is being measured', async () => {
        // The .git deny is scoped to checkout grants on purpose: a brand-new
        // repo a child creates in its own TMPDIR is not the repository being
        // measured, which is what decision 36 protects. Unscoped, the deny
        // broke `git init` in scratch — six of this repo's own test files do
        // exactly that, so pup's gate would have refused every future merge.
        const cwd = fakeCheckout();

        const output = await runGateChild(
          'sh',
          [
            '-c',
            'git init -q "$TMPDIR/fresh" && printf x > "$TMPDIR/fresh/.git/canary" && cat "$TMPDIR/fresh/.git/canary"',
          ],
          { cwd, repoPath: cwd },
        );

        expect(output).toBe('x');
      });

      it('cannot write the trusted checkout it is measured against', async () => {
        // The trusted checkout is decision 29's whole basis: writable, a build
        // stage drops `@vitest/coverage-v8` from the manifest the *next* stage
        // reads and the coverage stage stops measuring with nobody the wiser.
        // It also carried every sibling worktree's `.git` pointer file, one
        // level below the `.git` deny.
        const repoPath = fakeCheckout();
        const cwd = fakeCheckout();
        writeFileSync(join(repoPath, 'package.json'), '{"devDependencies":{}}');

        await expect(
          runGateChild('sh', ['-c', `printf {} > ${repoPath}/package.json`], { cwd, repoPath }),
        ).rejects.toThrow();
        expect(readFileSync(join(repoPath, 'package.json'), 'utf8')).toBe('{"devDependencies":{}}');
      });
    });

    it('writes in the checkout it measures and in the scratch dir the caches point at', async () => {
      const cwd = fakeCheckout();

      await runGateChild(
        'sh',
        ['-c', 'printf built > out.txt && printf cached > "$TMPDIR/blob" && cat "$TMPDIR/blob"'],
        { cwd, repoPath: cwd },
      );

      expect(readFileSync(join(cwd, 'out.txt'), 'utf8')).toBe('built');
      // TMPDIR is the redirect every denied HOME cache lands in, so a child
      // that cannot write there fails on tooling, not on the code it measures.
      expect(await runGateChild('sh', ['-c', 'cat "$TMPDIR/blob"'], { cwd, repoPath: cwd })).toBe(
        'cached',
      );
    });
  });
});

// The crash an interrupted gate ended on: a worker still writing into the
// scratch dir made the exit handler's removal throw ENOTEMPTY (decision 95).
describe('removeGateDir', () => {
  it('reports a directory it could not remove instead of throwing', () => {
    const dir = tempDir('pup-remove-test-');
    vi.mocked(rmSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOTEMPTY: directory not empty, rmdir'), {
        code: 'ENOTEMPTY',
      });
    });
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onTestFinished(() => {
      warn.mockRestore();
    });

    expect(() => removeGateDir(dir)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(`Could not remove ${dir} (ENOTEMPTY); it is left behind.`);
    expect(existsSync(dir)).toBe(true);
  });

  it('removes a directory and everything in it', () => {
    const dir = tempDir('pup-remove-test-');
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'nested', 'file'), 'x');

    removeGateDir(dir);

    expect(existsSync(dir)).toBe(false);
  });
});
