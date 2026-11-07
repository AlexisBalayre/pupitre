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
    *The rule.* The scope audit (`measureBranch`) also asks `adrNumberRefusals` in
    `src/core/adr-number.service.ts`. It takes every `docs/adr/NNNN-*.md` the pinned branch
    adds over its merge base with the target, rename detection off so a renumbering `git mv`
    counts as the add of its new name. It refuses a number already in the target's
    `docs/adr/`, and a number another session branch adds over its own merge base with the
    target. The other branches count only when their session can still land: a state that holds
    its scope (queued, running, awaiting review, rejected, blocked; decision 41) or `merged`
    with an open PR that has not landed (decision 84). Each refused file is one line of the
    scope-audit failure. The line names the other branch, or says the number is on the target,
    and gives the lowest free number above the target's highest: one that neither the target,
    any of those branches, nor the branch's own other decisions take. Several clashes get
    distinct numbers. A branch that adds no decision, or only free numbers, passes as before,
    with the same stage list.
    *Reads.* Everything is read from pinned shas in the main checkout's repo through `runGit`
    (decision 73): the target sha and branch sha the gate pinned, and each other branch's tip as
    one `for-each-ref refs/heads/pup/` listing gives it. Nothing is read from a worktree, which
    the live session can change (decisions 81, 101). The store decides only which listed refs
    count, so no store text reaches git as a revision. A ref no countable session holds is
    ignored. The diff turns off colour and external diff drivers, so a session-written config
    cannot change what the listing prints. The printed path and branch name are scrubbed
    (decision 68).
    *Ceilings.* Two sessions that took one number each refuse the other until one renumbers:
    whoever gates first is not given the number. A re-gate of a merged session with an open
    PR is refused the same way when a later session took its number. A sibling that has not committed its decision yet cannot be seen, so the check
    narrows the race to the window between two commits rather than closing it. A branch merged
    with no PR leaves the store's countable states with its number on the target, where the
    next gate finds it.
    Tests: `adrNumberRefusals` passes a branch adding no decision, a free number and an edit to
    a decision already on the target. It refuses a number on the target, one a queued, running,
    awaiting-review, rejected or blocked session's branch adds, one a merged session with an
    open PR adds, and a decision renamed onto a taken number. It ignores killed sessions,
    landed PRs, local merges and `pup/` branches no session holds, gives each clash a distinct
    free number, and reads the pinned shas rather than a branch moved after the pin or an
    untracked file. The gate fails its scope audit on a clash, naming the other branch.
