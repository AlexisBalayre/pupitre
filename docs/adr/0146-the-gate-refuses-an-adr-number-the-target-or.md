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
    blocked; decision 41) or `merged` with an open PR that has not landed (decision 84). Each
    refused file is one line of the stage's failure. The line names the other branch, the other
    file, or says the number is on the target, and gives the lowest free number above the
    target's highest: one that neither the target, any of those branches, nor the branch's own
    other decisions take. Several clashes get distinct numbers.
    *A refusal, not a rejection.* A clash is bookkeeping the worker settles by renaming a file,
    not a defect in the work, so it consumes no rejection: the gate records it as `refused`
    (`refuseGate`), the session keeps its state and its reject count, and nothing is steered.
    Run first, it also costs no suite. A re-gate of a merged session with an open PR is refused
    the same way, as every re-gate failure is.
    *Unreadable branches.* A competing branch git cannot read against the target is skipped
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
    target sha and branch sha the gate pinned, and the tip of each branch the store counts,
    resolved one at a time with `resolveCommitIfPresent` inside the guarded path. Nothing lists
    `refs/heads/pup/`, so no number of stray refs a session creates weighs on the gate, and a
    ref no countable session holds is never read. The branch names come from the store, which
    pup writes, and are resolved as `refs/heads/<branch>`, the way the gate resolves the
    session's own. Nothing is read from a worktree, which the live session can change
    (decisions 81, 101). The diffs turn off colour and external diff drivers, so a
    session-written config cannot change what they print, and list only `docs/adr/`, so a
    branch's other files are never buffered. The printed paths and branch names are scrubbed
    (decision 68).
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
    gate finds it.
    Tests: `adrNumberStage` adds no stage for a branch adding no decision, a free number, an
    edit to a decision already on the target or a slug-only rename of one. It refuses a number
    on the target, an unpaired file under the number of one the branch deletes (as a rename
    changed too much, though not when git paired that file with a renumbered one), a second
    file with one number, one a queued, running, awaiting-review, rejected or blocked session's
    branch adds, one a merged session with an open PR adds, and a decision renamed onto a taken
    number. It ignores killed sessions, landed PRs, local merges and `pup/` branches no session
    holds. It skips and names an orphan branch while still refusing a clash with another, a
    symbolic ref, a read Node killed for its timeout or buffer (read with the 10 s timeout),
    and a branch adding four decisions. It lets an interrupt that kills a competing diff
    through, refuses a slug rename another branch also makes of the same decision, gives each
    clash a distinct free number, suggests no five-digit number when 9999 is on the target, and
    reads the pinned shas rather than a branch moved after the pin or an untracked file. The
    gate refuses a clash after fresh-base with no build, test or lint stage, `rejectCount` and
    `reject_count` at 0, the session still awaiting review and no steer sent. A pass with an
    unread-branch note followed by a failed scope audit is a rejection, not a refusal.
