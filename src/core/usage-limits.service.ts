import { lstatSync } from 'node:fs';
import { readPlainFile } from '../adapters/capability.utils.js';
import { projectPaths } from './paths.utils.js';

/**
 * The plan's usage windows a launch is held for (decision 156), as Claude
 * Code's statusline JSON names them under `rate_limits`, with the share of
 * each at which `pup launch` and `pup new` stop starting windows.
 */
export const USAGE_WINDOWS = [
  { key: 'five_hour', label: '5-hour', short: '5h', holdAt: 85 },
  { key: 'seven_day', label: '7-day', short: '7d', holdAt: 90 },
] as const;

/** A reading older than this says nothing about now: it counts as unknown and never holds. */
export const USAGE_FRESH_MS = 30 * 60_000;

/**
 * How far ahead of this machine's clock a reading's mtime may be. A window
 * writes the file on the same clock, so only a hand-set one is further ahead,
 * and it would otherwise stay fresh for as long as it claims.
 */
const CLOCK_SKEW_MS = 60_000;

type UsageWindowKey = (typeof USAGE_WINDOWS)[number]['key'];

/** One window's share used, 0 to 100, and when it resets, in epoch seconds. */
export interface UsageWindow {
  usedPercentage: number;
  resetsAt: number;
}

/** The latest reading a window's status line wrote; `writtenAt` is the file's mtime, in epoch ms. */
export interface UsageReading {
  writtenAt: number;
  windows: Partial<Record<UsageWindowKey, UsageWindow>>;
}

/** A launch refused because a fresh reading puts one of the plan's windows at its hold line. */
export class UsageLimitReachedError extends Error {
  constructor(label: string, used: number, holdAt: number, resetsAt: number) {
    super(
      `The plan's ${label} usage is at ${Math.floor(used)}%, at or over the ${holdAt}% that ` +
        `holds launches; nothing was launched. It resets at ${resetTime(resetsAt)}. Wait for ` +
        'it, or, as the operator, pass --over-limit to `pup launch` or `pup new`.',
    );
    this.name = 'UsageLimitReachedError';
  }
}

/** A reset time as UTC to the minute, so every reader of a message sees the same text. */
function resetTime(resetsAt: number): string {
  return `${new Date(resetsAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asWindow(raw: unknown): UsageWindow | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const { used_percentage: used, resets_at: resets } = raw as Record<string, unknown>;
  if (!(isFiniteNumber(used) && isFiniteNumber(resets))) return undefined;
  return { usedPercentage: used, resetsAt: resets };
}

/**
 * The project's latest usage reading, whatever its age; undefined when there is
 * none or the file is not one the status line writes. Any window can write the
 * file, so nothing in it is trusted beyond being two numbers per window.
 */
export function readUsage(repoPath: string, now: number): UsageReading | undefined {
  const file = projectPaths(repoPath).usageFile;
  let parsed: unknown;
  let writtenAt: number;
  try {
    // Never a link followed nor a fifo opened to block on, as `maxSessions` reads its file.
    parsed = JSON.parse(readPlainFile(file, { followLinks: false }));
    writtenAt = lstatSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  if (writtenAt > now + CLOCK_SKEW_MS) return undefined;
  const record = parsed as Record<string, unknown>;
  const windows: UsageReading['windows'] = {};
  for (const { key } of USAGE_WINDOWS) {
    const window = asWindow(record[key]);
    if (window) windows[key] = window;
  }
  return { writtenAt, windows };
}

/**
 * Refuse a launch while a fresh reading puts a window at its hold line
 * (decision 156). A stale, missing or malformed reading never holds, nor does
 * a window whose reset has passed: the reading cannot speak for the window
 * that replaced it.
 */
export function assertUsageRoom(repoPath: string, now: number): void {
  const reading = readUsage(repoPath, now);
  if (!reading || now - reading.writtenAt > USAGE_FRESH_MS) return;
  for (const { key, label, holdAt } of USAGE_WINDOWS) {
    const window = reading.windows[key];
    if (window && window.resetsAt * 1000 > now && window.usedPercentage >= holdAt) {
      throw new UsageLimitReachedError(label, window.usedPercentage, holdAt, window.resetsAt);
    }
  }
}

/**
 * `pup status`'s usage line: each window's share and reset, and the reading's
 * age. None without a reading: a plan with no usage windows never writes one.
 */
export function usageStatusLine(
  reading: UsageReading | undefined,
  now: number,
): string | undefined {
  if (!reading) return undefined;
  const parts = USAGE_WINDOWS.map(({ key, short }) => {
    const window = reading.windows[key];
    return window
      ? `${short} ${Math.floor(window.usedPercentage)}% (resets ${resetTime(window.resetsAt)})`
      : `${short} unknown`;
  });
  const minutes = Math.max(0, Math.round((now - reading.writtenAt) / 60_000));
  const stale = now - reading.writtenAt > USAGE_FRESH_MS ? ', stale: holds nothing' : '';
  return `usage: ${parts.join(', ')}; read ${minutes}m ago${stale}`;
}
