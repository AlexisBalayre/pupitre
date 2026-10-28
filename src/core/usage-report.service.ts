import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';

import { transcriptDir } from '../claude/session-runtime.service.js';
import { listSessions } from './session.repository.js';

// `pup usage` reads the transcripts Claude Code already writes and prints where
// the usage went, so the cache analysis of 2026-10-28 can be repeated rather
// than recalled. It writes nothing: the transcripts and the sessions table are
// only read.

export enum UsageClass {
  Worker = 'worker',
  Conductor = 'conductor',
  Console = 'console',
  Subagent = 'subagent',
  Utility = 'utility',
}

/** Dollars per million tokens, uncached input and output, by model id prefix. */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-5': { input: 1, output: 5 },
};

/** What a cached token costs, as a multiple of the model's uncached input price. */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2;

/** A request after a gap longer than this finds its cache expired (the 1h tier). */
export const IDLE_RECACHE_MS = 60 * 60 * 1000;

/** Tool output is sized at this many characters per token; the transcript holds no count. */
const CHARS_PER_TOKEN = 4;

export interface UsageRow {
  class: UsageClass;
  model: string;
  effort: string;
  calls: number;
  cost: number;
  costShare: number;
  cacheHitRate: number;
  cacheReadCostShare: number;
  cacheWriteCostShare: number;
  outputCostShare: number;
  medianContext: number;
  p90Context: number;
  firstRequestFloor: number;
  recaches: number;
  recachedTokens: number;
}

export interface ToolCarry {
  tool: string;
  results: number;
  tokens: number;
  carriedTokens: number;
}

export interface UsageReport {
  since: string;
  totalCost: number;
  byClass: { class: UsageClass; calls: number; cost: number; costShare: number }[];
  rows: UsageRow[];
  toolCarry: ToolCarry[];
  unpricedModels: string[];
}

export interface UsageOptions {
  since: Date;
  claudeDir?: string;
}

interface Call {
  at: number;
  model: string;
  effort: string;
  input: number;
  read: number;
  write5m: number;
  write1h: number;
  output: number;
}

interface Bucket {
  class: UsageClass;
  model: string;
  effort: string;
  calls: Call[];
  floors: number[];
  recaches: number;
  recachedTokens: number;
}

interface ToolResult {
  tool: string;
  tokens: number;
  callsAfter: number;
}

interface TranscriptEntry {
  type?: string;
  timestamp?: string;
  requestId?: string;
  effort?: string;
  message?: {
    id?: string;
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
    };
  };
}

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: unknown;
}

function contextOf(call: Call): number {
  return call.input + call.read + call.write5m + call.write1h;
}

function priceOf(model: string): { input: number; output: number } | undefined {
  const key = Object.keys(MODEL_PRICES).find((prefix) => model.startsWith(prefix));
  return key ? MODEL_PRICES[key] : undefined;
}

interface CostParts {
  read: number;
  write: number;
  output: number;
  input: number;
}

function costOf(call: Call): CostParts {
  const price = priceOf(call.model);
  if (!price) return { read: 0, write: 0, output: 0, input: 0 };
  const perToken = price.input / 1e6;
  return {
    input: call.input * perToken,
    read: call.read * perToken * CACHE_READ_MULTIPLIER,
    write:
      call.write5m * perToken * CACHE_WRITE_5M_MULTIPLIER +
      call.write1h * perToken * CACHE_WRITE_1H_MULTIPLIER,
    output: (call.output * price.output) / 1e6,
  };
}

function sum(parts: CostParts): number {
  return parts.input + parts.read + parts.write + parts.output;
}

/** Nearest-rank percentile of an unsorted list; 0 for an empty one. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] as number;
}

function blocksOf(content: unknown): ContentBlock[] {
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocksOf(content)
    .map((block) => (typeof block.content === 'string' ? block.content : JSON.stringify(block)))
    .join('');
}

function parseCall(entry: TranscriptEntry, at: number): Call | undefined {
  const usage = entry.message?.usage;
  const model = entry.message?.model;
  if (!usage || !model || model.startsWith('<')) return undefined;
  const written = usage.cache_creation_input_tokens ?? 0;
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens;
  const write5m = usage.cache_creation?.ephemeral_5m_input_tokens;
  return {
    at,
    model,
    effort: entry.effort ?? 'unknown',
    input: usage.input_tokens ?? 0,
    read: usage.cache_read_input_tokens ?? 0,
    // Without the per-tier split the write is priced at the shorter tier.
    write5m: write5m ?? (write1h === undefined ? written : 0),
    write1h: write1h ?? 0,
    output: usage.output_tokens ?? 0,
  };
}

interface ReadTranscript {
  calls: Call[];
  conductor: boolean;
  headless: boolean;
  toolResults: ToolResult[];
}

/**
 * One transcript, restricted to the window. Claude Code writes one entry per
 * content block and stamps each with the request's usage, so entries sharing a
 * request id are one call and the last one holds the final output count.
 */
