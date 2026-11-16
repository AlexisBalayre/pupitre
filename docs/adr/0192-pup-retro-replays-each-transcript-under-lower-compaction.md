# 0192. `pup retro` replays each transcript under lower compaction thresholds (2026-11-16)

- Status: accepted
- Amends: [0150](0150-pup-retro-reads-the-claude-code-traces-locally-and.md), [0122](0122-pup-usage-reports-where-the-claude-usage-went-from-the.md)

192. **`pup retro` replays each transcript under lower compaction thresholds (2026-11-16).**
    A one-off study on 2026-11-16 replayed every transcript since 2026-10-17 request by request
    and found that resetting at 120k instead of the 267k where the compactions fired would have
    cut 23% of worker, conductor and console spend. `pup retro` now runs that replay on every
    report, so a change of `autoCompactWindow` can be judged by the numbers it moves (decision
    122's aim) before it is made.
    *Per class.* Besides the rows of decision 150, each session class carries its actual cost;
    the median context a compaction found (`compactMetadata.preTokens`, else the request before
    it) and the context of the request after it; the context added per request between resets,
    pooled over every stretch of two or more requests; the share of spend on requests carrying
    over 150k; the observed threshold, the median context an automatic compaction found (0 when
    none fired); and the replayed spend at 100k, 120k, 150k and 200k, each with its resets, its
    change against the actual and that change as a share. The replay at the observed threshold
    is reported too, as the check on the replay itself.
    *Replay.* Each request keeps its uncached input, its output and its write of new tokens as
    they were. Only what the threshold changes is re-priced, at the `pup usage` prices:
    - The context carried from the request before, read from the cache at 0.1x.
    - The rewrite after an idle hour: of the carried context, what the actual request read stays
      read, and the rest is written at the request's own cache tier.
    - The resets. A replayed reset fires before a request when the context it would carry
      reaches the threshold, as an automatic compaction does. It leaves the class's median
      request after an automatic compaction (its cache read and its write, priced as such), or a
      fresh window's first request when the class had no compaction.
    Between resets the context grows as it did in the transcript. Across an automatic compaction
    that the replay did not take, it grows by what the compaction found over the request before
    it. A request that rebuilt the cache (after a compaction or an idle hour) has no new tokens
    of its own to keep. A `/compact` (trigger `manual`) is kept at every threshold: it was the
    operator's choice, not the threshold's.
    *Not priced.* The compaction's own summarizing request is not in the transcript, so neither
    the actual cost nor the replay counts it. That understates what a reset costs, so the savings
    shown at a lower threshold are an upper bound. Re-orientation after a reset (files read
    again, commands re-run) is in the growth the transcript shows after the actual compactions,
    and is not modelled apart.
    *Fidelity.* On a fixture with two compactions at one threshold, the replay at that threshold
    is within 5% of the actual spend (`retro.test.ts`). On the 2026-11-16 data it lands 3–9% over
    the actual. A few compactions fired at 200–230k under an earlier setting, and a replay at the
    267k median carries the context through them.
    *Rejected.* The lowest context a compaction fired at, as the observed threshold. It made the
    replay reset sessions that the actual 267k setting let run, and missed the actual spend by up
    to 11%. Replaying fresh windows (a handoff respawn) instead of compactions: the knob being
    judged is `autoCompactWindow`, whose reset is a compaction.
