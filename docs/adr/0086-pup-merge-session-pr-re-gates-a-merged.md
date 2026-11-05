# 0086. `pup merge <session> --pr` re-gates a merged session whose open PR took a fix round, so `pup land` can land it (2026-10-16, amends 84)

- Status: accepted
- Amends: [0084](0084-pup-land-session-closes-the-github-half-of.md)
- Amended by: [0090](0090-pup-fix-session-hands-the-ci-review-s.md)

86. **`pup merge <session> --pr` re-gates a merged session whose open PR took a fix round, so
    `pup land` can land it (2026-10-16, amends 84).**
    A `--pr` merge pins one sha and the PR vouches for it alone (decision 82), so once an operator
    pushed a CI fix round to the PR (#144, #146) its head moved past the pin, the gate refused the
    session as no longer awaiting review, and `pup land` refused the merge as landing commits the
    gate never measured: such a PR could never land. Now `pup merge <session> --pr` also takes a
    session in state `merged`, when its newest `merge` event carries a `prUrl` and a pinned sha with
    no `landed` event after it. Before the lock, as a first `--pr` gate settles adoption (decision
    27), the url must be a pull request of origin's recorded repo (the check `pup land` makes,
    now shared as `assertPullRequestOf`), the event's target must be the branch the main checkout
    is on, `gh pr view` must report the PR `OPEN` with a head other than the pin, and the open PR
    `findOpenPullRequest` finds for the branch, past its fork, base and auto-merge checks, must be
    that same url. A head that does not descend from the pin is allowed, since a fix round can
    rebase. Each refusal names why (no PR, a local fast-forward; already landed; `CLOSED`;
    `MERGED`, pointing at `pup land`; head still at the pin, pointing at merging and landing) and
    says nothing was re-gated; nothing is written. Without `--pr` a merged session is refused as
    before. Under the lock the local branch is pinned first and must be at the head GitHub
    reported, since the stages read local objects and no rebase follows; a branch elsewhere or
    missing refuses, naming both, before any stage. Then every stage runs on that pin from the
    gate's checkout (decision 81), except two: `worktree-clean` is skipped and says so, since the
    session's worktree went with the first merge, and `fresh-base` fails instead of rebasing a head
    not based on the target, since there is no worktree to rebase in and a rebased head would no
    longer be the one the PR shows. A failing stage or an unaccepted flag refuses as a flagged
    merge does, with a `gate_result` refused event and status `refused`: the session has no window
    to re-steer and no state to fall back to, so it stays `merged`, the reject count is untouched,
    and the earlier `merge` event stays the newest. On a pass the PR is adopted the usual way, its
    description rewritten with the new report and the gated sha, and its head read back and
    required to equal the new pin; nothing is pushed, since the pin is the head GitHub already
    shows, and a lease on a tracking ref the fix round's own push left behind would refuse. Then a
    `gate_result` moving `merged` to `merged` logs the report for every reader of the newest gate
    run, and a new `merge` event records the new sha, the same `prUrl` and the target. Nothing the
    first merge did repeats: no tmux kill, worktree removal or branch delete (the branch is left
    for `pup land`'s teardown, which deletes it once the target holds it), no ratchet (decision 26
    keeps PR mode off it), no decision-record draft, and no ledger entry for a flag the session
    already holds open. The stages measure the whole branch, so a flag the first gate filed comes
    back with the figures the fix round moved (`Oversize diff (812 lines)` after 780); a flag
    whose description, figures dropped, matches an open entry this session filed is not filed
    again, while a new kind is. `--accept-debt` is still asked for: the human sees the flags with
    their new figures, as on any retry. The debt candidates leave out the session's own entries,
    which a re-gate or a retry would otherwise offer to close. `pup land` reads the newest `merge`
    event, so it lands the re-gated head unchanged. Its refusals are amended: an `OPEN` PR whose
    head is not the pin is refused naming `pup merge <id> --pr`, ahead of the plain not-`MERGED`
    refusal, and a PR merged over a moved head says such a PR is re-gated before it is merged.
    `pup merge` prints `Re-gated <id>` with the PR on a pass, and on a hard failure names the
    stage, says the PR still vouches for the earlier pin, and gives the push-then-re-run retry.
    LOOP.md's CI review step ends with the re-gate after a pushed fix round.
    Tests: against a real repo, a bare origin and a fake gh, a `--pr` gate then a fix round pushed
    from a review worktree is re-gated with every stage passing on the new head (a build that needs
    the fix round's file), a second `merge` event with the new sha and the same url, the session
    still merged, a `merged`-to-`merged` gate result, the PR edited and read back at the new pin,
    origin's branch untouched and no draft; a `CLOSED` PR, a `MERGED` one and a head still at the
    pin each refuse writing no event and editing no PR; a merge with no PR refuses asking gh
    nothing; a landed session refuses; a merged session without `--pr` keeps the old refusal; a
    local branch past the PR head refuses before any stage; a failing build refuses with the first
    merge event newest and nothing steered; a head not based on the moved target fails
    `fresh-base`; an accepted oversize diff re-gated larger files no second entry. `pup land`
    lands a PR GitHub merged at the head a real re-gate pinned, and refuses an open PR whose head
    moved naming the re-gate. The CLI prints both new lines.
    *Amended 2026-10-16 (PR #147 review):* "figures dropped" means only the measured figures, where
    each description shape the gate files carries them: the digits inside the parenthesised group
    right before `merged from session <id>` (`(812 lines)`, `(+3 decision points)`,
    `(patch coverage 71.0% below baseline 80.0%)`), the `rose from N to M` of
    `Duplicated lines … in session <id>`, and the file count of
    `Coverage unmeasured over N changed source file(s) in session <id>`. A digit anywhere else is
    part of the kind, so a nested-package flag for `packages/app2` is a new kind
    beside an open one for `packages/app1` and is filed, where every digit run read as `#` had
    taken it for held. And a re-gate refused only for an unaccepted flag gets its own line: it
    names the flagged stages, says the PR still vouches for the earlier pin, and says to re-run
    `pup merge <id> --pr` with `--accept-debt` (or fix on the branch, push and re-gate), never to
    steer, which a merged session cannot take; the flagged stage's own hint drops the steer for a
    re-gate likewise. The CLI picks every re-gate wording from `regated`, set on `MergeOutcome` by
    the core on a re-gate's pass and refusal, rather than reading the session's state itself.
    Tests: a re-gate flagging `src/app2` beside an open entry for `src/app1` files a second entry
    (the existing oversize test still files none for moved figures), and a held duplication flag
    and a held unmeasured-coverage flag, re-flagged with moved figures, each file none; a re-gate flagging without
    `--accept-debt` refuses with `regated`, no ledger entry, no merge event, no PR edit and no
    steer in the hint; the CLI prints the accept-debt line with no steer from an outcome alone,
    with no merged session in the store.
    *Amended 2026-10-16 (debt #49):* the re-gate lives in `src/core/regate.service.ts`.
    `mergeToRegate`, `planRegate`, `regateMerged` and `pinRegatedHead` moved there unchanged from
    `merge-gate.service.ts`, which #147 and #148 had taken from 133 to 176 decision points; it
    measures 150 after the move. `runMergeGate` still decides between a gate and a re-gate, and
    the gate helpers the re-gate shares (`measureBranch`, `refuseGate`, `fileAcceptedDebt`,
    `recordMerge`, `debtKind` and the rest) are exported from `merge-gate.service.ts`, so the two
    modules import each other; every use sits inside a function body, so neither reads the other
    while loading. `planRegate` returns a `RegatePlan`, whose `regate` field is no longer an
    optional part of every `PullRequestPlan`, and `regateMerged` takes that plan alone instead of
    the plan and its `regate` field. `COMMIT_SHA` is defined once, in `merge-gate.constants.ts`,
    and the dashboard imports it instead of keeping its own copy. No behaviour changed: every
    re-gate test asserts what it did, the refusals that throw before writing share
    `expectRefusedUnwritten`, and the two that delete the local branch share one teardown helper.