function readTranscript(file: string, sinceMs: number): ReadTranscript | undefined {
  let lines: string[];
  try {
    lines = readFileSync(file, 'utf8').split('\n');
  } catch {
    return undefined;
  }
  const calls = new Map<string, Call>();
  const toolNames = new Map<string, string>();
  const pending: { tool: string; tokens: number; callsBefore: number }[] = [];
  let conductor = false;
  let headless = false;
  let sawUser = false;
  for (const line of lines) {
    if (!line) continue;
    let entry: TranscriptEntry & { entrypoint?: string };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.entrypoint === 'sdk-cli') headless = true;
    if (entry.type === 'user' && !sawUser) {
      sawUser = true;
      conductor = textOf(entry.message?.content).includes('# Pupitre conductor ');
    }
    const at = Date.parse(entry.timestamp ?? '');
    if (Number.isNaN(at) || at < sinceMs) continue;
    if (entry.type === 'assistant') {
      for (const block of blocksOf(entry.message?.content)) {
        if (block.type === 'tool_use' && block.id && block.name)
          toolNames.set(block.id, block.name);
      }
      const call = parseCall(entry, at);
      const key = entry.requestId ?? entry.message?.id;
      if (call && key) calls.set(key, call);
    } else if (entry.type === 'user') {
      for (const block of blocksOf(entry.message?.content)) {
        if (block.type !== 'tool_result') continue;
        pending.push({
          tool: toolNames.get(block.tool_use_id ?? '') ?? 'unknown',
          tokens: Math.ceil(textOf(block.content).length / CHARS_PER_TOKEN),
          callsBefore: calls.size,
        });
      }
    }
  }
  const total = calls.size;
  return {
    calls: [...calls.values()],
    conductor,
    headless,
    toolResults: pending.map((p) => ({
      tool: p.tool,
      tokens: p.tokens,
      callsAfter: total - p.callsBefore,
    })),
  };
}

function jsonlIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** Every `<session>/subagents/agent-*.jsonl` under a project's transcript directory. */
function subagentFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return entries.flatMap((name) => jsonlIn(join(dir, name, 'subagents')));
}

interface Source {
  file: string;
  class: UsageClass;
}

/**
 * The project's console and conductor transcripts sit in the checkout's
 * directory, its workers' in one directory per worktree (the table's rows plus
 * any worktree since removed, found by prefix), and subagents' under a
 * `subagents/` folder of whichever session spawned them.
 */
function sourcesOf(db: Database, repoPath: string, claudeDir: string): Source[] {
  const projects = join(claudeDir, 'projects');
  const root = transcriptDir(repoPath, claudeDir);
  const workerPrefix = transcriptDir(`${join(repoPath, '.worktrees')}/`, claudeDir);
  const workerDirs = new Set(
    listSessions(db).map((row) => transcriptDir(row.worktree_path, claudeDir)),
  );
  try {
    for (const name of readdirSync(projects)) {
      if (join(projects, name).startsWith(workerPrefix)) workerDirs.add(join(projects, name));
    }
  } catch {
    // no projects directory: nothing to report
  }
  const sources: Source[] = [];
  for (const dir of workerDirs) {
    for (const file of jsonlIn(dir)) sources.push({ file, class: UsageClass.Worker });
    for (const file of subagentFiles(dir)) sources.push({ file, class: UsageClass.Subagent });
  }
  for (const file of jsonlIn(root)) sources.push({ file, class: UsageClass.Console });
  for (const file of subagentFiles(root)) sources.push({ file, class: UsageClass.Subagent });
  return sources.filter((source) => existsSync(source.file));
}

function add(buckets: Map<string, Bucket>, klass: UsageClass, calls: Call[]): void {
  const ordered = [...calls].sort((a, b) => a.at - b.at);
  for (const [index, call] of ordered.entries()) {
    const key = [klass, call.model, call.effort].join('\u0000');
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        class: klass,
        model: call.model,
        effort: call.effort,
        calls: [],
        floors: [],
        recaches: 0,
        recachedTokens: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.calls.push(call);
    if (index === 0) bucket.floors.push(contextOf(call));
    const previous = ordered[index - 1];
    if (previous && call.at - previous.at > IDLE_RECACHE_MS) {
      const written = call.write5m + call.write1h;
      if (written > call.read) {
        bucket.recaches += 1;
        bucket.recachedTokens += written;
      }
    }
  }
}

