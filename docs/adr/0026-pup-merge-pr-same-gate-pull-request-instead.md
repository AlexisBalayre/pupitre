# 0026. `pup merge --pr` = same gate, pull request instead of local merge (2026-07-25)

- Status: accepted

26. **`pup merge --pr` = same gate, pull request instead of local merge (2026-07-25).**
    Dogfooding pupitre on itself showed the collision: `pup merge` ff-merges local main,
    but PR-only repos land through their hosting platform, and routing around the gate
    silently skips the debt ratchet (observed live: PR #24 added a dead export the gate
    would have flagged). With `--pr`, a passing gate pushes the session branch to
    `origin` and opens a pull request via the operator's `gh` CLI (interactive login,
    decision 12 — never tokens; availability and an `origin` remote are checked before
    the gate runs, not after ten minutes of stages). The destination is pinned: `--repo`
    is derived from the origin URL, so a forked clone can never open the PR against the
    upstream parent and `GH_REPO`/`GH_HOST` cannot retarget it. PR title/body are
    mechanical — goal, acceptance, commit subjects, and the full gate report — for humans
    to edit on GitHub; commit subjects and gate details quote session-authored text, so
    those sections are fenced and render inert (no `Closes #n` auto-closing, no @mention
    pings, no invisible HTML comments aimed at review bots). `--pr` is operator-only: the
    CLI refuses it when `PUP_SESSION_ID` is set, since a session opening outward-facing
    PRs under human attribution is exactly the audit-trail lie the ledger must not tell.
    Everything else keeps decision-16 semantics: session → `merged` (redefined as "passed
    the gate and left pupitre's custody"), task done, decision record drafted, tmux +
    worktree + local branch cleaned (`-D`; the commits live on origin). The debt baseline
    does NOT ratchet — the target branch has not moved, so moving the bar would misjudge
    concurrent sessions; the next `pup audit` after the PR lands ratchets it instead.
    Known gaps, accepted: between PR-open and PR-merge an `--accept-debt` flag is in the
    ledger but not yet in the baseline (a concurrent session gets re-flagged for it); a
    PR closed without merging leaves a `merged` session whose commits never landed — the
    remote branch still holds them; and a gh failure after the push is not idempotent to
    retry (the branch is already on origin, and a second `--accept-debt` run re-inserts
    ledger entries) — probe-before-push idempotency is deferred (resolved by decision 27).
