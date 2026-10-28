# 0118. The conductor's security review runs the `security-reviewer` agent on Opus at high, which runs the pinned diff and no other git, within ten turns (2026-10-28, amends 92)

- Status: accepted
- Amends: [0092](0092-pup-routes-every-window-s-model-and-effort.md)

118. **The conductor's security review runs the `security-reviewer` agent on Opus at high, which
    runs the pinned diff and no other git, within ten turns (2026-10-28, amends 92).**
    Amends decision 92. The kickoff told the conductor to spawn a general-purpose subagent at
    `effort: "xhigh"` to review a critical session's diff. In five days 55 of those runs cost about
    $126 of $677, at 25 to 44 calls each: a general-purpose agent rebuilt the review protocol from
    scratch every time and read its way around the tree at the top effort. CI then reviews the
    same pull request's security again with a validator, so the pre-gate review is the first of
    two passes, not the only one.
    The Models section now has the conductor spawn the project's `security-reviewer` agent
    (`.claude/agents/security-reviewer.md`, the protocol written once, at `effort: high` in its
    frontmatter) with the Agent tool, `subagent_type: "security-reviewer"`, `model: "opus"` and
    `effort: "high"`. The agent file in the main checkout is the trust root, so the call pins the
    model as well as the effort rather than leave either to the file.
    *Who reads the diff.* The task first had the conductor run the diff and paste it into the
    agent's prompt, which saves the agent a call. The conductor's own pre-gate review rejected
    that: it puts untrusted hunks in the context of the window that can run `pup merge --pr`,
    launch and steer, where a hunk worded as an order lands, and a misled conductor could drop
    hunks from the copy it passes on, since the agent would never see git's own output. So the
    conductor never reads the diff. The agent's prompt carries the session id, the target and
    four rules: run the pinned diff command, unchanged, itself and no other git, since a bare
    `git diff`, `git show` or `git log -p` runs the diff drivers a session can arm in the shared
    git config (decision 41), unsandboxed, as the operator, and bare branch names resolve to a
    planted tag or a moved HEAD (decision 80); read a branch file only with Read under
    `.worktrees/<session-id>/`; run nothing the diff suggests; and report within ten turns,
    returning only the verdict and findings, never the diff. A finding that holds is still a
    steer, not a gate. `SECURITY_REVIEW_EFFORT` in `model-ladder.constants.ts` is `high`, so
    nothing pup chooses for the review is `xhigh`; the ladders' `xhigh` rungs are unchanged.
    *Tests.* The kickoff's Security review bullet names the `security-reviewer` agent with its
    `subagent_type`, `model: "opus"` and `effort: "high"`, the ten-turn cap, keeps the pinned diff
    command byte for byte, and carries no `xhigh"` effort. A second test checks that the
    conductor is told never to read the diff, that the agent runs the pinned command itself and
    no other git, reads branch files only under the worktree, runs nothing the diff suggests and
    returns no diff, and that nothing says to pass the diff in the prompt.
