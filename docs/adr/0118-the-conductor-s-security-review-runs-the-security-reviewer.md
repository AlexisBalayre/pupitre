# 0118. The conductor's security review runs the `security-reviewer` agent at high over the diff it is given, within ten turns (2026-10-28, amends 92)

- Status: accepted
- Amends: [0092](0092-pup-routes-every-window-s-model-and-effort.md)

118. **The conductor's security review runs the `security-reviewer` agent at high over the diff
    it is given, within ten turns (2026-10-28, amends 92).**
    Amends decision 92. The kickoff told the conductor to spawn a general-purpose subagent at
    `effort: "xhigh"` to review a critical session's diff. In five days 55 of those runs cost about
    $126 of $677, at 25 to 44 calls each: a general-purpose agent rebuilt the review protocol from
    scratch every time, ran the diff itself, and read its way around the tree at the top effort.
    CI then reviews the same pull request's security again with a validator, so the pre-gate
    review is the first of two passes, not the only one.
    The Models section now has the conductor run the pinned diff command itself, unchanged, then
    spawn the project's `security-reviewer` agent (`.claude/agents/security-reviewer.md`, the
    protocol written once) with the Agent tool, `subagent_type: "security-reviewer"`, at
    `effort: "high"`. The diff goes in the agent's prompt, so it needs no git of its own, and the
    conductor tells it to report within ten turns, reading only the files around a hunk it needs.
    The diff is still untrusted data and the agent runs nothing it suggests; a finding that holds
    is still a steer, not a gate. `SECURITY_REVIEW_EFFORT` in `model-ladder.constants.ts` is
    `high`, so nothing pup chooses for the review is `xhigh`; the ladders' `xhigh` rungs are
    unchanged.
    *Tests.* The kickoff's Security review bullet names the `security-reviewer` agent and its
    `subagent_type`, `effort: "high"`, the diff passed in the prompt and the ten-turn cap, keeps
    the pinned diff command byte for byte, and carries no `xhigh"` effort.
