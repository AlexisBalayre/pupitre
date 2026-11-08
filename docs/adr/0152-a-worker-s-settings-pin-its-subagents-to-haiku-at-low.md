# 0152. A worker's settings pin its subagents to Haiku at low effort, and its kickoff sends every where-is and how-does question to Explore (2026-11-08, amends 107 and 129)

- Status: accepted
- Amends: [0107](0107-every-compiled-settings-file-turns-off-the-artifact.md)
- Amends: [0129](0129-workers-and-the-conductor-learn-the-code-through-an-explore.md)

152. **A worker's settings pin its subagents to Haiku at low effort, and its kickoff sends every
    where-is and how-does question to Explore (2026-11-08, amends 107 and 129).**
    Over five days, 38% of 3,218 worker turns were grep, sed, cat or Read turns, and most of them
    ran on Opus. Decision 129 already told a worker to delegate. It named `model: "sonnet"` on the
    Agent call, which is an instruction and not a pin, and it framed delegation as learning the
    code rather than as every search.
    *The pin.* Decision 107's worker `env` now also sets `CLAUDE_CODE_SUBAGENT_MODEL` to
    `WORKER_SUBAGENT_ROUTE.model` (`claude-haiku-5-5`), `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` and
    `CLAUDE_CODE_SUBAGENT_EFFORT` to `low` (`WORKER_SUBAGENT_ENV`). FORCE is required. Read from
    the 2.1.319 binary: the built-in Explore agent's model is `inherit`, or `{inheritCap: "opus"}`,
    and either one outranks `CLAUDE_CODE_SUBAGENT_MODEL`. So without FORCE, an Explore call with
    no `model` runs on the window's own model. FORCE drops both the agent's model and the call's
    model, and it removes the `model` parameter from the Agent tool's schema. The kickoff
    therefore names no model and no effort. A call can still pass `effort`, which outranks
    `CLAUDE_CODE_SUBAGENT_EFFORT`, but the kickoff never asks for one.
    *Every subagent, not only Explore.* FORCE pins every subagent a worker spawns, because the
    env switch has no per-agent form. A per-agent pin would need pup's own agent definition passed
    as `--agents` JSON, the follow-up decision 118 records. A worker's kickoff names Explore
    alone, so today the two scopes are the same.
    *The conductor is unchanged.* Its deny list is still decision 74's alone and its `env` is
    still `SLIM_CONTEXT_ENV`. Its security review runs a general-purpose subagent on Opus
    (decision 118), and FORCE would silently put that review on Haiku. Its `## Exploring code`
    section keeps decision 129's text word for word, `model: "sonnet"` included.
    *Agent stays.* No deny takes the Agent tool from a worker. A layer's `deny` can still add it
    (decision 77), which turns delegation off for that profile.
    *The kickoff.* The worker's `## Exploring code` section becomes `## Searching`. For any
    where-is-X or how-does-module-Y question, it says to ask an Explore subagent and keep only
    its summary. It says to tell the subagent to use only Read, Grep and Glob, to run no git and
    no shell, and to read only this worktree. The Read tool is for the file about to be edited,
    and only the lines the edit needs. The worker still reads its own diff itself, with git. The
    section is about the length of the one it replaces, so the default profile stays under
    `DEFAULT_CONTEXT_BUDGET_TOKENS`.
    *Pilot (2026-11-08, folds t-mvpeipp0 in).* Three questions a worker asks before an edit: how a
    relaunch climbs the model ladder, how `pup session test` waits for a slot and where the gate
    refuses a timeout under load, and how scope is enforced and re-checked at the gate. Each ran
    once per arm, headless (`claude -p`), on `claude-opus-5-5` at high effort, in a `git archive`
    copy of the tree, with Bash, Read, Grep and Glob (plus Agent for the delegating arms), no MCP
    and decision 107's env. Cost is `total_cost_usd`, which includes the subagent's usage.

    | Arm | q1 | q2 | q3 | Mean per task | Opus turns |
    | :-- | --: | --: | --: | --: | --: |
    | No delegation | $0.323 | $0.453 | $0.231 | $0.336 | 9–12 |
    | Explore pinned to `claude-sonnet-5-5` low | $0.324 | $0.306 | $0.302 | $0.310 | 2–5 |
    | Explore pinned to `claude-haiku-5-5` low | $0.196 | $0.177 | $0.159 | $0.177 | 2 |

    The Sonnet subagent cost $0.11–0.15 per task and the Haiku subagent $0.008–0.017. In both
    delegating arms the Opus share fell to $0.15–0.20. For each question, the three arms named the same
    core files and functions. The delegating arms' answers say they come from a search pass and
    that their line numbers need checking before an edit. Haiku costs 47% less per task
    than no delegation and Sonnet only 8% less, so the pin is Haiku. The pilot understates the
    saving: its window opened at about 9k tokens, while a worker opens at about 23k (decision 107)
    and grows from there, so each Opus turn delegation removes costs more in a real session. The
    figures are one run per cell, a pilot rather than a benchmark.
    *Re-measuring.* `pup retro` (decision 150) splits a window's tokens by tool. After this
    change, a worker's grep, sed, cat and Read turns should fall well below 38%, and its Agent
    turns should report `claude-haiku-5-5` as their model.
    *Tests.* `profile-compiler.test.ts` checks four things. A worker's deny list has no `Agent`.
    Its `env` is `SLIM_CONTEXT_ENV` plus the three pin variables. The conductor's deny list and
    `env` are unchanged. A worker on the default profile carries the `## Searching` section word
    for word, with neither `## Exploring code` nor `model: "sonnet"`, and stays within its context
    budget.
