import type { USAGE_WINDOWS } from '../constants/usage-limits.constants.js';

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
