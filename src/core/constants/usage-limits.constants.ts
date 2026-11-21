/**
 * The plan's usage windows a launch is held for (decision 156), as Claude
 * Code's statusline JSON names them under `rate_limits`, with the share of
 * each at which `pup launch` and `pup new` stop starting windows. Only the 7-day
 * window is on every plan; a plan that has no 5-hour window reports none, and
 * a missing window never holds nor reads as unknown.
 */
export const USAGE_WINDOWS = [
  { key: 'five_hour', label: '5-hour', short: '5h', holdAt: 85 },
  { key: 'seven_day', label: '7-day', short: '7d', holdAt: 90 },
] as const;
