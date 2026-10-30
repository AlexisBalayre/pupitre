# 0129. Workers and the conductor learn the code through an Explore subagent on Sonnet at low effort, confined to code no other session can write, and read a file only to edit it or for its exact lines (2026-10-30)

- Status: accepted

129. **Workers and the conductor learn the code through an Explore subagent on Sonnet at low
    effort, confined to code no other session can write, and read a file only to edit it or for
    its exact lines (2026-10-30).**
    Every call a window makes re-reads its whole context. On 2026-10-26, contexts averaged 136k
    tokens for a worker and 158k for the conductor. Reading and searching code was about 26% of a
    worker's re-read tokens and 39% of the conductor's. A subagent's call costs about half a
    main-session call, and only its summary enters the window that spawned it.
    A compiled worker context and the conductor's context now each have an `## Exploring code`
    section with one shared rule. To learn the code, the window spawns an Explore subagent with
    the Agent tool, `subagent_type: "Explore"`, `model: "sonnet"` and `effort: "low"`, and keeps
    only its summary. It reads a file itself only when it will edit it or needs its exact lines.
    *Explore is built in.* Every pup window launches with `--setting-sources user`, which loads no
    project agent (decision 118), so the rule names a built-in one that is in every window.
    *What the subagent may read.* The subagent gets none of the pinned git. A bare `git diff` or
    `git show` runs the diff drivers, textconv, fsmonitor and replace refs a session can arm in the
    shared config (decisions 41, 101, 118), and a low-effort reader of a session's code would hand
    the window a summary of attacker-written text as trusted output. The conductor's security
    review of the first draft found that the draft sent "what a diff or PR changes" to the
    subagent, which would have routed everyday branch reading through it. So each window confines
    it. A worker learns its own code and its own diff, and tells the subagent to read only its
    worktree, never another session's under `.worktrees/`. The conductor learns only the merge
    target's code: it tells the subagent to read only the tracked files of the checkout it sits
    in, the code its graph snapshot holds, and never hands it a session's worktree, branch, diff or
    pull request. Those it reads only through the commands its context names. The security review
    under Models keeps its general-purpose subagent on Opus and its own rules (decision 118).
    *Tests.* Both compiled contexts carry the rule word for word, naming Explore, `sonnet` and
    `low` and saying when to read directly, each with its confinement. The conductor's no longer
    says "what a diff or PR changes" and still names the security review's general-purpose
    subagent.
