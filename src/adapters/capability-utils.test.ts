import { describe, expect, it } from 'vitest';
import { failureSummary, isUnavailable, localContext, sanitizeReason } from './capability.utils.js';

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
