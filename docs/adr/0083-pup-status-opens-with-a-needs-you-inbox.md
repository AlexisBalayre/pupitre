# 0083. `pup status` opens with a needs-you inbox, and finished sessions move behind `--history` (2026-10-14)

- Status: accepted
- Amended by: [0090](0090-pup-fix-session-hands-the-ci-review-s.md), [0102](0102-while-the-project-s-conductor-runs-a-session.md)

83. **`pup status` opens with a needs-you inbox, and finished sessions move behind `--history`
    (2026-10-14).**
    The table answered "what is running", sorted blocked and stalled first, and left the operator to
    work out from each row's state what they were meant to do, while every merged and killed session
    the project ever ran stayed on it for good. Now `pup status` prints a `Needs you` section before
    everything else, the conductor and overdue debt included, and prints nothing for it when nothing
    waits. One line per session: its id, the reason, and the one thing that answers it, in this
    order: an open question from `pup session ask` (`pup steer <id> "..."`), blocked (`pup unblock
    <id>`), stalled (`pup steer <id> "..."`, the reason worded as the row words it, a dead turn
    included, so the two never describe one stall two ways, decision 52), awaiting-review (`pup
    review <id> then pup merge <id> --pr`), and a merged session whose newest `merge` event carries
    a `prUrl`, whose pinned sha the target branch of this checkout does not yet hold, and with no
    `landed` event after it (the url). The order is what leaving each costs: a question idles a
    worker that has said why, a block or a stall one that has stopped, a review and an open PR only
    hold finished work back. A session is listed once, under its first reason. A merge with no
    `prUrl` is a local fast-forward, already on the target, so it is never an open PR. Whether the
    target holds the sha is the one thing the snapshot asks git: the store cannot know what the
    operator's pull did, and without the check every PR the project ever opened stayed listed (found
    on CI review). One `rev-list --missing=print` per open PR, which walks without fetching what it
    meets and names what it lacks, so a pruned pinned commit reads as open rather than reached. The
    shared config can name a promisor remote whose fetch would run a planted command with pup's
    environment, and `protocol.allow` alone is only the fallback a local `protocol.<name>.allow`
    overrides (found on security and CI review), so the walk runs with every transport git ships
    pinned off and `GIT_NO_LAZY_FETCH` set, which only git 2.44 and later honour, and the target's
    tip is read under the same pins and without peeling. Under a two-second timeout; a landed answer
    is kept for good and a not-landed one until the target's tip moves, across snapshots and in a
    cache cleared whole at 4096 entries, so the work follows the PRs still open and not the
    refreshes. A target that is not a plain branch name or a sha that is not hex, as the store can
    write them, is not asked about, and that, a missing object, a timeout and a repo with no such
    branch all read as not landed. A merge recorded before the sha was kept (decision 80) predates
    every open PR and counts as landed. The answer is what the conductor acts on, so a url is
    printed only in the pull-request shape, a session id outside the minted shape, judged on the raw
    row, neither prints nor gets a command built around it, and a question's non-ASCII symbols,
    every arrow and emoji among them, are rewritten while its `+ < = > |` stay; the line still
    shows, saying to inspect the store. Nothing writes `landed` yet; `pup land` will, for the merges
    git cannot see, a squash among them, and the snapshot reads the type as stored text until it
    joins `EventType`. Only the newest merge counts, like the dossier's "what landed".
    The live table and the backlog follow as before, but rows in state `merged` or `killed` are left
    out and printed only with `pup status --history`; a project whose sessions have all finished
    prints its inbox, if any, then `Nothing running and nothing planned.`. The snapshot itself is
    unchanged in shape, so `pup ui` draws as it did: the session row only gains `isMintedId` and an
    optional `openPr`, and the inbox is `needsYou(snapshot)`, a reading off the snapshot that
    `fleetSummary` carries and the fleet view prints, reason and answer, so the fleet lists the same
    lines in the same order (blocked now before stalled, and questions and open PRs added). The
    conductor reads `pup status`, so it sees the same inbox. Decision 90 lets `pup status` word an
    open PR's line from the CI review on its head (open threads, or a clean status), only under the
    bot's `SUCCESS` status there. A piped `pup ui` prints the default table, without history.
    Tests: the snapshot's inbox lists one session of each kind in the order, each with its reason
    and answer, whatever order they were seeded in; a dead turn is worded as the row words it; a
    stalled session that asked is listed once, as the question; a merge without a PR, a PR with a
    `landed` event after it, and an older PR under a newer local merge are not listed; a planted url
    is scrubbed. `pup status` prints the inbox before the overdue debt line, prints no header when
    nothing waits, hides merged and killed rows by default and prints them with `--history`.
    *Amended by decision 102:* while the project's conductor runs, an awaiting-review session is
    left out of the inbox unless its gate was refused.
