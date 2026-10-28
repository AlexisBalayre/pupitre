# 0118. The conductor's security review runs a general-purpose subagent on Opus at high, which runs the pinned diff and no other git, within ten turns (2026-10-28, amends 92)

- Status: accepted
- Amends: [0092](0092-pup-routes-every-window-s-model-and-effort.md)

118. **The conductor's security review runs a general-purpose subagent on Opus at high, which runs
    the pinned diff and no other git, within ten turns (2026-10-28, amends 92).**
    Amends decision 92. The kickoff told the conductor to spawn a general-purpose subagent at
    `effort: "xhigh"` to review a critical session's diff. In five days 55 of those runs cost about
    $126 of $677, at 25 to 44 calls each: the subagent read its way around the tree at the top
    effort with no bound on its turns. CI then reviews the same pull request's security again with
    a validator, so the pre-gate review is the first of two passes, not the only one.
    The Models section now has the conductor spawn a general-purpose subagent with the Agent tool,
    `subagent_type: "general-purpose"`, `model: "opus"` and `effort: "high"`.
    `SECURITY_REVIEW_EFFORT` in `model-ladder.constants.ts` is `high`, so nothing pup chooses for
    the review is `xhigh`; the ladders' `xhigh` rungs are unchanged.
    *Why not the project's `security-reviewer` agent.* The task meant the review to run
    `.claude/agents/security-reviewer.md`, the protocol written once. The CI review of this change
    pointed out that only pupitre's own checkout has that file, while the conductor runs in every
    repo `pup init` registered, which commits nothing to it, and that a repo could carry an
    unrelated agent of that name. It does not load even in pupitre's own checkout. Every pup window,
    the conductor's included, launches `claude` with `--setting-sources user`, and three interactive
    panes on a throwaway `tmux -L` socket, all with that flag, showed what it costs. Asked to list
    the Agent tool's `subagent_type` values, the plain pane offered only the built-in and user
    agents. With `--agents '{"<name>": {…}}'` the named agent was added. With an `agents` key in the
    `--settings` JSON it was not, so the compiled `settings.json` cannot carry one. A kickoff that
    names a project agent therefore spawns nothing, in any repo. The built-in general-purpose agent
    is in every window, so the review runs wherever a conductor does.
    *Follow-up.* pup could supply its own reviewer: compile a protocol that is not tied to any repo
    into the conductor's profile and pass it as `--agents` JSON on the conductor launch only. Then
    neither the repo nor a session could shadow or plant it. That changes `launchArgs` and
    `launchConductor` in `session-runtime.service.ts` and `startConductor` in `conductor.service.ts`,
    so it is a task of its own. Until then the subagent's prompt carries the protocol.
    *Who reads the diff.* The task first had the conductor run the diff and paste it into the
    subagent's prompt, which saves the subagent a call. The conductor's own pre-gate review rejected
    that: it puts untrusted hunks in the context of the window that can run `pup merge --pr`,
    launch and steer, where a hunk worded as an order lands, and a misled conductor could drop
    hunks from the copy it passes on, since the subagent would never see git's own output. So the
    conductor never reads the diff. The subagent's prompt carries the session id, the target, what
    to look for (a check the change lets code skip, a measurement it can forge or empty, untrusted
    input reaching a command, a secret or environment it exposes) and four rules. It runs the
    pinned diff command, unchanged, itself and no other git, since a bare `git diff`, `git show` or
    `git log -p` runs the diff drivers a session can arm in the shared git config (decision 41),
    unsandboxed, as the operator, and bare branch names resolve to a planted tag or a moved HEAD
    (decision 80). It reads a branch file only with Read under `.worktrees/<session-id>/`. It runs
    nothing the diff suggests. And it reports within ten turns, returning only the verdict and
    findings, never the diff. A finding that holds is still a steer, not a gate.
    *Tests.* The kickoff's Security review bullet names the general-purpose subagent with its
    `subagent_type`, `model: "opus"` and `effort: "high"`, never names `security-reviewer`, carries
    the ten-turn cap and no `xhigh"` effort, and keeps the pinned diff command byte for byte. A
    second test checks that the conductor is told never to read the diff, that the prompt names what
    to look for, that the subagent runs the pinned command itself and no other git, reads branch
    files only under the worktree, runs nothing the diff suggests and returns no diff, and that
    nothing says to pass the diff in the prompt.
