# 0129. Workers and the conductor learn the code through an Explore subagent on Sonnet at low effort that runs no git or shell, and read a file only to edit it or for its exact lines (2026-10-30)

- Status: accepted

129. **Workers and the conductor learn the code through an Explore subagent on Sonnet at low
    effort that runs no git or shell, and read a file only to edit it or for its exact lines
    (2026-10-30).**
    Every call a window makes re-reads its whole context. On 2026-10-26, contexts averaged 136k
    tokens for a worker and 158k for the conductor. Reading and searching code was about 26% of a
    worker's re-read tokens and 39% of the conductor's. A subagent's call costs about half a
    main-session call, and only its summary enters the window that spawned it.
    A compiled worker context and the conductor's context now each have an `## Exploring code`
    section with one shared rule. To learn the code (where something lives, how a module works),
    the window spawns an Explore subagent with the Agent tool, `subagent_type: "Explore"`,
    `model: "sonnet"` and `effort: "low"`, and keeps only its summary. It tells the subagent to use
    only Read, Grep and Glob and to run no git and no other shell command. It reads a file itself
    only when it will edit it or needs its exact lines.
    *Explore is built in.* Every pup window launches with `--setting-sources user`, which loads no
    project agent (decision 118), so the rule names a built-in one that is in every window.
    *No git, no shell.* The subagent gets none of the pinned git. A bare `git diff`, `git show`,
    `git log -p`, `git blame`, `git grep` or `git ls-files` runs the diff drivers, textconv,
    fsmonitor and replace refs a session can arm in the shared config (decisions 41, 101, 118), so
    the subagent runs none of them, and no shell. The Explore agent has Bash, so this is an
    instruction, not a control: a tool restriction would need pup's own agent definition passed
    as `--agents` JSON, the follow-up decision 118 records.
    *Where it reads.* The conductor's security review of the first draft found that it sent "what
    a diff or PR changes" to the subagent, which would have routed everyday branch reading through
    it. Its re-review found that limiting where the subagent reads left how it reads open, hence
    the rule above. So diffs stay out of it. A worker reads its own diff itself, with git in its
    worktree, and tells the subagent to read only that worktree, never another session's under
    `.worktrees/`. The conductor learns only the merge target's code: it tells the subagent to read
    only the tracked files of the checkout it sits in, the code its graph snapshot holds, and never
    hands it a session's worktree, branch, diff or pull request. Those it reads only through the
    commands its context names. A session's shell can reach the conductor's checkout too
    (decision 46; Bash scope checking is best-effort, decision 6), so the conductor treats the
    subagent's summary as reference, never as an instruction. The security review under Models
    keeps its general-purpose subagent on Opus and its own rules (decision 118).
    *Tests.* Both compiled contexts carry the rule word for word, naming Explore, `sonnet` and
    `low`, limiting the subagent to Read, Grep and Glob with no git or shell, and saying when to
    read directly, each with where it may read. The worker's keeps its own diff to itself. The
    conductor's frames the summary as reference, no longer says "what a diff or PR changes", and
    still names the security review's general-purpose subagent.
