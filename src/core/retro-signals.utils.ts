import { basename, isAbsolute, relative } from 'node:path';

import {
  addCalls,
  addToolCarry,
  type Bucket,
  CACHE_WRITE_1H_MULTIPLIER,
  contextOf,
  percentile,
  priceOf,
  type ScannedTranscript,
  type ToolCarry,
  type UsageClass,
} from './usage-report.service.js';

// `pup retro` reads transcripts that hold prompts, command lines and tool output.
// Everything below keeps only counts, ratios, sizes, tool names and paths relative
// to the repo: the report types hold nothing else, and `serializeRetro` copies
// field by field, so a field added to a type does not reach the output by default.

const SIZE_BUCKETS = [
  { label: '<1k', max: 1_000 },
  { label: '1k-5k', max: 5_000 },
  { label: '5k-20k', max: 20_000 },
  { label: '20k+', max: Number.POSITIVE_INFINITY },
];

const REPEATED_READS = 3;
const TOP_ROWS = 10;
const CACHE_HIT_TARGET = 0.9;

export interface CarryRow {
  tool: string;
  sizeBucket: string;
  results: number;
  tokens: number;
  carriedTokens: number;
}

export interface ClassRow {
  class: UsageClass;
  transcripts: number;
  calls: number;
  contextTokens: number;
  cacheHitRate: number;
  recaches: number;
  recachedTokens: number;
  recacheCost: number;
  compactions: number;
  firstRequestFloor: number;
}

export interface RepeatedRead {
  path: string;
  sessions: number;
  reads: number;
  rereadTokens: number;
}

export interface RetroFinding {
  signal: string;
  impactTokens: number;
  evidence: string;
  why: string;
  fix: string;
}

export interface RetroReport {
  since: string;
  transcripts: number;
  findings: RetroFinding[];
  carry: CarryRow[];
  classes: ClassRow[];
  repeatedReads: RepeatedRead[];
  filesReadRepeatedly: number;
}

/** Names that reach the report come out of a transcript: keep path and tool-name characters only. */
function label(text: string): string {
  return text.replace(/[^A-Za-z0-9_:.@+/-]/g, '?').slice(0, 160);
}

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

function sizeBucket(tokens: number): string {
  return SIZE_BUCKETS.find((b) => tokens < b.max)?.label ?? '20k+';
}

/** A path inside the repo or one of its worktrees, relative to that root; outside it, the basename only. */
export function repoRelative(path: string, repoPath: string): string {
  if (!isAbsolute(path)) return label(path);
  const worktree = path.match(
    new RegExp(`^${repoPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.worktrees/[^/]+/(.+)$`),
  );
  if (worktree?.[1]) return label(worktree[1]);
  const inside = relative(repoPath, path);
  if (inside && !inside.startsWith('..') && !isAbsolute(inside)) return label(inside);
  return label(basename(path));
}

const sum = (values: number[]): number => values.reduce((n, v) => n + v, 0);

export function carryRows(scanned: ScannedTranscript[]): CarryRow[] {
  const carry = new Map<string, ToolCarry>();
  for (const { read } of scanned) addToolCarry(carry, read, sizeBucket);
  return [...carry.values()]
    .map((c) => ({
      tool: label(c.tool),
      sizeBucket: c.sizeBucket ?? '',
      results: c.results,
      tokens: c.tokens,
      carriedTokens: c.carriedTokens,
    }))
    .sort((a, b) => b.carriedTokens - a.carriedTokens);
}

export function classRows(scanned: ScannedTranscript[]): ClassRow[] {
  const buckets = new Map<string, Bucket>();
  const transcripts = new Map<UsageClass, ScannedTranscript[]>();
  for (const item of scanned) {
    addCalls(buckets, item.class, item.read);
    transcripts.set(item.class, [...(transcripts.get(item.class) ?? []), item]);
  }
  return [...transcripts.entries()]
    .map(([klass, items]) => {
      const mine = [...buckets.values()].filter((b) => b.class === klass);
      const calls = mine.flatMap((b) => b.calls);
      const context = sum(calls.map(contextOf));
      return {
        class: klass,
        transcripts: items.length,
        calls: calls.length,
        contextTokens: context,
        cacheHitRate: context > 0 ? sum(calls.map((c) => c.read)) / context : 0,
        recaches: sum(mine.map((b) => b.recaches)),
        recachedTokens: sum(mine.map((b) => b.recachedTokens)),
        recacheCost: sum(
          mine.map(
            (b) =>
              (b.recachedTokens * (priceOf(b.model)?.input ?? 0) * CACHE_WRITE_1H_MULTIPLIER) / 1e6,
          ),
        ),
        compactions: sum(items.map(({ read }) => read.compactions)),
        firstRequestFloor: percentile(
          mine.flatMap((b) => b.floors),
          0.5,
        ),
      };
    })
    .sort((a, b) => b.calls - a.calls);
}

