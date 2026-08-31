/**
 * JSON.parse that returns `fallback` for a malformed or type-confused store
 * column — the store is session-writable, and one bad row must degrade to the
 * page's empty copy, not kill `pup report` with a stack trace.
 */
export function parseJsonOr<T>(text: string, fallback: T): T {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' ? (value as T) : fallback;
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
 * Shape guard for gate stages read back from an event payload: `Array.isArray`
 * on the container says nothing about the members, and one `null` element (or
 * a stage with no `status`) written by a session must drop out of the render,
 * not kill `pup report` server-side or blank the page in the browser. Members
 * pass through `displayText` — stage details are gate-written prose.
 */
export function asStageArray(
  value: unknown,
): { stage: string; status: string; detail: string | null }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((member: unknown) => {
    if (member === null || typeof member !== 'object') return [];
    const stage = member as { stage?: unknown; status?: unknown; detail?: unknown };
    if (typeof stage.stage !== 'string' || typeof stage.status !== 'string') return [];
    return [
      {
        stage: displayText(stage.stage),
        status: displayText(stage.status),
        detail: typeof stage.detail === 'string' ? displayText(stage.detail) : null,
      },
    ];
  });
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
