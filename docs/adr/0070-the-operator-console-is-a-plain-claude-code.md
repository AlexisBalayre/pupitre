# 0070. The operator console is a plain Claude Code window carrying the shipped `pup` skill, not a fourth tier and not a `pup` subcommand (2026-09-24)

- Status: accepted

70. **The operator console is a plain Claude Code window carrying the shipped `pup` skill, not a
    fourth tier and not a `pup` subcommand (2026-09-24).** The operator asked for the same
    interface they have with Claude Code — ask questions, give orders — from any shell, scoped to
    the project around the cwd or, outside a repo, to the fleet. Three shapes were on the table. A
    fleet-level conductor: refused, because a conductor is keyed to one project by construction
    (its checkout, profile, socket and `PUP_CONDUCTOR` value, decision 47) and decision 43's
    addendum grants fleet reading to two readers only; a conductor that crossed stores would have
    the shape decision 47 refuses for the merge, a session acting on sessions under another name. A new
    tier with its own env marker, allowed `--project` but refused the merge: rejected, because
    every guard would grow a branch and the result would still not be the control the operator
    asked for. What was chosen is the observation that a Claude Code window the operator opens by
    hand carries neither `PUP_SESSION_ID` nor `PUP_CONDUCTOR`, so every `pup` command it runs is
    the operator's already (decision 43): the console is the operator's hands, and the gap was
    context, not privilege. The context ships as `skills/pup/` in this repo — `SKILL.md` for the
    vocabulary, the cwd rule and the tiers, `LOOP.md` for the per-task loop and the gotchas that
    bite every project — linked into `~/.claude/skills/` so it loads in any repo and outside them.
    The skill tells the console to check the two markers first: set by a launch, it is a session
    or the conductor and the operator stance does not apply. The GitHub merge stays the human's
    click: the console gates with `pup merge --pr`, which opens a pull request instead of the
    fast-forward of local main a plain `pup merge` performs (decision 26), so the branch still
    lands through the human's review, which is the reason decision 47 keeps the merge with the
    operator.
    *Deferred, with reasons:* `pup init` writing a repo-local copy of the skill
    with the project id and brief filled in, once a second project has used the linked one; a
    bare `pup` that opens `claude` in the calling terminal with the status snapshot preloaded,
    whose fleet kickoff would be a third exemption to decision 43's addendum and needs its own
    entry; and `pup conductor tell "<order>"` to replace pasting into the conductor's tmux pane.
    None is needed to use the console today, so none is built yet.