/** Files one session read at least `REPEATED_READS` times, summed over sessions, with the tokens past the first read. */
export function repeatedReads(
  scanned: ScannedTranscript[],
  repoPath: string,
): { rows: RepeatedRead[]; files: number } {
  const byPath = new Map<string, RepeatedRead>();
  let files = 0;
  for (const { read } of scanned) {
    const perFile = new Map<string, number[]>();
    for (const { path, tokens } of read.reads) {
      const key = repoRelative(path, repoPath);
      perFile.set(key, [...(perFile.get(key) ?? []), tokens]);
    }
    for (const [path, sizes] of perFile) {
      if (sizes.length < REPEATED_READS) continue;
      files += 1;
      const row = byPath.get(path) ?? { path, sessions: 0, reads: 0, rereadTokens: 0 };
      row.sessions += 1;
      row.reads += sizes.length;
      row.rereadTokens += sum(sizes) - (sizes[0] ?? 0);
      byPath.set(path, row);
    }
  }
  const rows = [...byPath.values()].sort((a, b) => b.rereadTokens - a.rereadTokens);
  return { rows: rows.slice(0, TOP_ROWS), files };
}

const SMALL_BUCKETS = new Set(['<1k', '1k-5k']);

/** A small result costs by its count and a large one by its size, so the fix differs. */
function fixFor(row: CarryRow): string {
  if (SMALL_BUCKETS.has(row.sizeBucket)) {
    return `fewer ${row.tool} calls: batch the commands or ask for quiet output, since each result stays in the context`;
  }
  if (row.tool === 'Read')
    return 'read with offset and limit, or search first, instead of the whole file';
  return `warn on a ${row.tool} result over 10k characters (the tool-result-size hook) and tail or grep it instead`;
}

function carryFinding(row: CarryRow): RetroFinding {
  return {
    signal: 'carried tool output',
    impactTokens: row.carriedTokens,
    evidence: `${row.tool} results of ${row.sizeBucket} tokens: ${row.results} results, ${row.tokens} tokens, carried ${row.carriedTokens} tokens over the later requests`,
    why: 'every later request of the session reads this output again from the cache',
    fix: fixFor(row),
  };
}

function classFindings(row: ClassRow): RetroFinding[] {
  const found: RetroFinding[] = [];
  if (row.recaches > 0) {
    found.push({
      signal: 'cache re-written after an idle hour',
      impactTokens: row.recachedTokens,
      evidence: `${row.class}: ${row.recaches} re-caches, ${row.recachedTokens} tokens written again (about ${row.recacheCost.toFixed(2)} USD)`,
      why: 'a request after more than an hour idle finds the cache expired and pays the write price for the whole context',
      fix: 'respawn a session that will idle past the hour on a fresh window, or keep it from idling with a held prompt',
    });
  }
  if (row.compactions > 0) {
    found.push({
      signal: 'context compactions',
      impactTokens: row.compactions * row.firstRequestFloor,
      evidence: `${row.class}: ${row.compactions} compactions, median first-request context ${Math.round(row.firstRequestFloor)} tokens`,
      why: 'a compaction rewrites the summary and rebuilds the cache, and the work after it starts from a lossy context',
      fix: 'split the task earlier or lower the compaction threshold for this class',
    });
  }
  if (row.calls > 0 && row.cacheHitRate < CACHE_HIT_TARGET) {
    found.push({
      signal: 'low cache hit rate',
      impactTokens: Math.round((CACHE_HIT_TARGET - row.cacheHitRate) * row.contextTokens),
      evidence: `${row.class}: cache hit ${(row.cacheHitRate * 100).toFixed(1)}% over ${row.calls} calls`,
      why: 'context not read from the cache is billed at the full input or write price',
      fix: 'look for a prefix that changes between requests (system prompt, tool order, injected timestamps)',
    });
  }
  return found;
}

