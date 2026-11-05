# 0021. Debt delta = three soft stages with a merge-time ratchet (2026-07-24)

- Status: accepted

21. **Debt delta = three soft stages with a merge-time ratchet (2026-07-24).** `dead-code`
    and `duplication` measure the whole branch worktree and compare against repo-wide
    values stored on the project baseline: the list of unused exports (only findings not
    already in the list flag) and the count of duplicated normalized lines (sliding
    6-line windows, adapter-implemented in lieu of jscpd). `complexity` needs no stored
    baseline: per touched file, decision points at the target (the locked main checkout)
    vs the branch, flagging any rise past a per-file threshold. All three follow
    diff-size semantics (decision 17) — flagged refuses the merge unless `--accept-debt`,
    which writes one ledger entry per flag. On every merged gate the stored debt baseline
    is set to the just-measured values: the docs/04 ratchet on improvement, and movement
    on accepted debt so later sessions aren't re-flagged for debt the ledger already
    owns. A missing capability or missing baseline reports the stage as skipped
    "not measured" (docs/06 degradation), never silently passed. Patch coverage
    (decision 13) is still pending.
