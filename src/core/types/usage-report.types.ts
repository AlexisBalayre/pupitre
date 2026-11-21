import type { UsageClass } from '../enums/usage-report.enums.js';

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
  /** Set when the carry is split by result size, as `pup retro` does. */
  sizeBucket?: string;
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
  /** Every Claude config dir a window of the project may have written to. */
  claudeDirs: string[];
}

export interface Call {
  at: number;
  model: string;
  effort: string;
  input: number;
  read: number;
  write5m: number;
  write1h: number;
  output: number;
}

export interface Bucket {
  class: UsageClass;
  model: string;
  effort: string;
  calls: Call[];
  floors: number[];
  recaches: number;
  recachedTokens: number;
  recachedCost: number;
}

// A session writes its own transcript, so a field that is counted, coerced or
// printed is `unknown` until it is checked.
export interface TranscriptEntry {
  type?: string;
  timestamp?: unknown;
  subtype?: unknown;
  requestId?: string;
  effort?: unknown;
  entrypoint?: string;
  compactMetadata?: { trigger?: unknown; preTokens?: unknown };
  message?: {
    id?: string;
    model?: unknown;
    content?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
      cache_creation?: { ephemeral_1h_input_tokens?: unknown };
    };
  };
}

export interface ContentBlock {
  type?: string;
  id?: string;
  name?: unknown;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  text?: unknown;
}

export interface CostParts {
  read: number;
  write: number;
  output: number;
  input: number;
}

export interface ToolResult {
  tool: string;
  tokens: number;
  /** Calls counted before the result arrived; every later one carries it. */
  callsBefore: number;
}

export interface FileRead {
  path: string;
  /** The offset and limit asked for: reading a file in chunks is not reading it again. */
  range: string;
  tokens: number;
}

export interface Compaction {
  at: number;
  /** Asked for with `/compact`, not fired by the context reaching the threshold. */
  manual: boolean;
  /** The context it found, 0 when the boundary does not say. */
  preTokens: number;
}

export interface Transcript {
  calls: Map<string, Call>;
  /** The last call before the window, when the transcript began before it. */
  before: Call | undefined;
  toolNames: Map<string, string>;
  toolResults: ToolResult[];
  readPaths: Map<string, { path: string; range: string }>;
  reads: FileRead[];
  /** Compactions inside the window, in order. */
  compactions: Compaction[];
  conductor: boolean;
  headless: boolean;
  sawUser: boolean;
}

export interface Source {
  file: string;
  class: UsageClass;
}

export interface ScannedTranscript {
  class: UsageClass;
  read: Transcript;
}
