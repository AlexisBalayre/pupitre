import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectPaths } from './paths.utils.js';
import {
  assertUsageRoom,
  readUsage,
  UsageLimitReachedError,
  usageStatusLine,
} from './usage-limits.service.js';

const REPO = '/repo';
const NOW = Date.UTC(2026, 10, 8, 12, 0);
const IN_AN_HOUR = NOW / 1000 + 3600;

describe('the plan usage hold (decision 156)', () => {
  beforeEach(() => {
    vi.stubEnv('HOME', tempDir('pup-usage-'));
    mkdirSync(dirname(usageFile()), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const usageFile = (): string => projectPaths(REPO).usageFile;

  /** Writes `content` as the status line would, `ageMs` before NOW. */
  function writeReading(content: unknown, ageMs = 0): void {
    writeFileSync(usageFile(), typeof content === 'string' ? content : JSON.stringify(content));
    const at = (NOW - ageMs) / 1000;
    utimesSync(usageFile(), at, at);
  }

  const windows = (fiveHour: number, sevenDay: number, resetsAt = IN_AN_HOUR) => ({
    five_hour: { used_percentage: fiveHour, resets_at: resetsAt },
    seven_day: { used_percentage: sevenDay, resets_at: resetsAt + 86_400 },
  });

  it('holds at 85% of the 5-hour window, naming it and its reset in UTC', () => {
    writeReading(windows(85, 10));

    expect(() => assertUsageRoom(REPO, NOW)).toThrow(
      "The plan's 5-hour usage is at 85%, at or over the 85% that holds launches; nothing " +
        'was launched. It resets at 2026-11-08 13:00 UTC. Wait for it, or, as the operator, ' +
        'pass --over-limit to `pup launch` or `pup new`.',
    );
  });

  it('holds at 90% of the 7-day window', () => {
    writeReading(windows(10, 90));

    expect(() => assertUsageRoom(REPO, NOW)).toThrow(/The plan's 7-day usage is at 90%/);
  });

  it('lets a launch through under both lines', () => {
    writeReading(windows(84.9, 89.9));

    expect(() => assertUsageRoom(REPO, NOW)).not.toThrow();
  });

  it('never holds on a reading older than 30 minutes', () => {
    writeReading(windows(100, 100), 30 * 60_000 + 1000);

    expect(() => assertUsageRoom(REPO, NOW)).not.toThrow();
  });

  it('holds on a reading just under 30 minutes old', () => {
    writeReading(windows(100, 10), 29 * 60_000);

    expect(() => assertUsageRoom(REPO, NOW)).toThrow(UsageLimitReachedError);
  });

  it('never holds for a window whose reset has passed', () => {
    writeReading(windows(100, 10, NOW / 1000 - 60));

    expect(() => assertUsageRoom(REPO, NOW)).not.toThrow();
  });

  it.each([
    ['missing', undefined],
    ['not JSON', '{"five_hour":'],
    ['not an object', '[1, 2]'],
    ['a string percentage', { five_hour: { used_percentage: '99', resets_at: IN_AN_HOUR } }],
    ['a missing reset', { five_hour: { used_percentage: 99 } }],
  ])('never holds on a reading that is %s', (_, content) => {
    if (content !== undefined) writeReading(content);

    expect(() => assertUsageRoom(REPO, NOW)).not.toThrow();
  });

  it('never holds on a reading dated in the future, which would stay fresh as long as it claims', () => {
    writeReading(windows(100, 100), -10 * 60_000);

    expect(readUsage(REPO, NOW)).toBeUndefined();
    expect(() => assertUsageRoom(REPO, NOW)).not.toThrow();
  });

  it('reads a reset no Date can hold as an unknown window, crashing neither status nor launch', () => {
    writeReading({
      five_hour: { used_percentage: 99, resets_at: 1e13 },
      seven_day: { used_percentage: 95, resets_at: IN_AN_HOUR },
    });

    expect(usageStatusLine(readUsage(REPO, NOW), NOW)).toBe(
      'usage: 7d 95% (resets 2026-11-08 13:00 UTC); read 0m ago',
    );
    // The 7-day window still holds, with a one-line refusal rather than a RangeError.
    expect(() => assertUsageRoom(REPO, NOW)).toThrow(UsageLimitReachedError);
    expect(() => assertUsageRoom(REPO, NOW)).toThrow(/The plan's 7-day usage is at 95%/);

    writeReading({ five_hour: { used_percentage: 99, resets_at: 1e13 } }, 45 * 60_000);
    expect(usageStatusLine(readUsage(REPO, NOW), NOW)).toBe(
      'usage: 7d unknown; read 45m ago, stale: holds nothing',
    );
    expect(() => assertUsageRoom(REPO, NOW)).not.toThrow();
  });

  it('never follows a link nor opens a fifo planted as the usage file', () => {
    const elsewhere = join(dirname(usageFile()), 'elsewhere.json');
    writeFileSync(elsewhere, JSON.stringify(windows(100, 100)));
    symlinkSync(elsewhere, usageFile());

    expect(readUsage(REPO, NOW)).toBeUndefined();

    const fifo = projectPaths('/other').usageFile;
    mkdirSync(dirname(fifo), { recursive: true });
    spawnSync('mkfifo', [fifo]);
    expect(readUsage('/other', NOW)).toBeUndefined();
  });

  it('reads the windows and the file age, dropping anything else', () => {
    writeReading({ ...windows(23.5, 41.2), spend_limit: { used_percentage: 99 } }, 5 * 60_000);

    expect(readUsage(REPO, NOW)).toEqual({
      writtenAt: NOW - 5 * 60_000,
      windows: {
        five_hour: { usedPercentage: 23.5, resetsAt: IN_AN_HOUR },
        seven_day: { usedPercentage: 41.2, resetsAt: IN_AN_HOUR + 86_400 },
      },
    });
  });

  it("shows `pup status` both windows' shares and resets with the reading's age", () => {
    writeReading(windows(23.5, 41.2), 5 * 60_000);

    expect(usageStatusLine(readUsage(REPO, NOW), NOW)).toBe(
      'usage: 5h 23% (resets 2026-11-08 13:00 UTC), 7d 41% (resets 2026-11-09 13:00 UTC); ' +
        'read 5m ago',
    );
  });

  it('says a stale reading holds nothing, and names a window it lacks', () => {
    writeReading({ seven_day: windows(0, 95).seven_day }, 45 * 60_000);

    expect(usageStatusLine(readUsage(REPO, NOW), NOW)).toBe(
      'usage: 7d 95% (resets 2026-11-09 13:00 UTC); read 45m ago, stale: holds nothing',
    );
  });

  it('never holds nor shows a 5-hour window the plan does not report', () => {
    writeReading({ seven_day: windows(0, 50).seven_day });

    expect(() => assertUsageRoom(REPO, NOW)).not.toThrow();
    expect(usageStatusLine(readUsage(REPO, NOW), NOW)).not.toMatch(/5h/);
  });

  it('has no line without a reading', () => {
    expect(usageStatusLine(readUsage(REPO, NOW), NOW)).toBeUndefined();
  });
});
