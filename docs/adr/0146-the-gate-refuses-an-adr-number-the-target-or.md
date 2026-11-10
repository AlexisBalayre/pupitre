# 0146. The gate refuses an ADR number the target or another open session branch already takes (2026-11-07)

- Status: accepted

146. **The gate refuses an ADR number the target or another open session branch already takes
    (2026-11-07).**
    Workers number a new decision from the target, as `docs/adr/README.md` tells them, so
    parallel sessions pick the same number. On 2026-11-07 PRs #224 and #237 both added
    `docs/adr/0132-*.md`, and two more sessions picked 0135. Git shows no conflict, because the
    file names differ, and a number is the decision's identity: every "decision N" elsewhere
    would name two decisions. Since the index stopped being committed (decision 133), no file
    the two branches share is left to conflict over, so nothing else stops the second landing.
    *The rule.* An `adr-number` stage, `adrNumberStage` in `src/core/adr-number.service.ts`,
    runs first in `measureBranch`, before the gate's checkout is cut and before build, test and
    lint. It takes every `docs/adr/NNNN-*.md` the pinned branch adds over its merge base with the
    target, rename detection off so a renumbering `git mv` counts as the add of its new name. It
    refuses a number the target's `docs/adr/` holds, a number the branch adds in two files, and
    a number another session branch adds over its own merge base with the target. A slug-only
    rename passes the target check: a file git pairs as the rename of a target decision keeping
    its number (`--find-renames`, by content) is that decision under a new name. It is still
    checked against the other branches, since two that each rename one decision, `0002-x` to
    `0002-a` and to `0002-b`, would leave the target two files under 0002; the refusal names the
    other branch and asks for one name, not a new number. A branch that deletes a target
    decision and adds a file under its number that git does not pair with it is refused as on
    the target. Since that is most likely a slug rename that changed too much of a short file to
    pair, the line says so and asks for the ADR's text kept closer to the original rather than a
    new number. Git pairs on the branch's whole diff against the target, so splitting the change
    across commits does not help. The other branches count only when their session
    can still land: a state that holds its scope (queued, running, awaiting review, rejected,
    blocked; decision 41) or `merged` with a PR that has not landed (decision 84), open or, since
    nothing records a close, closed unmerged (see *Ceilings*). The refusal says only what the
    store knows, that the other branch is live or its PR has not landed. A live
    session is read at its branch. A merged one is read at the sha its newest merge event
    pinned. A passing gate normally deletes the session's local branch, in both modes, and
    only the operator's `pup fix` restores it. It keeps the branch with a worktree it could not
    remove, or when the branch moved past the gated sha, and such a branch may then hold
    commits the PR does not. The sha is read rather than the branch or the remote-tracking ref
    the push wrote, because pup recorded the sha and any session can move either ref. A
    re-gate records a new merge event, so the newest one is the PR's current head. A merge event with no sha, one whose sha is not a full commit sha (`COMMIT_SHA`:
    anchored, exactly 40 lowercase hex digits or 64), one whose commit the repo lacks, or one
    whose commit git cannot diff against the target, fails the stage closed, under its own
    heading. Nothing else in the repo holds what that PR adds, so passing would let a clash
    through unseen. A commit the repo holds can still be undiffable: a session can write the
    PR's sha into the shared `shallow` file, which `GIT_HISTORY_ENV` does not pin (decision 89),
    and so cut its merge base, or it can delete one of the commit's loose objects. Unlike a live
    branch, which is skipped when unreadable (below), a PR's gated commit is fixed and was read
    at its own gate, so a failed diff of it is refused, not skipped. The line names the branch
    and the PR, whose url is withheld unless it has a pull request's shape (decisions 29, 83).
    For a missing commit it says to fetch the PR's head into the repo. For an undiffable one it
    names the likely causes and says to repair the repo, since fetching would not help. A branch
    that adds no decision never reaches this check, so such a peer blocks only ADR-adding gates,
    until its PR lands or its commit is readable again. Each
    refused file is one line of the stage's failure. The line names the other branch, the other
    file, or says the number is on the target, and gives the lowest free number above the
    target's highest: one that neither the target, any of those branches, nor the branch's own
    other decisions take. Several clashes get distinct numbers.
    *A refusal, not a rejection.* A clash is bookkeeping the worker settles by renaming a file,
    not a defect in the work, so it consumes no rejection: the gate records it as `refused`
    (`refuseGate`), the session keeps its state and its reject count, and nothing is steered.
    Run first, it also costs no suite. A re-gate of a merged session with an open PR is refused
    the same way, as every re-gate failure is.
    *Unreadable branches.* A live competing branch git cannot read against the target is skipped
    rather than failing the gate of every other session: an orphan commit with no merge base, a
    symbolic ref, or a read past its 10 s timeout or git's output buffer. Node kills an overrun
    child with SIGTERM, the signal `rethrowIfKilled` reads as an interrupt, so an overrun
    (`ETIMEDOUT`, `ENOBUFS`) is told apart first; any other killed read is rethrown, so Ctrl-C
    stops the gate. A competing branch that adds more than three decisions is skipped too,
    unchecked: no session needs more in one task, and counting them would let one branch refuse
    every peer. The stage names each skipped branch, scrubbed, in a line of its detail: a pass
    stage when nothing else clashed, the failure's last lines when something did. A branch that
    adds no decision, or only free numbers with every branch read, gets no stage at all, so its
    stage list is as before.
    *Reads.* Everything is read in the main checkout's repo through `runGit` (decision 73): the
    target sha and branch sha the gate pinned, the tip of each live branch the store counts,
    and each open PR's recorded sha (checked against `COMMIT_SHA`), resolved one at a time with
    `resolveCommitIfPresent` inside the guarded path. Nothing lists
    `refs/heads/pup/`, so no number of stray refs a session creates weighs on the gate, and a
    ref no countable session holds is never read. The branch names come from the store, which
    pup writes, and are resolved as `refs/heads/<branch>`, the way the gate resolves the
    session's own. Nothing is read from a worktree, which the live session can change
    (decisions 81, 101). The diffs turn off colour and external diff drivers, so a
    session-written config cannot change what they print, and list only `docs/adr/`, so a
    branch's other files are never buffered. Every session shares the one `.git` config, so a
    session can set `core.worktree` and give git a cwd prefix: a bare `docs/adr/` pathspec or
    ls-tree path would then match nothing and the check would pass. The diffs pass
    `--no-relative` and the pathspec `:(top,literal,icase)docs/adr/`, anchored at the root, glob
    free and case blind, and ls-tree runs with `--full-tree`. Replace refs need nothing here:
    `GIT_SAFE_CONFIG` already pins `core.useReplaceRefs=false`.
    *Names.* A decision file is exactly `docs/adr/NNNN-<slug>.md`: lowercase `docs/adr/`, four
    ASCII digits, a dash, a slug and a lowercase `.md`. The diffs list `docs/adr/` case-blind, and
    every added path under it that is neither that form nor `docs/adr/README.md` (the one other
    file on the target) is refused under its own heading naming the expected form. A case-only
    misspelling such as `docs/ADR/0147-x.MD` or `docs/adr/0148-z.MD` is told the lowercase
    path to write instead. The refusal is what keeps the target's listings sound: ls-tree takes
    no `icase` magic and reads the exact-case `docs/adr/`, so a `docs/ADR/0147-x.MD` that landed
    would be invisible to every later gate, and `docs/adr/0147-y.md` would pass beside it in
    the one folder a case-insensitive host gives them. Nested paths (`docs/adr/0146/x.md`,
    `docs/adr/0147-y.md/README.md`), non-ASCII digits, a leading space, `00146-x.md`,
    `0146_x.md`, `adr-0146-x.md` and non-Markdown files are refused the same way.
    *Ceilings.* Two sessions that took one number each refuse the other until one renumbers:
    whoever gates first is not given the number. Numbers can be squatted: a live session that
    commits up to three decision files takes those numbers from every peer until it renumbers,
    lands or is killed. Every session's worktree shares the one `.git`, so its
    `refs/heads/pup/*` are one ref store any session can write: a session can move a peer's
    branch to add numbers in its name, or move it to hide what the peer added, and the check
    reads whatever those refs hold at gate time. With the cap of three per branch, a squatter
    holds at most three numbers per countable branch it can write, and since a clash is a
    refusal that consumes no rejection, the block never escalates on its own: the refusal names
    the branch, and the operator settles it, by killing the squatter if need be. The free
    number is searched above the target's highest and only up to 9999: past that a refusal says
    no four-digit number is free rather than suggest a five-digit name the check would not
    recognise. A sibling that has not committed its decision yet cannot be seen, so the check
    narrows the race to the window between two commits rather than closing it. A branch merged
    with no PR leaves the store's countable states with its number on the target, where the next
    gate finds it. An open PR's gated commit is kept reachable only by the remote-tracking ref
    the gate's push writes, `refs/remotes/origin/<branch>`, once it has (normally) deleted the local branch
    and the worktree with its reflog. That ref is not pup's alone. A `git fetch --prune` after
    the remote branch is deleted removes it, any session sharing the `.git` can move it, and
    `git gc` may then prune the commit once it is older than the prune window. Pinning the
    commit under a ref of pup's own, written when the gate opens the PR, would need `pup land`
    and the session teardown to delete that ref, and those are outside this decision. Until a
    decision adds that pin, a pruned commit refuses every ADR-adding gate, as above, rather
    than being read as having added nothing. A PR closed without merging counts for as long as
    its session is in the store, because the store records no close. `pup land` writes `landed`
    only for a `MERGED` PR. `merged` is terminal, so `pup kill` refuses it. `pup fix` and the
    re-gate refuse a closed PR. The gate does not ask GitHub, which under the merge lock would
    add a network read per such peer to every gate that adds a decision. So a closed PR keeps
    its up to three numbers from every later gate, including a decision redone in a new session
    under the same number. Once its commit is pruned, it refuses every ADR-adding gate as an
    unreadable PR until its head is fetched again, which GitHub keeps for a closed PR as
    `refs/pull/<n>/head`. Until then the way out is to renumber, or to fetch that head. Retiring a
    closed PR needs a terminal event, written by `pup land` or an operator command, that
    `newestMerge` reads like `landed`. That is outside this decision.
    Tests: `adrNumberStage` adds no stage for a branch adding no decision, a free number, an
    edit to a decision already on the target or a slug-only rename of one. It refuses a number
    on the target, an unpaired file under the number of one the branch deletes (as a rename
    changed too much, though not when git paired that file with a renumbered one), a second
    file with one number, one a queued, running, awaiting-review, rejected or blocked session's
    branch adds, one a merged session with an open PR adds (read at its recorded sha after the
    gate deleted its branch, and refused, naming the branch and the PR, when that merge recorded
    no sha, a malformed one, a commit the repo lacks, or a commit git cannot diff because it is
    parentless or a `shallow` file cuts its history, with a url that is not a pull request's
    withheld), and a decision renamed onto a taken
    number. It ignores killed sessions, landed PRs, local merges and `pup/` branches no session
    holds. It skips and names an orphan branch while still refusing a clash with another, a
    symbolic ref, a read Node killed for its timeout or buffer (read with the 10 s timeout),
    and a branch adding four decisions. It lets an interrupt that kills a competing diff
    through, refuses a slug rename another branch also makes of the same decision, gives each
    clash a distinct free number, suggests no five-digit number when 9999 is on the target, and
    reads the pinned shas rather than a branch moved after the pin or an untracked file. The
    check still refuses both kinds of clash with `core.worktree` pointed at the repo's parent,
    refuses `docs/ADR/0003-x.MD` though 0003 is free, naming `docs/adr/0003-x.md`, and refuses
    every other added path under `docs/adr/` (the ten spellings above, `.MD` with its lowercase
    path named) while passing `README.md` and a well-formed decision beside them. The gate refuses a clash after
    fresh-base with no build, test or lint stage, `rejectCount` and
    `reject_count` at 0, the session still awaiting review and no steer sent. A pass with an
    unread-branch note followed by a failed scope audit is a rejection, not a refusal.
