/**
 * Risk-score weights (docs/02-cli.md). v1 uses the signals the store already
 * has: diff size, logged scope violations, live-session overlap, past
 * rejections. Coverage and debt deltas join in v1.1.
 */
export const RISK_WEIGHT_PER_100_LINES = 1;
export const RISK_WEIGHT_SCOPE_VIOLATION = 3;
export const RISK_WEIGHT_OVERLAP = 2;
export const RISK_WEIGHT_REJECTION = 2;
