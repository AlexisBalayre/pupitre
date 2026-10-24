import { execFileSync } from 'node:child_process';
import { existsSync, fstatSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../test/temp-dir.mock.js';
import {
  brokenPackageManagerInstall,
  failureSummary,
  isUnavailable,
  localContext,
  readPlainFile,
  sanitizeReason,
} from './capability.utils.js';

// Real unless a test makes a file report a size it does not hold.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fstatSync: vi.fn(actual.fstatSync) };
});

describe('isUnavailable', () => {
  it('separates a reason from a real measurement', () => {
    expect(isUnavailable({ unavailable: 'no vulture declared' })).toBe(true);
    expect(isUnavailable([{ file: 'src/a.ts', exportName: 'orphan' }])).toBe(false);
    expect(isUnavailable({ files: {} })).toBe(false);
  });

  it('treats an empty measurement as a measurement, not as unavailable', () => {
    // The distinction the debt ratchet rests on: [] means "measured, nothing
    // found" and becomes a baseline; unavailable means the bar cannot move.
    expect(isUnavailable([])).toBe(false);
  });

  it('survives the values a custom adapter can print, without throwing mid-gate', () => {
    // A capability's JSON is untrusted input; `'unavailable' in null` throws.
    expect(isUnavailable(null)).toBe(false);
    expect(isUnavailable(undefined)).toBe(false);
    expect(isUnavailable(42)).toBe(false);
    expect(isUnavailable('unavailable')).toBe(false);
    expect(isUnavailable({ unavailable: { nested: true } })).toBe(false);
  });
});

describe('localContext', () => {
  it('measures and reads config from the same checkout', () => {
    expect(localContext('/repo')).toEqual({ measurePath: '/repo', configPath: '/repo' });
  });
});

describe('failureSummary', () => {
  it('prefers stderr, where a failing tool says why', () => {
    expect(failureSummary({ stderr: 'vulture: command not found', stdout: 'noise' })).toBe(
      'vulture: command not found',
    );
  });

  it('collapses newlines so a stage detail stays one row', () => {
    expect(failureSummary({ stderr: 'Traceback:\n  line 1\n  line 2' })).toBe(
      'Traceback: line 1 line 2',
    );
  });

  it('falls back through stdout and message to a generic reason', () => {
    expect(failureSummary({ stdout: 'only stdout' })).toBe('only stdout');
    expect(failureSummary(new Error('spawn ENOENT'))).toBe('spawn ENOENT');
    expect(failureSummary({})).toBe('command failed');
  });

  it('caps a runaway dump so one stage cannot swamp the report', () => {
    expect(failureSummary({ stderr: 'x'.repeat(5000) }).length).toBe(300);
  });
});

describe('sanitizeReason', () => {
  it('strips ANSI escapes, which could repaint a FLAGGED row as PASS', () => {
    expect(sanitizeReason('\u001b[1A\u001b[2Kdead-code PASS')).toBe('[1A [2Kdead-code PASS');
  });

  it('strips the C1 range and stray control characters too', () => {
    expect(sanitizeReason('a\u0007b\u0008c\u009bd')).toBe('a b c d');
  });

  it('collapses a closing fence onto one line, so a PR body cannot break out', () => {
    expect(sanitizeReason('boom\n````\n<img src=x onerror=alert(1)>')).toBe(
      'boom ```` <img src=x onerror=alert(1)>',
    );
  });

  it('caps by code point, never severing a surrogate pair', () => {
    const capped = sanitizeReason('🙂'.repeat(400));
    expect([...capped]).toHaveLength(300);
    expect(capped.endsWith('🙂')).toBe(true);
  });
});

describe('readPlainFile', () => {
  it('reads a regular file, through a link unless told not to follow one', () => {
    const dir = tempDir('pup-plain-');
    writeFileSync(join(dir, 'config.json'), '{"a":1}');
    symlinkSync(join(dir, 'config.json'), join(dir, 'link.json'));

    expect(readPlainFile(join(dir, 'config.json'))).toBe('{"a":1}');
    expect(readPlainFile(join(dir, 'link.json'))).toBe('{"a":1}');
    expect(() => readPlainFile(join(dir, 'link.json'), { followLinks: false })).toThrow(
      expect.objectContaining({ code: 'ELOOP' }),
    );
  });

  it('refuses a fifo without blocking on it, and a file past the size cap', () => {
    const dir = tempDir('pup-plain-');
    execFileSync('mkfifo', [join(dir, 'fifo')]);
    writeFileSync(join(dir, 'big'), 'x'.repeat((1 << 20) + 1));

    expect(() => readPlainFile(join(dir, 'fifo'))).toThrow('is not a plain file');
    expect(() => readPlainFile(join(dir, 'big'))).toThrow('is not a plain file');
  });

  it('stops at the size cap on a file that reports less than it holds', () => {
    const file = join(tempDir('pup-plain-'), 'streams');
    writeFileSync(file, 'x'.repeat(2 << 20));
    const actual = vi.mocked(fstatSync).getMockImplementation() as typeof fstatSync;
    vi.mocked(fstatSync).mockImplementationOnce(((fd: number) =>
      Object.assign(actual(fd), { size: 0 })) as typeof fstatSync);

    expect(() => readPlainFile(file)).toThrow('is not a plain file');
  });

  // Regular and sized 0, yet it streams 8 bytes per page of the reader's own
  // address space: a read to EOF would never end.
  it.runIf(existsSync('/proc/self/pagemap'))(
    'refuses a procfs file that reports size 0, at the size cap or on the read',
    () => {
      // No Linux runner checks which the kernel gives, so either refusal passes.
      expect(() => readPlainFile('/proc/self/pagemap')).toThrow(/is not a plain file|EINVAL/);
    },
  );
});

describe('brokenPackageManagerInstall', () => {
  const install = '/var/folders/x/T/pup-toolchain-cache/ff2f27df5be3/corepack/v1/pnpm/10.34.5';

  /** Node's banner for a missing entrypoint, as a gate stage's output tail carries it. */
  function crash(path: string, requireStack = '[]'): string {
    return [
      'node:internal/modules/cjs/loader:1386',
      '  throw err;',
      '  ^',
      '',
      `Error: Cannot find module '${path}'`,
      '    at Function._resolveFilename (node:internal/modules/cjs/loader:1383:15)',
      '    at node:internal/main/run_main_module:36:49 {',
      "  code: 'MODULE_NOT_FOUND',",
      `  requireStack: ${requireStack}`,
      '}',
      '',
      'Node.js v24.13.1',
    ].join('\n');
  }

  it('names the corepack install when the package manager itself cannot load', () => {
    expect(brokenPackageManagerInstall(crash(`${install}/bin/pnpm.cjs`))).toBe(install);
  });

  it('leaves a missing module the project required to the stage result', () => {
    // A require stack means the entrypoint ran: that failure is the checkout's.
    const required = crash(`${install}/bin/pnpm.cjs`, "[ '/repo/src/index.js' ]");
    expect(brokenPackageManagerInstall(required)).toBeUndefined();
    expect(brokenPackageManagerInstall(crash('/repo/dist/cli.js'))).toBeUndefined();
  });

  it('ignores an ordinary failing stage', () => {
    expect(brokenPackageManagerInstall('FAIL src/a.test.ts\nTests 1 failed')).toBeUndefined();
  });
});
