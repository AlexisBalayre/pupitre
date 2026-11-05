# 0075. The conductor gates a branch with `pup merge --pr`, and accepted debt names its approver (2026-10-06)

- Status: accepted
- Amends: [0047](0047-a-conductor-session-is-the-operator-s-delegate.md)

75. **The conductor gates a branch with `pup merge --pr`, and accepted debt names its approver
    (2026-10-06).** Settled while grilling Copiste, which drives pupitre as the conductor tier
    with no human in its VM: the human reviews on GitHub and approves flagged debt from a
    Telegram click. Decision 47 refused the conductor the whole merge, so every finished branch
    waited on an operator shell that Copiste does not have. What decision 47 protects is main,
    and `--pr` never moves main: the gate runs, the branch is pushed, and a human merges the PR.
    So a conductor caller (`PUP_CONDUCTOR`) is now allowed `pup merge <s> --pr` and still refused
    the local fast-forward, with the old wording plus "Use --pr to gate it and open a pull
    request". A session is refused both, as before (decision 44).
    *`--accept-debt` gains `--approved-by <who>`.* The ledger's `accepted_by` was always
    `'human'`, true while only the operator could reach that line. A conductor accepting debt is
    relaying someone else's call, so it must name the approver (`tg:alexis`), and `pup merge`
    refuses before the gate runs when it does not. The operator may name one too, and defaults
    to `human` as before. `--approved-by` without `--accept-debt` is refused, and so is a value
    that scrubs to nothing: an empty approver must not read as the operator's `human`.
    *The approver is scrubbed before it is stored,* not only where it prints (decision 68). The
    CLI scrubs it before the request is built, and `runMergeGate` scrubs `acceptedBy` again where
    it writes the ledger entry, because that is the seam every caller shares. `pup debt` and the
    report already scrubbed the column on the way out.
    *The value is the conductor's word,* at decision 27's ceiling, like `PUP_CONDUCTOR` itself:
    pupitre cannot check that the Telegram click happened. What the field buys is an honest
    trail: an entry no longer claims the operator approved a debt the operator never saw.
    Two edges closed on review: the conductor may not pass `human` as the approver, since that
    is the operator's own entry and the trail would read as the operator's; and the ledger's
    open-entry dedupe no longer keys on `accepted_by`, so a `--pr` retry after a partial
    failure with a different approver does not file the same debt twice — the first approver
    stands.
    *Closed on 2026-10-13 (PR #140):* the conductor's compiled kickoff
    (`profile-compiler.service.ts`) was out of this task's scope and still refused `pup merge`
    outright; it now orders the gate on every finished branch, `pup merge <session-id> --pr`
    once a session is `awaiting-review` and meets its acceptance criteria, with the PR link
    reported and a human merging, and says the conductor relays an approval and never gives
    one. `pup merge` takes a session id, which is not the task id after a relaunch.
