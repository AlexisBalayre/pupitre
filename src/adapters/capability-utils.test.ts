import { describe, expect, it } from 'vitest';
import {
  brokenPackageManagerInstall,
  failureSummary,
  isUnavailable,
  localContext,
  sanitizeReason,
} from './capability.utils.js';

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
