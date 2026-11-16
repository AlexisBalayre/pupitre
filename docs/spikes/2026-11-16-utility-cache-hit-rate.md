# Spike: utility-class cache hit rate (2026-11-16)

The pup retro of 2026-11-14 put the utility class (pup's own `claude -p`
calls, `src/claude/utility.service.ts`) at a 45.1% cache hit over 105 calls,
against 97% for workers. This spike finds what is behind that number.

**Verdict: no code change.** Most of the gap has two causes. Each call carries
its own unique prompt, which is a one-shot with nothing to share. The rest
comes from Claude Code's default system prompt, which changes between runs
under `--safe-mode`. That is not something pup's flags control. Replacing the
system prompt, the only lever pup has, made the hit rate worse (see below).

## What the class is

Every utility call in the repo's transcripts (263 since 2026-10-17) is
`draftDecisionRecord`: one `claude -p` at merge time, one request per call,
a different task and diff in each prompt. The retro's hit rate is
token-weighted: `cache_read / (input + cache_read + cache_creation)`
(`src/core/usage-report.service.ts`, `cacheHitRate`).

## Before and after

| Window | Calls | Mean context | Hit rate |
| --- | --- | --- | --- |
| 2026-11-07 → retro, reconstructed | 122 | — | 44.8% (retro: 45.1% of 105) |
| before #303 (from 2026-11-07) | 67 | ~23.0k | 44.1% |
| after #303 (2026-11-10 12:05 → 2026-11-16) | 73 | ~3.8k | **50.0%** |
| after #303 if the system prompt never varied | 73 | ~3.8k | 64.9% (ceiling) |

The retro window straddles #303 (merged 2026-11-10). That change dropped
CLAUDE.md, tools, MCP and git instructions from the request, which cut each
call from ~23k to ~3.8k tokens and so its cost about sixfold. It moved the
hit rate only from 44% to 50%. The retro's 45.1% is mostly calls made before
#303.

## Where each call's tokens go (after #303)

Claude Code sends: a billing header, the SDK identity line, the default
system prompt (all ending at a 1h cache breakpoint), then the first user
message (a reminder with the user's context, then the prompt), then an
environment block with the final 1h breakpoint. The server also adds a
`safeguards` block of ~650 tokens ahead of the system prompt.

- **50 calls (68%) read 2,438 or 2,478 cached tokens** (the whole system
  prompt) and write ~1.3k: the reminder, the unique prompt and the env
  block. That write is never read again, because the next call's prompt
  differs.
- **23 calls (32%) read only 649** (the server's block) and write ~3.1k:
  the whole system prompt again, plus the prompt.

The two "full" read sizes are the clue. They differ by 40 tokens, and a hit
needs the same size from a call within the past hour. For example, on
2026-11-16 the reads ran 2478 at 08:10, 649 at 08:18, 2478 at 08:44, then
2438 at 10:51. The system prompt alternates between two forms, and a call
misses whenever its form was not sent in the last hour.

## The cause: the default system prompt is not stable

I captured the request bodies by pointing `ANTHROPIC_BASE_URL` at a local
server that saved each body and answered 400. Nothing left the machine. The
argv and env were exactly `runUtility`'s, `claude` was 2.1.325, and the cwd
was the main checkout. Two sections of the default system prompt come and go
between otherwise identical runs:

- `<total_tokens>15000000 tokens left</total_tokens>`: there in the first one
  or two runs of a series, then gone (2 of 8 runs spaced 20s apart, 1 of 6
  back to back).
- `If a tool named mcp__easel__chart is available, call it when …`: a line
  from the operator's installed easel plugin. It got through `--safe-mode`
  in 1 of 16 captures.

Those two lines are ~40 tokens, matching the 2,438/2,478 gap. Every other
part of the prefix was byte-identical across all captures. The billing
header's `cc_version` suffix changes per prompt, but it carries no cache
breakpoint, and the hits show the server ignores it.

Neither section comes from pup. Both come from Claude Code: state it loads
at startup, and a plugin fragment that `--safe-mode` does not hold back. No
pup flag found turns them off:

- `--bare` would skip plugin sync and background prefetches, but it never
  reads OAuth. That breaks decision 12 (the operator's own login, no keys).
- `--exclude-dynamic-system-prompt-sections` moves only cwd, env and git
  status, which are already stable here.

## Tried and rejected: a fixed `--system-prompt`

Replacing the default prompt with a one-line drafting prompt made the prefix
byte-identical in 4 of 4 captures. It also removed the server's `safeguards`
block, which leaves a prefix of a few dozen tokens, below the cacheable
minimum. I ran six real drafts (recent decision-record prompts, Haiku at low
effort, `--no-session-persistence` so they stay out of the retro), each
sequence run back to back:

| Flags | cache read | cache write | Hit rate |
| --- | --- | --- | --- |
| current (`--safe-mode`, default prompt) | 2,438 when the prompt was new | ~1.2k | ~67% on those calls |
| `--system-prompt '<one line>'` | 0 on all 6 | 1.1k–2.0k | 0% |

So the fixed prompt drops the hit rate to 0%. It also leaves the cost about
the same: ~1.3k tokens written at the 1h rate (2×), against 2.4k read at
0.1× plus the same write. It was not adopted.

(Four of the six "current" calls read their whole prompt from cache. The real
merge gate had sent the same prompts within the hour, so they are left out of
the rate above.)

## What would move it, and why it is not worth it

- The best this call can do is ~65%, and only if Claude Code's prompt were
  stable. The ~1.3k unique write per call is the prompt itself, and no
  layout of a one-shot call shares it.
- Moving the fixed draft instructions (~100 tokens, in
  `src/core/decision-record.service.ts`) into the cached prefix would gain
  about 3 points. That is not worth a second path through `runUtility`.
- The retro's 90% target is set for long sessions that re-read their
  history. A one-shot class cannot reach it, so this signal will keep firing
  for utility calls. Excluding the utility class from the cache-hit signal in
  `src/core/retro-signals.service.ts`, or giving it its own target, is a
  possible follow-up outside this task's scope.
- The `total_tokens` and plugin-line variation is a Claude Code issue to
  report upstream. It would also hit any headless caller that relies on a
  stable default prompt.
