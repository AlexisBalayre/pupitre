# 0164. `pup land` takes a moved head on the operator's word (2026-11-09)

- Status: accepted
- Amends: [0084](0084-pup-land-session-closes-the-github-half-of.md), [0086](0086-pup-merge-session-pr-re-gates-a-merged.md), [0131](0131-pup-land-takes-a-squash-or-rebase-merge-whose-tree.md)

164. **`pup land` takes a moved head on the operator's word (2026-11-09).**
    Decision 86 lets a re-gate vouch for a PR head that moved past the pin, but only while the
    PR is open. Once GitHub has merged it at the moved head, nothing can vouch for it. `pup
    merge --pr` refuses a MERGED PR, and `pup land` refuses a head other than the pin. The
    session stays merged and never lands, which is where t-mw6hh1hz and t-mvry2mew were stuck.
    *The rule.* `pup land <session> --accept-head <sha>` lands such a PR when `<sha>` is the
    full head GitHub reports for it. The flag names that commit and no other: one naming
    anything else is refused, even when the PR merged at the pin. Under the merge lock the land
    fetches the PR's head ref GitHub keeps (`refs/pull/<n>/head`) from the recorded origin. The
    fetch goes through the same scratch git dir and the same call as the target. The land then
    needs three things:
    - The ref is at the accepted head. The local branch is not read, since a session can move it.
    - The pin is an ancestor of the accepted head. A head that rewrote the gated commits, such as
      a fix round's rebase, is not "the gate's content plus commits the operator read", and is
      refused.
    - The merge commit has the tree that merging the accepted head gives, where decision 131 asked
      for the pin's tree. Merge, squash and rebase merges are all taken that way.
    The teardown deletes the branch when main or the accepted head holds it. The `landed` event
    is unchanged.
    *Who may pass it.* Only the operator. The flag vouches for commits no gate measured, and
    that is the merge's power, which the conductor does not hold (decision 47). The conductor
    can still run a plain `pup land`. Without the flag, the refusal still names the re-gate.
    It also gives the fetch and `git log -p <pin>..<head>` to read, and the exact command to run.
    *Not taken.* Gating the moved head inside `pup land`. That means a gate checkout, a sandbox
    run and the stages under the land's lock, all of which `runMergeGate` owns. Then the
    land would also have to decide what a failed stage does to a PR GitHub has already merged.
    Letting `pup merge --pr` re-gate a MERGED PR was not taken either. Its pass rewrites the PR
    description and records a new pin, which means nothing once the PR has closed. A plain
    boolean flag was rejected too. It would also cover a head that moved again between the
    operator's read and the land.
