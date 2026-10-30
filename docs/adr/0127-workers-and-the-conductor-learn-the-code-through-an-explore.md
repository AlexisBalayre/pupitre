# 0127. Workers and the conductor learn the code through an Explore subagent on Sonnet at low effort, and read a file only to edit it or for its exact lines (2026-10-30)

- Status: accepted

127. **Workers and the conductor learn the code through an Explore subagent on Sonnet at low
    effort, and read a file only to edit it or for its exact lines (2026-10-30).**
    Every call a window makes re-reads its whole context. On 2026-10-26, contexts averaged 136k
    tokens for a worker and 158k for the conductor. Reading and searching code was about 26% of a
    worker's re-read tokens and 39% of the conductor's. A subagent's call costs about half a
    main-session call, and only its summary enters the window that spawned it.
    A compiled worker context and the conductor's context now share one `## Exploring code`
    section. To learn the code (where something lives, how a module works, what a diff or PR
    changes), the window spawns an Explore subagent with the Agent tool, `subagent_type:
    "Explore"`, `model: "sonnet"` and `effort: "low"`, and keeps only its summary. It reads a file
    itself only when it will edit it or needs its exact lines.
    *Explore is built in.* Every pup window launches with `--setting-sources user`, which loads no
    project agent (decision 118), so the rule names a built-in one that is in every window.
    *The security review is unchanged.* The conductor's copy adds that the security review under
    Models is not this rule. It keeps its general-purpose subagent on Opus and its own rules
    (decision 118), since it reviews untrusted hunks and not code the conductor wants to learn.
    *Tests.* Both compiled contexts carry the section word for word, naming Explore, `sonnet` and
    `low` and saying when to read directly. The conductor's still names the security review's
    general-purpose subagent.
