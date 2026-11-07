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
    refuses a number the target's `docs/adr/` still holds at a path the branch keeps, a number
    the branch adds in two files, and a number another session branch adds over its own merge
    base with the target. A number whose target file the branch removes is a rename of that
    decision, so a slug-only rename passes. The other branches count only when their session
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
    *Unreadable branches.* A competing branch git cannot diff against the target, an orphan
    commit with no merge base say, is skipped rather than failing the gate of every other
    session. The stage names it, scrubbed, in a line of its detail: a pass stage when nothing
    else clashed, the failure's last line when something did. A branch that adds no decision,
    or only free numbers with every branch read, gets no stage at all, so its stage list is as
    before.
    *Reads.* Everything is read from pinned shas in the main checkout's repo through `runGit`
    (decision 73): the target sha and branch sha the gate pinned, and each other branch's tip as
    one `for-each-ref refs/heads/pup/` listing gives it. Nothing is read from a worktree, which
    the live session can change (decisions 81, 101). The store decides only which listed refs
    count, so no store text reaches git as a revision. A ref no countable session holds is
    ignored. The diff turns off colour and external diff drivers, so a session-written config
    cannot change what the listing prints. The printed paths and branch names are scrubbed
    (decision 68).
    *Ceilings.* Two sessions that took one number each refuse the other until one renumbers:
    whoever gates first is not given the number. Numbers can be squatted: a live session that
    commits a range of decision files takes those numbers from every peer until it renumbers,
    lands or is killed, and nothing caps how many it holds. Every session's worktree shares the
    one `.git`, so its `refs/heads/pup/*` are one ref store any session can write: a session can
    move a peer's branch to add numbers in its name, or move it to hide what the peer added,
    and the check reads whatever those refs hold at gate time. A sibling that has not committed
    its decision yet cannot be seen, so the check narrows the race to the window between two
    commits rather than closing it. A branch merged with no PR leaves the store's countable
    states with its number on the target, where the next gate finds it.
    Tests: `adrNumberStage` adds no stage for a branch adding no decision, a free number, an
    edit to a decision already on the target or a slug-only rename of one. It refuses a number
    on the target, a second file with one number, one a queued, running, awaiting-review,
    rejected or blocked session's branch adds, one a merged session with an open PR adds, and a
    decision renamed onto a taken number. It ignores killed sessions, landed PRs, local merges
    and `pup/` branches no session holds, skips and names an orphan branch while still refusing
    a clash with another, gives each clash a distinct free number, and reads the pinned shas
    rather than a branch moved after the pin or an untracked file. The gate refuses a clash
    after fresh-base with no build, test or lint stage, `rejectCount` and `reject_count` at 0,
    the session still awaiting review and no steer sent.
