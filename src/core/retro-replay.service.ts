import {
  type Call,
  callCost,
  contextOf,
  percentile,
  recachedTokens,
  type ScannedTranscript,
  type UsageClass,
} from './usage-report.service.js';

// `pup retro` replays each transcript request by request under a lower
// compaction threshold, so a change of `autoCompactWindow` can be judged by the
// spend it moves before it is made. The replay keeps each request's uncached
// input, output and write of new tokens as they were, and re-prices only what
// the threshold changes: the context carried from one request to the next, the
// rewrite after an idle hour, and the resets themselves.

/** The compaction thresholds the replay prices, in tokens of context. */
const REPLAY_THRESHOLDS = [100_000, 120_000, 150_000, 200_000];

/** Spend on requests carrying more context than this is reported as a share. */
const HIGH_CONTEXT = 150_000;

type Transcript = ScannedTranscript['read'];

interface Step {
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
interface ResetFloor {
  read: number;
  write: number;
}

export interface ReplayRow {
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
  replay: ReplayRow[];
}

const sum = (values: number[]): number => values.reduce((n, v) => n + v, 0);

/**
 * The requests in order, each with the compactions since the one before it. A
 * transcript is session-written, so the compactions are walked once alongside
 * the requests: one with any number of boundaries stays linear.
 */
function stepsOf(read: Transcript): Step[] {
  const compactions = [...read.compactions].sort((a, b) => a.at - b.at);
  let next = 0;
  let previous = read.before;
  return [...read.calls.values()]
    .sort((a, b) => a.at - b.at)
    .map((call) => {
      const after = previous?.at ?? Number.NEGATIVE_INFINITY;
      let found = 0;
      let seen = false;
      let auto = false;
      let manual = false;
      for (; next < compactions.length && (compactions[next]?.at ?? 0) <= call.at; next += 1) {
        const c = compactions[next];
        if (!c || c.at <= after) continue;
        seen = true;
        found = Math.max(found, c.preTokens);
        if (c.manual) manual = true;
        else auto = true;
      }
      const previousContext = previous ? contextOf(previous) : undefined;
      const step = {
        call,
        context: contextOf(call),
        previousContext,
        compactedContext: seen ? found || previousContext : undefined,
        autoReset: auto,
        manualReset: manual,
        idle: recachedTokens(call, previous) > 0,
      };
      previous = call;
      return step;
    });
}

/** A request whose write rebuilt the cache holds no new tokens of its own to keep. */
function rebuilt(step: Step): boolean {
  return step.idle || step.autoReset || step.manualReset;
}

/**
 * One transcript under a threshold. A reset fires before a request when the
 * context it would carry reaches the threshold, as an automatic compaction
 * does, and leaves the floor plus the request's new tokens. Otherwise the
 * context grows as it did in the transcript; across an automatic compaction the
 * replay did not take, by what the compaction found over the request before it.
 * Carried context is read from the cache, except after an idle hour, when what
 * the cache did not hold is written again.
 */
function replayTranscript(
  steps: Step[],
  threshold: number,
  floor: ResetFloor,
): { cost: number; resets: number } {
  const longTier = sum(steps.map((s) => s.call.write1h)) >= sum(steps.map((s) => s.call.write5m));
  let cost = 0;
  let resets = 0;
  let replayed = 0;
  steps.forEach((step, i) => {
    const { call } = step;
    const kept = rebuilt(step) ? { write5m: 0, write1h: 0 } : call;
    const newTokens = call.input + kept.write5m + kept.write1h;
    const before = step.previousContext ?? 0;
    const grown =
      i === 0 || step.manualReset
        ? step.context
        : replayed + (step.autoReset ? (step.compactedContext ?? before) : step.context) - before;
    const reset = i > 0 && !step.manualReset && grown >= threshold;
    let carriedRead: number;
    let rewrite: number;
    if (reset) {
      carriedRead = floor.read;
      rewrite = floor.write;
    } else {
      const carried = Math.max(0, grown - newTokens);
      carriedRead = rebuilt(step) ? Math.min(call.read, carried) : carried;
      rewrite = carried - carriedRead;
    }
    if (reset || step.manualReset) resets += 1;
    replayed = newTokens + carriedRead + rewrite;
    const written = call.write1h + call.write5m;
    const oneHour = written > 0 ? call.write1h >= call.write5m : longTier;
    cost += callCost({
      ...call,
      read: carriedRead,
      write5m: kept.write5m + (oneHour ? 0 : rewrite),
      write1h: kept.write1h + (oneHour ? rewrite : 0),
    });
  });
  return { cost, resets };
}

/** The median request after an automatic compaction; a fresh window's first request when none fired. */
function resetFloorOf(transcripts: { read: Transcript; steps: Step[] }[]): ResetFloor {
  const after = transcripts.flatMap(({ steps }) => steps.filter((s) => s.autoReset));
  const firsts = transcripts.flatMap(({ read, steps }) =>
    read.before || !steps[0] ? [] : [steps[0]],
  );
  const sample = after.length > 0 ? after : firsts;
  return {
    read: percentile(
      sample.map((s) => s.call.read),
      0.5,
    ),
    write: percentile(
      sample.map((s) => s.call.write5m + s.call.write1h),
      0.5,
    ),
  };
}

/** Context added per request between resets, pooled over every stretch of two or more requests. */
function growthOf(steps: Step[][]): number {
  let rise = 0;
  let requests = 0;
  for (const transcript of steps) {
    let start = 0;
    transcript.forEach((step, i) => {
      const last = i === transcript.length - 1;
      const end = transcript[i + 1]?.autoReset || transcript[i + 1]?.manualReset || last;
      if (!end) return;
      rise += step.context - (transcript[start]?.context ?? 0);
      requests += i - start;
      start = i + 1;
    });
  }
  return requests > 0 ? rise / requests : 0;
}

function statsOf(items: ScannedTranscript[]): ContextStats {
  const transcripts = items.map(({ read }) => ({ read, steps: stepsOf(read) }));
  const steps = transcripts.flatMap((t) => t.steps);
  const compacted = steps.filter((s) => s.compactedContext);
  const auto = compacted.filter((s) => s.autoReset);
  const cost = sum(steps.map((s) => callCost(s.call)));
  const floor = resetFloorOf(transcripts);
  const replayAt = (threshold: number): { cost: number; resets: number } =>
    transcripts.reduce(
      (acc, { steps: mine }) => {
        const one = replayTranscript(mine, threshold, floor);
        return { cost: acc.cost + one.cost, resets: acc.resets + one.resets };
      },
      { cost: 0, resets: 0 },
    );
  const observed = percentile(
    auto.map((s) => s.compactedContext ?? 0),
    0.5,
  );
  return {
    cost,
    contextBeforeCompaction: percentile(
      compacted.map((s) => s.compactedContext ?? 0),
      0.5,
    ),
    contextAfterCompaction: percentile(
      compacted.map((s) => s.context),
      0.5,
    ),
    growthPerRequest: growthOf(transcripts.map((t) => t.steps)),
    highContextCostShare:
      cost > 0
        ? sum(steps.filter((s) => s.context > HIGH_CONTEXT).map((s) => callCost(s.call))) / cost
        : 0,
    observedThreshold: observed,
    observedReplayCost: replayAt(observed > 0 ? observed : Number.POSITIVE_INFINITY).cost,
    replay: REPLAY_THRESHOLDS.map((threshold) => {
      const replayed = replayAt(threshold);
      return {
        threshold,
        resets: replayed.resets,
        cost: replayed.cost,
        change: replayed.cost - cost,
        changeShare: cost > 0 ? (replayed.cost - cost) / cost : 0,
      };
    }),
  };
}

/** Per session class: compactions, growth, spend at high context and the replay. */
export function contextStatsByClass(scanned: ScannedTranscript[]): Map<UsageClass, ContextStats> {
  const byClass = new Map<UsageClass, ScannedTranscript[]>();
  for (const item of scanned) byClass.set(item.class, [...(byClass.get(item.class) ?? []), item]);
  return new Map([...byClass].map(([klass, items]) => [klass, statsOf(items)]));
}
