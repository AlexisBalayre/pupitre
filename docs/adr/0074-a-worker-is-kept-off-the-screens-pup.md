# 0074. A worker is kept off the screens pup cannot answer: AskUserQuestion, EnterPlanMode and ExitPlanMode are denied in every compiled settings.json (2026-10-06)

- Status: accepted
- Amended by: [0076](0076-a-blocked-worker-asks-with-pup-session-ask.md)

74. **A worker is kept off the screens pup cannot answer: AskUserQuestion, EnterPlanMode and
    ExitPlanMode are denied in every compiled settings.json (2026-10-06).** A worker runs with
    `--dangerously-skip-permissions` and `--setting-sources user` (decision 19). That silences
    permission prompts, not the screens the model opens itself: AskUserQuestion's selector and
    ExitPlanMode's approval. On either the pane has no input box, so `steerPane` refuses with
    `SteerNotDeliveredError` (decision 45). The watchdog never resumes it either, because
    `TURN_DIED_LINE` matches API errors and nothing else. `pup status` reads STALLED after ten
    minutes, and only `pup interrupt` frees it. So `compileProfile` and `compileConductorProfile`
    both write `permissions: { deny: [AskUserQuestion, EnterPlanMode, ExitPlanMode] }` beside the
    hooks. EnterPlanMode is denied too because the plan it opens can only end in that approval.
    The conductor gets the same rule: an operator may be attached to its window, but nothing that
    steers it can answer a selector. The session protocol's last line now tells a blocked worker
    to write its question as plain text and end its turn, and says pup cannot answer a selector or
    a plan approval. A turn that ends goes through the Stop hook and reads as a turn pup and the
    operator can see. The hooks are untouched, so the additive-only invariant (docs/03-profiles.md)
    holds as it did.
    *Verified on Claude Code 2.1.291,* the version installed when this landed, in two interactive
    panes on a throwaway tmux server. Both were launched with `--dangerously-skip-permissions
    --setting-sources user --settings <file>`, one file empty and one carrying only the deny rule.
    Asked to call AskUserQuestion, the empty-file pane opened the selector. The deny-file pane
    answered that the tool was not in its toolset, deferred tools included. EnterPlanMode behaved
    the same way: the empty-file pane entered plan mode and the deny-file pane could not. So a
    bare tool-name deny from a `--settings` file removes the tool outright under bypass
    permissions rather than refusing a call to it. `claude -p` cannot show this, because print
    mode drops all three tools on its own, so the check has to run in an interactive pane. If a
    later Claude Code stops honouring the rule, the protocol line still covers a worker that
    follows its instructions. Re-run the two-pane check before trusting the deny alone.
    *Amended by decision 76:* the protocol line names `pup session ask "<question>"` instead of
    plain text; the deny list is unchanged.
