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

  const sevenDay = (used: number, resetsAt = IN_AN_HOUR) => ({
    seven_day: { used_percentage: used, resets_at: resetsAt },
  });

  it('holds at 90% of the 7-day window, naming it and its reset in UTC', () => {
    writeReading(sevenDay(90));

    expect(() => assertUsageRoom(REPO, NOW)).toThrow(
      "The plan's 7-day usage is at 90%, at or over the 90% that holds launches; nothing " +
        'was launched. It resets at 2026-11-08 13:00 UTC. Wait for it, or, as the operator, ' +
        'pass --over-limit to `pup launch` or `pup new`.',
    );
  });

  it('lets a launch through under the line', () => {
    writeReading(sevenDay(89.9));

    expect(() => assertUsageRoom(REPO, NOW)).not.toThrow();
  });

  it('never holds on a 5-hour window, which the plan no longer has', () => {
    writeReading({ five_hour: { used_percentage: 100, resets_at: IN_AN_HOUR }, ...sevenDay(10) });

    expect(() => assertUsageRoom(REPO, NOW)).not.toThrow();
  });

  it('never holds on a reading older than 30 minutes', () => {
    writeReading(sevenDay(100), 30 * 60_000 + 1000);

    expect(() => assertUsageRoom(REPO, NOW)).not.toThrow();
  });

  it('holds on a reading just under 30 minutes old', () => {
    writeReading(sevenDay(100), 29 * 60_000);

    expect(() => assertUsageRoom(REPO, NOW)).toThrow(UsageLimitReachedError);
  });

  it('never holds for a window whose reset has passed', () => {
    writeReading(sevenDay(100, NOW / 1000 - 60));

    expect(() => assertUsageRoom(REPO, NOW)).not.toThrow();
  });

  it.each([
    ['missing', undefined],
    ['not JSON', '{"seven_day":'],
    ['not an object', '[1, 2]'],
    ['a string percentage', { seven_day: { used_percentage: '99', resets_at: IN_AN_HOUR } }],
    ['a missing reset', { seven_day: { used_percentage: 99 } }],
  ])('never holds on a reading that is %s', (_, content) => {
    if (content !== undefined) writeReading(content);

    expect(() => assertUsageRoom(REPO, NOW)).not.toThrow();
  });

  it('never holds on a reading dated in the future, which would stay fresh as long as it claims', () => {
    writeReading(sevenDay(100), -10 * 60_000);

    expect(readUsage(REPO, NOW)).toBeUndefined();
    expect(() => assertUsageRoom(REPO, NOW)).not.toThrow();
  });

  it('reads a reset no Date can hold as an unknown window, crashing neither status nor launch', () => {
    writeReading(sevenDay(99, 1e13));

    expect(usageStatusLine(readUsage(REPO, NOW), NOW)).toBe('usage: 7d unknown; read 0m ago');
    expect(() => assertUsageRoom(REPO, NOW)).not.toThrow();
  });

  it('never follows a link nor opens a fifo planted as the usage file', () => {
    const elsewhere = join(dirname(usageFile()), 'elsewhere.json');
    writeFileSync(elsewhere, JSON.stringify(sevenDay(100)));
    symlinkSync(elsewhere, usageFile());

    expect(readUsage(REPO, NOW)).toBeUndefined();

    const fifo = projectPaths('/other').usageFile;
    mkdirSync(dirname(fifo), { recursive: true });
    spawnSync('mkfifo', [fifo]);
    expect(readUsage('/other', NOW)).toBeUndefined();
  });

  it('reads the 7-day window and the file age, dropping anything else', () => {
    writeReading(
      {
        five_hour: { used_percentage: 23.5, resets_at: IN_AN_HOUR },
        ...sevenDay(41.2),
        spend_limit: { used_percentage: 99 },
      },
      5 * 60_000,
    );

    expect(readUsage(REPO, NOW)).toEqual({
      writtenAt: NOW - 5 * 60_000,
      windows: { seven_day: { usedPercentage: 41.2, resetsAt: IN_AN_HOUR } },
    });
  });

  it("shows `pup status` the 7-day share and reset with the reading's age", () => {
    writeReading(sevenDay(41.2), 5 * 60_000);

    expect(usageStatusLine(readUsage(REPO, NOW), NOW)).toBe(
      'usage: 7d 41% (resets 2026-11-08 13:00 UTC); read 5m ago',
    );
  });

  it('says a stale reading holds nothing, and names a window it lacks', () => {
    writeReading({}, 45 * 60_000);

    expect(usageStatusLine(readUsage(REPO, NOW), NOW)).toBe(
      'usage: 7d unknown; read 45m ago, stale: holds nothing',
    );
  });

  it('has no line without a reading', () => {
    expect(usageStatusLine(readUsage(REPO, NOW), NOW)).toBeUndefined();
  });
});
