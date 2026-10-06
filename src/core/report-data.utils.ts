import type { StoredGateStage } from './types/session-event.types.js';

/**
 * JSON.parse that returns `fallback` for a malformed or type-confused store
 * column — the store is session-writable, and one bad row must degrade to the
 * page's empty copy, not kill `pup report` with a stack trace.
 */
export function parseJsonOr<TParsed>(text: string, fallback: TParsed): TParsed {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' ? (value as TParsed) : fallback;
  } catch {
    return fallback;
  }
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * Store prose is agent-written and lands in the report pages verbatim, so a
 * committed filename or summary carrying bidi overrides could repaint what the
 * operator reads (a U+202E makes `st.esac_tset.ts` read as a test file) — the
 * same class decision 29 blocks for the terminal sink, which this HTML sink
 * never went through. Replaces C0/C1 controls and Unicode direction/format
 * marks with U+FFFD, but keeps tab, LF and CR: goals are multi-line prose the
 * pages render with `white-space: pre-wrap`.
 */
export function displayText(value: string): string {
  return value.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    '\uFFFD',
  );
}

/**
 * Gate stages as both report pages embed them, through `displayText` — stage
 * details are gate-written prose. A stage without a detail embeds `null`, so
 * the page has one shape to render.
 */
export function displayStages(
  stages: StoredGateStage[],
): { stage: string; status: string; detail: string | null }[] {
  return stages.map(({ stage, status, detail }) => ({
    stage: displayText(stage),
    status: displayText(status),
    detail: detail === undefined ? null : displayText(detail),
  }));
}

/**
 * One decision record as both report pages embed it, so the two JSON blocks
 * cannot drift apart. Structurally typed rather than importing
 * `DecisionRecordRow`: utils files do not import repositories. The index
 * spreads in the `sessionId` it alone shows.
 */
export function decisionRecordDatum(record: {
  id: number;
  summary: string;
  alternatives: string | null;
  conventions: string | null;
  files: string;
  created_at: string;
}): {
  id: number;
  summary: string;
  alternatives: string | null;
  conventions: string | null;
  files: string[];
  createdAt: string;
} {
  return {
    id: record.id,
    summary: displayText(record.summary),
    alternatives: record.alternatives === null ? null : displayText(record.alternatives),
    conventions: record.conventions === null ? null : displayText(record.conventions),
    files: asStringArray(parseJsonOr<unknown>(record.files, [])).map(displayText),
    createdAt: toIsoUtc(record.created_at),
  };
}

/**
 * SQLite's `datetime('now')` columns hold UTC as `2026-08-03 12:36:05` — no
 * zone marker, which JavaScript's Date would parse as LOCAL time and shift by
 * the viewer's offset. Rewrite that form to ISO UTC (`2026-08-03T12:36:05Z`)
 * so every timestamp in the data block means the same instant.
 * `baseline_history.captured_at` is already a real ISO string with a Z and
 * passes through unchanged.
 */
export function toIsoUtc(timestamp: string): string {
  return /^\d{4}-\d{2}-\d{2} /.test(timestamp) ? `${timestamp.replace(' ', 'T')}Z` : timestamp;
}
