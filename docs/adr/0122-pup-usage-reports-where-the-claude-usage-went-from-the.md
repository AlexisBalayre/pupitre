# 0122. `pup usage` reports where the Claude usage went, read from the transcripts (2026-10-28).

- Status: accepted

122. **`pup usage` reports where the Claude usage went, read from the transcripts (2026-10-28).**
    The cache analysis of 2026-10-28 was a one-off script. The command makes it repeatable, so
    a change to routing, compaction or the kickoff can be judged by the numbers it moves.
    *Source.* It reads `projects/` under the config dir the project's windows run on
    (`claudeUserDir`: the launching shell's `CLAUDE_CONFIG_DIR` when `--session-env` names it,
    `~/.claude` otherwise) and under the operator shell's own, where the console writes; one
    dir when they are the same. A `CLAUDE_CONFIG_DIR` the windows may not run on is refused as
    `pup launch` refuses it, and reading it makes the dir the way a launch would. For the project: the checkout's directory (console,
    conductor and headless utility calls), one directory per worktree (workers; the sessions
    table's rows plus any removed worktree, found by prefix) and every `subagents/` folder
    under either. Nothing is written, and the transcripts are not copied.
    *Classes.* Worker, console, conductor, utility and subagent. A checkout transcript is the
    conductor's when its first prompt opens with `# Pupitre conductor`, a utility call when it
    ran under `sdk-cli`, the console's otherwise.
    *Calls.* Claude Code stamps every content block of a request with the request's usage, so
    entries sharing a request id are one call, and the last holds the final output count.
    *Output.* Per class, model and effort: calls, cost and its share of the total, cache hit
    rate (cache-read over all prompt tokens), the share of the row's cost that is cache-read,
    cache-write and output, median and p90 context, the first-request floor (the median of
    each transcript's first request; a transcript that began before the window has none in it
    and adds no floor), and re-caches. A re-cache is a request that follows a gap over an hour
    (`IDLE_RECACHE_MS`) and writes more cache than it reads; the last request before the window
    is the first in-window one's predecessor. Tool-output carry
    is each tool result's text size (four characters to the token, an estimate; an image or
    document block counts as nothing, a small undercount where its base64 would be a large
    overcount) times the calls
    that followed it in its transcript, by tool. `--since <date>` bounds the window (default
    seven days) and `--json` prints the same report as data.
    *Prices.* `MODEL_PRICES` is a named table of uncached input and output dollars per million
    tokens by model-id prefix; cache reads cost 0.1x input, 5-minute writes 1.25x and 1-hour
    writes 2x. The figures are the operator's to keep current. A model with no entry is priced
    at zero and named in the report, so a gap shows instead of skewing the shares quietly.
    *Print.* A model, effort or tool name comes from a file a worker can write, so the text
    report scrubs each with `sanitizeReason` where it prints (decision 68); `--json` escapes
    them already.
    *Who.* Operator-only. The transcripts hold every session's prompts and tool output, and a
    session or the conductor steering by its own spend is not what the report is for; both are
    refused the way `pup audit` refuses them.
    *Rejected.* Reading the cost the CLI prints: it is not in the transcript. A usage column
    in the store: it would need a writer on every turn, and the transcript already has the data.
    *Tests.* `usage-report.test.ts` builds a fixture directory and plants a two-hour idle gap
    to count one re-cache, a short gap that is not one, and the floors, a transcript that
    straddles the window edge, an image result, a second config dir and an escape in a name; the CLI tests refuse a
    session, the conductor and an unreadable date.
