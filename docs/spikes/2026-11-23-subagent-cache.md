# Spike: why subagents miss the prompt cache (retro of 2026-11-23)

## Question

The retro of 2026-11-23 reports a 78.4% cache hit over 645 subagent calls and 49.3% over 134 utility calls. Which subagent types and call patterns lose the cache, what does each cost, and what would fix each?

## Method and limits

- `pup retro --json` is operator-only and refuses a session. I read the stored `retro-2026-11-23.json` and `.md` in the project store instead. They hold aggregates only, with no breakdown by agent type.
- The deeper look came from the 111 subagent transcripts under `~/.claude/projects/<project>/*/subagents/` modified since 2026-11-16. They were readable from this sandbox. I deduplicated by message id and read `usage.cache_read_input_tokens` and `cache_creation_input_tokens` per call.
- My window gives 610 calls and a 76.4% hit, against the retro's 645 calls and 78.4%. The gap comes from the window edges and deduplication. The shape of the result does not depend on it.
- **Utility calls are not covered.** They are not stored as subagent transcripts, so the 49.3% is unexplained here. Cause 3 below is the only lead.
- Dollars assume the write price the retro itself implies: 10 USD per million tokens (for example 280664 tokens = 2.81 USD). Reads are assumed at 0.8 USD per million (a tenth of the base price). The transcripts do not record which model each subagent ran on, so treat the dollars as an estimate.

## What the transcripts show

Type mix: 108 of 111 subagents are `general-purpose`, 2 are `Explore`, 1 is `architecture-explainer`. `general-purpose` accounts for 588 of 610 calls, so it is the low hit rate. The other two types are too small to matter (hit 75% and 89%).

Totals: 20.9M tokens read from the cache, 6.38M written (about 64 USD), 1.2k uncached input. Where the 6.38M written comes from:

| Cause | Agents | Calls | Tokens written | Approx. cost |
|---|---|---|---|---|
| Growth of the context (new tool output on each call) | 111 | 499 | 4.52M | 45 USD |
| First request, nothing read from the cache | 69 | 69 | 1.35M | 13 USD |
| First request, shared prefix read | 42 | 42 | 0.51M written (0.33M read) | 5 USD |

## Causes, saving and fix

### 1. Short-lived subagents that never reuse their cache

21 subagents made 2 calls or fewer (41 calls). They wrote 516k tokens and read almost nothing back. A further 26 made exactly 3 calls. The cache is built and then discarded.

- Saving: about 0.5M tokens, about 5 USD in the window, if those tasks ran inline in the parent, where the cache is already warm.
- Fix: add a rule not to launch a subagent for a task of one or two tool calls, such as reading a known file or one grep. Where it goes is not settled: the Searching section of the session prompt (`SESSION_SEARCHING` in `src/core/profile-compiler.service.ts`) only routes questions to `Explore` subagents, which are 2 of the 111, while the short-lived waste comes from `general-purpose` subagents (108 of 111). The only place pup itself names `general-purpose` is the conductor's security review (`SECURITY_REVIEW_AGENT`). The spike did not find where the other `general-purpose` launches originate; most are probably the worker's own choice of agent type. Finding that out comes first.
- Effort: small once the origin is known. The text is a constant in `profile-compiler.service.ts` asserted by `test/unit/core/profile-compiler.test.ts` and `profile-compiler-context.test.ts`, so the change is code and tests, not a template edit.

### 2. First request of each subagent

69 of 111 subagents started with a zero cache read, written at about 19.6k tokens each. The other 42 read a shared prefix of exactly 6429 or 19099 tokens, so that prefix is cacheable. The cold starts happen when no sibling used the same prefix within the 5 minute cache lifetime. Only 6 of the 69 had a sibling start within 5 minutes.

- Saving: the ceiling is about 1.3M tokens, about 12 USD (write price minus read price), and only if every launch found a warm prefix.
- Fix: none worth doing. The cold start is the cost of a short cache lifetime and of different parent sessions. Batching launches so they land within 5 minutes needs scheduling in pup, which is more work than the saving justifies. Cutting the prompt that each first request carries is the same idea as cause 4.

### 3. A changing prefix (injected timestamp, reordered tool list)

Ruled out for subagents. In all 499 follow-up calls, the cache read was at least 90% of the previous call's context. I found no call that rewrote the prefix, and no idle gap over 5 minutes before a re-write.

- Saving: none.
- Fix: nothing to change. The two distinct shared prefixes (6429 and 19099 tokens) look like two stable tool configurations, not a drifting prompt.
- Not checked: whether a prefix change explains the utility class, which has only 3715 tokens of first-request floor and a 49.3% hit.

### 4. Context growth (the bulk of the writes)

4.52M tokens, about 45 USD, are new tool output written once and then read back on later calls. This is the normal cost of a growing context and not a cache miss. It is the largest figure because subagents read many files.

- Saving: at best a fraction, by capping what a subagent returns from each read.
- Fix: an agent definition or prompt change asking for ranges (offset and limit) and grep output over whole files. The saving depends on what the subagents are asked, and I did not measure that.
- Effort: small to write, uncertain gain.

## Ranked fixes (saving over effort)

1. **Stop launching subagents for one or two call tasks** (cause 1). About 5 USD per retro window for one line of prompt. This can be a small task, and the text below is ready for `pup plan add`:

   > First find where the 21 short-lived `general-purpose` subagents come from: read the session transcripts that launched them and say whether the worker chose the type or a pup prompt told it to. Then add one rule where they originate, most likely a constant in `src/core/profile-compiler.service.ts` with its assertions in `test/unit/core/profile-compiler.test.ts` and `profile-compiler-context.test.ts`: do not launch a subagent for a task that takes one or two tool calls (reading a known file, one grep or glob); do those directly. Keep the Explore rule for questions that need a sweep of many files. Success: after a week, fewer than 5% of subagents in `pup retro` make 2 calls or fewer (21 of 111, about 19%, before). This is a code and test change.

2. **Ask subagents for ranged reads and short answers** (cause 4). Possible saving of a few USD to tens of USD, but unmeasured and hard to attribute. This can be a small task, but measure first.
3. **Batch launches inside the cache lifetime** (cause 2). Ceiling about 12 USD, needs pup scheduling work. Leave it.
4. **Prefix stability** (cause 3). Nothing found, nothing to do.

## Open

Utility calls (134 calls, 49.3%, 212k tokens) need their own transcripts or the pup call log, which a session cannot read. Next step: the operator runs `pup retro --json` and checks the utility launch path for a changing prefix.
