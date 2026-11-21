import type { UsageClass } from '../enums/usage-report.enums.js';
import type { Call, ScannedTranscript } from './usage-report.types.js';

export type Transcript = ScannedTranscript['read'];

export interface Step {
  call: Call;
  context: number;
  /** The previous request's context, the one before the window included. */
  previousContext: number | undefined;
  /** The context a compaction before this request found: the previous one's plus what came after it. */
  compactedContext: number | undefined;
  /** An automatic compaction came before this request. */
  autoReset: boolean;
  /** A `/compact` came before this request: the replay keeps it whatever the threshold. */
  manualReset: boolean;
  /** The request found its cache expired after an idle hour and wrote it again. */
  idle: boolean;
}

/** What a reset leaves: the context the request after it reads from the cache and writes. */
export interface ResetFloor {
  read: number;
  write: number;
}

interface ReplayRow {
  threshold: number;
  resets: number;
  cost: number;
  /** The replayed cost less the actual one: negative is a saving. */
  change: number;
  changeShare: number;
}

export interface ContextStats {
  cost: number;
  contextBeforeCompaction: number;
  contextAfterCompaction: number;
  growthPerRequest: number;
  highContextCostShare: number;
  /** The median context an automatic compaction fired at; 0 when none did. */
  observedThreshold: number;
  /** The replay at the observed threshold, the check on the replay itself. */
  observedReplayCost: number;
  /** Empty when the window holds no fresh window or automatic compaction to price a reset from. */
  replay: ReplayRow[];
}

export interface CarryRow {
  tool: string;
  sizeBucket: string;
  results: number;
  tokens: number;
  carriedTokens: number;
}

/** The cache and compaction counts of a class, with its context statistics and replay. */
export interface ClassRow extends ContextStats {
  class: UsageClass;
  transcripts: number;
  calls: number;
  contextTokens: number;
  cacheHitRate: number;
  recaches: number;
  recachedTokens: number;
  recacheCost: number;
  compactions: number;
  medianContext: number;
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
