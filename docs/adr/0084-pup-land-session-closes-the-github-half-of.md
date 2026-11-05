# 0084. `pup land <session>` closes the GitHub half of a `--pr` merge, and the conductor may run it (2026-10-14)

- Status: accepted
- Amended by: [0086](0086-pup-merge-session-pr-re-gates-a-merged.md), [0088](0088-the-merge-lock-records-its-holder-survives-every.md), [0090](0090-pup-fix-session-hands-the-ci-review-s.md)

84. **`pup land <session>` closes the GitHub half of a `--pr` merge, and the conductor may run it
    (2026-10-14).**
    A `--pr` merge stops at the pull request: main does not move, the baseline is not ratcheted
    (decision 26), and what was left to do once the human merged on GitHub was the operator's by
    hand: pull, clean the worktree and branch the gate's best-effort teardown may have left, run
    `pup audit`, and nothing told the store the PR had landed. `pup land <session>` does it, with
    the logic in `land.service.ts` and the CLI thin. Every refusal comes before anything moves, and
    each says nothing was landed: the session must be in state `merged` with a `prUrl` and a pinned
    sha on its newest `merge` event, and no `landed` event after it; the url must be a pull request
    of the repo the recorded origin names (it is store text, and another repo's merged PR would
    otherwise vouch for it), compared without case within ASCII because GitHub prints the repo in
    its canonical case; the row's id must have the minted shape and its worktree and branch must be
    the ones the launch derives from it, since they are what gets removed; `gh pr view <url> --repo
    <pin> --json state,headRefOid,baseRefName,mergeCommit`, called the way `github.client.ts` calls
    gh, must say `MERGED` into the target with the head still at the pinned sha; and the target
    fetched from origin must contain the merge commit, which must contain the pinned sha. A squash
    or rebase merge therefore refuses, and so does a merge commit over a head that moved past the
    pin, GitHub's own "Update branch" included: each lands commits the gate never measured, and the
    PR vouched for the pinned sha only (decision 82); decision 86 makes that refusal name the
    re-gate, and refuses an open PR whose head moved before it is merged. The fetch reads origin from the URL `pup init`
    recorded, refused on a live value that moved exactly as the push is (decision 56), and runs from
    the scratch git dir the push uses, borrowing the repo's object store and lending the local tip
    as a ref, so the shared config a session can write is never read (decision 54), with auto
    maintenance and the commit graph off so a fetch there never runs a gc, or writes a cache, from
    the scratch dir's refs alone, and the ext protocol pinned off. Then, under the merge lock, the
    local target is fast-forwarded with the gate's plumbing (`fastForward`, decision 80), after the
    same checks the gate makes before its checkout: the main checkout on the target, checked on both
    paths since the audit measures that checkout, and no driver armed. A local target with commits
    origin lacks refuses; one already at or past origin's tip is left alone. The tracking ref is
    written last under the lock, so every refusal leaves the repo's refs as they were.
    `withMergeLock` holds a SIGINT and SIGTERM listener while the lock is held, and only then: a
    terminal Ctrl-C reaches node and the child git alike, and with no listener node's default
    disposition dies in the middle of the call, leaving the lock behind; with one, node survives,
    the child's failure unwinds the stack and the `finally` releases the lock. The listener's body
    never runs, since a synchronous body never yields to the event loop that dispatches it, so a
    signal sent to pup alone, which kills no child, is discarded and the locked section runs to its
    end. Decision 95 makes the gate's locked body asynchronous: there an interrupt is forwarded
    to every stage child and the lock is released in the gate's `finally`. A git child an
    interrupt killed is not read as git's answer to the ancestry checks, the symref probes, the
    worktree removal, the branch read or the branch delete (not an ancestor, a locked worktree):
    the land stops before the audit and the `landed` event, and a re-run picks up
    where it stopped. The gate swallows an interrupted branch delete, which it reaches only after
    the merge landed, so the branch stays and the ratchet still runs. A git that crashed on its own
    keeps the catch's fallback. The audit runs outside the lock with
    node's default disposition, so a Ctrl-C there ends the land before it is recorded. A lock a
    killed process strands, by SIGKILL or a crash, is a change of its own. The session's worktree is
    removed, when git still registers it, the way `pnpm worktree:clean` removes one whose PR merged;
    one `--force` cannot remove, a session having locked its own, is kept together with its branch
    and named as such, since deleting the branch a surviving worktree has checked out would leave it
    on a branch that does not exist. Otherwise its branch is deleted only while main holds every
    commit of it, with the old value and `--no-deref` like the gate's delete; a branch with later
    commits is kept and named. Then `auditProject` runs, as `pup audit` would and printed the same
    way, except that a regressed measurement is reported and the baseline kept, since the conductor
    may run this and no human then stands between an observed regression and the bar; `pup audit`,
    which the operator runs, still ratchets (decision 48). Then a `landed` event records the merge
    commit GitHub made, the target and the url, which the needs-you inbox reads to drop the PR
    (decision 83) whatever this checkout has pulled. A failure part-way is safe to re-run: each step
    skips what is already done, and the event is written last. `landed` is added to `EventPayloads`
    for its payload, and to `EventRow` and `appendEvent` as `StoredEventType = EventType |
    'landed'`, until `EventType` itself takes it. The `--pr` merge's closing line names `pup land
    <session>` instead of `pup audit`.
    The conductor may run it: the human decision, merging the PR, already happened on GitHub, and
    what is left moves main only to what origin holds, so it is the bookkeeping decision 75 lets the
    conductor relay, not the local fast-forward decision 47 keeps from it. A session is refused, as
    it is refused `pup audit`: landing picks the moment the baseline moves.
    Tests: against a real repo, a bare origin and a fake gh, the land fast-forwards main to GitHub's
    merge commit with the checkout clean, records the tracking ref, removes the worktree and branch,
    stores a baseline, appends the event and empties the inbox, and asks gh with the pinned repo; a
    second land refuses; a branch with a later commit is kept; a session not merged, a merge with no
    PR, a url outside origin's repo, an `OPEN` or `CLOSED` PR and a squash merge each refuse with
    main, the worktree, the branch, the baseline and the event untouched. `pup land` refuses a
    session and runs for the conductor, prints a refusal scrubbed, and `pup status` stops listing
    the PR once the event exists.