function rowOf(bucket: Bucket, totalCost: number): UsageRow {
  const parts = bucket.calls.map(costOf);
  const read = parts.reduce((n, p) => n + p.read, 0);
  const write = parts.reduce((n, p) => n + p.write, 0);
  const output = parts.reduce((n, p) => n + p.output, 0);
  const cost = parts.reduce((n, p) => n + sum(p), 0);
  const prompt = bucket.calls.reduce((n, c) => n + contextOf(c), 0);
  const cached = bucket.calls.reduce((n, c) => n + c.read, 0);
  const contexts = bucket.calls.map(contextOf);
  return {
    class: bucket.class,
    model: bucket.model,
    effort: bucket.effort,
    calls: bucket.calls.length,
    cost,
    costShare: totalCost > 0 ? cost / totalCost : 0,
    cacheHitRate: prompt > 0 ? cached / prompt : 0,
    cacheReadCostShare: cost > 0 ? read / cost : 0,
    cacheWriteCostShare: cost > 0 ? write / cost : 0,
    outputCostShare: cost > 0 ? output / cost : 0,
    medianContext: percentile(contexts, 0.5),
    p90Context: percentile(contexts, 0.9),
    firstRequestFloor: percentile(bucket.floors, 0.5),
    recaches: bucket.recaches,
    recachedTokens: bucket.recachedTokens,
  };
}

export function buildUsageReport(db: Database, repoPath: string, opts: UsageOptions): UsageReport {
  const claudeDir = opts.claudeDir ?? join(homedir(), '.claude');
  const sinceMs = opts.since.getTime();
  const buckets = new Map<string, Bucket>();
  const carry = new Map<string, ToolCarry>();
  for (const source of sourcesOf(db, repoPath, claudeDir)) {
    const read = readTranscript(source.file, sinceMs);
    if (!read || read.calls.length === 0) continue;
    // A subagent's file says nothing of who spawned it; the others tell
    // themselves apart by how they were started.
    let klass = source.class;
    if (klass === UsageClass.Console) {
      if (read.headless) klass = UsageClass.Utility;
      else if (read.conductor) klass = UsageClass.Conductor;
    }
    add(buckets, klass, read.calls);
    for (const result of read.toolResults) {
      const entry = carry.get(result.tool) ?? {
        tool: result.tool,
        results: 0,
        tokens: 0,
        carriedTokens: 0,
      };
      entry.results += 1;
      entry.tokens += result.tokens;
      entry.carriedTokens += result.tokens * result.callsAfter;
      carry.set(result.tool, entry);
    }
  }
  const all = [...buckets.values()];
  const totalCost = all.reduce((n, b) => n + b.calls.reduce((m, c) => m + sum(costOf(c)), 0), 0);
  const rows = all.map((bucket) => rowOf(bucket, totalCost)).sort((a, b) => b.cost - a.cost);
  const byClass = Object.values(UsageClass)
    .map((klass) => {
      const mine = rows.filter((row) => row.class === klass);
      const cost = mine.reduce((n, row) => n + row.cost, 0);
      return {
        class: klass,
        calls: mine.reduce((n, row) => n + row.calls, 0),
        cost,
        costShare: totalCost > 0 ? cost / totalCost : 0,
      };
    })
    .filter((entry) => entry.calls > 0)
    .sort((a, b) => b.cost - a.cost);
  const unpricedModels = [
    ...new Set(all.flatMap((b) => b.calls.map((c) => c.model)).filter((m) => !priceOf(m))),
  ].sort();
  return {
    since: opts.since.toISOString(),
    totalCost,
    byClass,
    rows,
    toolCarry: [...carry.values()].sort((a, b) => b.carriedTokens - a.carriedTokens),
    unpricedModels,
  };
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const usd = (n: number): string => `$${n.toFixed(2)}`;
const tokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n);

export function formatUsageReport(report: UsageReport): string {
  const out = [
    `Usage since ${report.since}: ${usd(report.totalCost)} over ${report.rows.reduce((n, r) => n + r.calls, 0)} calls`,
  ];
  for (const klass of report.byClass) {
    out.push(
      '',
      `${klass.class}  ${usd(klass.cost)} (${pct(klass.costShare)}), ${klass.calls} calls`,
    );
    for (const row of report.rows.filter((r) => r.class === klass.class)) {
      out.push(
        `  ${row.model} / ${row.effort}: ${row.calls} calls, ${usd(row.cost)} (${pct(row.costShare)})`,
        `    cache hit ${pct(row.cacheHitRate)}; cost split read ${pct(row.cacheReadCostShare)}, write ${pct(row.cacheWriteCostShare)}, output ${pct(row.outputCostShare)}`,
        `    context median ${tokens(row.medianContext)}, p90 ${tokens(row.p90Context)}, first-request floor ${tokens(row.firstRequestFloor)}`,
        `    re-caches after >1h idle: ${row.recaches} (${tokens(row.recachedTokens)} written)`,
      );
    }
  }
  if (report.toolCarry.length > 0) {
    out.push('', 'Tool output carried (estimated tokens, tokens x later calls):');
    for (const t of report.toolCarry) {
      out.push(
        `  ${t.tool}: ${t.results} results, ${tokens(t.tokens)}, carried ${tokens(t.carriedTokens)}`,
      );
    }
  }
  if (report.unpricedModels.length > 0) {
    out.push(
      '',
      `Unpriced (counted at $0, add to MODEL_PRICES): ${report.unpricedModels.join(', ')}`,
    );
  }
  return out.join('\n');
}
