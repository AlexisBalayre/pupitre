# 0107. Every compiled settings file turns off the Artifact and Workflow tools and prompt suggestions, and a worker's denies the tools and the skill listing it never uses (2026-10-27).

- Status: accepted

107. **Every compiled settings file turns off the Artifact and Workflow tools and prompt
    suggestions, and a worker's denies the tools and the skill listing it never uses
    (2026-10-27).** Measured 2026-10-26: a worker's first request is ~49k tokens, ~26k of them
    definitions it never calls — Artifact 12.9k, the skill listing 6.6k, SendFeedback 2k,
    Workflow 1.9k, ScheduleWakeup 1.7k, ReportFindings 0.8k. Every later request re-reads
    them, which made them ~19% of all worker re-read tokens. Prompt suggestions, the next
    prompt Claude Code generates after each turn for an input box no one types into, were
    5–19% of tokens in the six-ways experiment.
    *The env block.* `SLIM_CONTEXT_ENV` sets `CLAUDE_CODE_DISABLE_ARTIFACT=1`,
    `CLAUDE_CODE_DISABLE_WORKFLOWS=1` and `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` as the
    compiled `settings.json`'s `env`, for sessions and the conductor alike. The settings file
    is the route because the window's environment is not one: `tmuxEnv` strips every
    `CLAUDE*` variable (decision 47) and `--session-env` takes a closed list of five
    (decision 106). The file is hashed, so the block is in the profile hash.
    *Bare-name denies.* A deny rule naming a tool with no specifier takes its definition out
    of the model's context, not just its calls (code.claude.com/docs/en/permissions). A
    worker's `permissions.deny` holds `SendFeedback`, `ScheduleWakeup` and `ReportFindings`
    after decision 74's three, then `Skill`, then the layers' own (decision 77). The
    conductor's list is decision 74's alone: it is a window the operator reads and talks to,
    so it keeps every tool.
    *The skill listing.* Claude Code sends the listing only while the Skill tool is in the
    toolset (read from the 2.1.311 binary), and `skillOverrides` goes by skill name with no
    wildcard, so denying `Skill` is the one switch that empties it. A worker whose merged
    profile names no skill — every launch today, since `DEFAULT_BASE_PROFILE` names none —
    is compiled with `Skill` denied. One whose base or role layer names a skill keeps the
    tool, and with it the whole listing: hiding every skill but the named ones would mean
    enumerating the operator's `~/.claude/skills`, plugins, synced and bundled skills at
    compile time, which no profile yet needs. That case is the ceiling, and naming a skill
    in a layer is what lifts the deny.
    *Re-measuring.* The first assistant record in a worker's transcript (its
    `transcript_path`, under `~/.claude/projects/`) carries the first request's size:
    `jq -c 'select(.type=="assistant" and .message.usage) | .message.usage | .input_tokens +
    .cache_creation_input_tokens + .cache_read_input_tokens' <transcript>.jsonl | head -1`.
    Before this change it read ~49k (47,827 on t-mvkzmtxc's); a worker launched after it
    should read ~26k less.
    *Tests.* In `profile-compiler.test.ts`, a worker's and the conductor's settings carry the
    three variables. A worker on the default base profile denies decision 74's three, the
    three unused tools and `Skill`, in that order; one whose role or base names a skill
    denies all but `Skill`; layer denials follow them. The conductor's list is unchanged.