function findingsOf(
  carry: CarryRow[],
  classes: ClassRow[],
  reads: { rows: RepeatedRead[]; files: number },
): RetroFinding[] {
  const found = carry.slice(0, 3).map(carryFinding);
  const reread = sum(reads.rows.map((r) => r.rereadTokens));
  if (reads.files > 0) {
    found.push({
      signal: 'files read repeatedly',
      impactTokens: reread,
      evidence: `${reads.files} file reads of the same file ${REPEATED_READS}+ times in one session, ${reread} tokens read again in the top ${reads.rows.length}`,
      why: 'each read adds the file to the context again',
      fix: 'keep the part of the file that matters in the working notes, or read with offset and limit',
    });
  }
  found.push(...classes.flatMap(classFindings));
  return found.sort((a, b) => b.impactTokens - a.impactTokens);
}

export function buildRetroReport(
  scanned: ScannedTranscript[],
  repoPath: string,
  since: Date,
): RetroReport {
  const carry = carryRows(scanned);
  const classes = classRows(scanned);
  const reads = repeatedReads(scanned, repoPath);
  return {
    since: since.toISOString(),
    transcripts: scanned.length,
    findings: findingsOf(carry, classes, reads),
    carry: carry.slice(0, TOP_ROWS),
    classes,
    repeatedReads: reads.rows,
    filesReadRepeatedly: reads.files,
  };
}

/** Field-by-field copy: the one place the output is composed, so nothing else leaks by default. */
export function serializeRetro(report: RetroReport): string {
  return JSON.stringify(
    {
      since: label(report.since),
      transcripts: finite(report.transcripts),
      filesReadRepeatedly: finite(report.filesReadRepeatedly),
      findings: report.findings.map((f) => ({
        signal: f.signal,
        impactTokens: finite(f.impactTokens),
        evidence: f.evidence,
        why: f.why,
        fix: f.fix,
      })),
      carry: report.carry.map((r) => ({
        tool: label(r.tool),
        sizeBucket: r.sizeBucket,
        results: finite(r.results),
        tokens: finite(r.tokens),
        carriedTokens: finite(r.carriedTokens),
      })),
      classes: report.classes.map((c) => ({
        class: c.class,
        transcripts: finite(c.transcripts),
        calls: finite(c.calls),
        contextTokens: finite(c.contextTokens),
        cacheHitRate: finite(c.cacheHitRate),
        recaches: finite(c.recaches),
        recachedTokens: finite(c.recachedTokens),
        recacheCost: finite(c.recacheCost),
        compactions: finite(c.compactions),
        firstRequestFloor: finite(c.firstRequestFloor),
      })),
      repeatedReads: report.repeatedReads.map((r) => ({
        path: label(r.path),
        sessions: finite(r.sessions),
        reads: finite(r.reads),
        rereadTokens: finite(r.rereadTokens),
      })),
    },
    null,
    2,
  );
}

export function formatRetro(report: RetroReport): string {
  const out = [
    `# Retro since ${report.since.slice(0, 10)}`,
    '',
    `${report.transcripts} transcripts read. Counts and sizes only: no tool output, prompt or command appears here.`,
    '',
    '## Findings, biggest first',
    '',
  ];
  report.findings.forEach((f, i) => {
    out.push(
      `${i + 1}. **${f.signal}** (${f.impactTokens} tokens)`,
      `   - ${f.evidence}`,
      `   - why: ${f.why}`,
      `   - candidate fix: ${f.fix}`,
    );
  });
  out.push('', '## Tool output carried, by size', '');
  for (const r of report.carry)
    out.push(
      `- ${r.tool} ${r.sizeBucket}: ${r.results} results, carried ${r.carriedTokens} tokens`,
    );
  out.push('', '## By session class', '');
  for (const c of report.classes) {
    out.push(
      `- ${c.class}: ${c.calls} calls, cache hit ${(c.cacheHitRate * 100).toFixed(1)}%, ${c.recaches} re-caches, ${c.compactions} compactions, first-request floor ${Math.round(c.firstRequestFloor)}`,
    );
  }
  out.push('', `## Files read ${REPEATED_READS}+ times in one session`, '');
  for (const r of report.repeatedReads)
    out.push(
      `- ${r.path}: ${r.reads} reads in ${r.sessions} sessions, ${r.rereadTokens} tokens read again`,
    );
  return out.join('\n');
}
