# 0120. Fresh-base regenerates a conflicted ADR index in the gate's scratch checkout (2026-10-28)

- Status: accepted
- Amends: [0079](0079-git-safe-config-turns-off-signature-verification-not.md), [0109](0109-one-file-per-decision-under-docs-adr-numbered.md)

120. **Fresh-base regenerates a conflicted ADR index in the gate's scratch checkout
    (2026-10-28).** Decision 109 had every task that records a decision add a line to
    `docs/adr/README.md` between the `adr-index` markers. Two branches that each add one
    conflict there and nowhere else. The t-mvqj9sgx gate failed fresh-base on it ("Auto-merge
    of main hit conflicts" in that file), which sent the worker to hand-merge a file nobody
    edits by hand.
    *What resolves.* In both fresh-base paths (the `merge-tree --write-tree` merge into an
    open PR's branch, and the rebase of a branch with none, at each stop), the gate resolves a
    conflict when `docs/adr/README.md` is the only conflicted path, all three sides are
    regular files (mode `100644`) of at most 1 MiB, and each side holds each marker once, as a
    whole line, begin first. The text before and after the block merges whole: a region one
    side left as the base takes the other side's, and a region both sides changed keeps the
    refusal. The gate's scratch checkout (decision 81's) is cut from the conflicted tree
    committed unreferenced, and one sandboxed child writes the merged text, with an empty
    block, into it from stdin, then runs `scripts/adr-index.sh` from that tree to fill the
    block in. The output is opened without following a link or blocking on a fifo, must be a
    regular file of at most 1 MiB, and is hashed from that descriptor as git's stdin, before
    it is judged; its text outside the block must be the merged text. The open-PR path lists
    its conflicts from `merge-tree` without `-z`, which C-quotes any path holding a newline,
    tab or quote, so the report it hands the worker stays git's, a line each. A merge then
    commits the tree with that blob; a rebase stop puts the blob in the index,
    `checkout-index` writes the file, and `rebase --continue` runs with `GIT_EDITOR=:`. The
    scratch checkout goes before fresh-base ends, so the stages cut their own at the same
    path.
    *The stopped rebase.* `rebase --continue` reads its todo and options back from
    `rebase-merge/` in the worktree's admin dir, which the session can write (decision 101)
    and is alive to write while the script runs (decision 80), and it runs an `exec` step it
    finds in the todo in pup's own process. Reproduced on Apple Git 2.39.5: an `exec` line
    appended to a stopped rebase's todo runs at `--continue`. So the gate reads that state at
    the stop, before the script, and refuses it unless it is what its own rebase writes:
    regular files of at most 1 MiB only, each one git 2.39.5 leaves at a conflicted pick, a
    todo of `pick` steps and comments, a `strategy` file reading `ort`, and no
    `rebase-apply/` beside it, which `--continue` would take first. It reads the state again
    right before `--continue`, and a state changed since the stop is thrown to the operator
    with the rebase left stopped, since the abort reads that state too. What is left is
    decision 50's window between a check and the git call it guards, not the script's run.
    Finishing the picks in plumbing, as the open-PR path merges, would close it, but a
    cherry-pick in plumbing needs `merge-tree --merge-base`, which git 2.40 added, past the
    2.39.5 pup is verified against.
    *The rebase names its strategy (amending 79).* Decision 79 pinned `pull.twohead=ort`
    because it is the strategy git takes when argv names none. Git's sequencer takes the
    first value it reads, though, so a `pull.twohead` the session writes to the shared config
    beats the `-c` pin, and the rebase runs any strategy but `ort` as `git merge-<name>`,
    where a slash makes the name a path from the worktree. Reproduced on Apple Git 2.39.5: a
    local `pull.twohead` of `/../planted.sh`, with an empty `git-merge-` directory in the
    worktree, runs the planted script on the first pick of a rebase run under the pin, ahead
    of any stop and outside the sandbox. The gate's rebase now passes `--strategy=ort`, which
    the sequencer takes over any config, and which is the `strategy` file's one accepted
    text. The pin stays for every other git call.
    *What still refuses.* A conflict list of any other shape (another path, a link, a side
    that added or deleted the file) is not two added lines and keeps the existing fresh-base
    detail unchanged. An extra or missing marker, an oversized or non-UTF-8 side, a change
    outside the block on both sides, a script that fails (one missing from the tree
    included), output that is not a regular file of at most 1 MiB or changed the text
    outside the block, or a stopped rebase whose state holds more than a plain rebase writes
    (a newer git's extra file included, until the list names it) keeps that detail and adds
    a line naming why the index was not regenerated.
    *No merge driver.* Resolution is keyed on the path in pup's own code, and no
    `.gitattributes` entry, `merge.<name>.driver` or other config is added: decision 41 treats
    those as armed drivers, and the gate still refuses one. The scratch checkout is cut
    through `cutGateCheckout`, which checks the drivers first, and the rebase path checks
    them again before `checkout-index` and before a refused stop is reported, so a driver
    armed after the stop throws `ArmedGitDriverError` rather than reading as a plain conflict.
    Every way out of the rebase aborts what is left of it, except past an armed driver: the
    abort checks files out and would run it, so the rebase is left stopped for the operator.
    An `ArmedGitDriverError` in flight skips the abort outright, and the abort's own re-check
    and failure are swallowed, so neither replaces the error in flight (a
    `GateInterruptedError` included).
    *Security review.* The review of this change, and of any later one to it, must cover the
    scratch checkout (what is cut, what is written into it, what is read back and how), the
    script run, and the worktree's rebase state (what `--continue` reads back from the admin
    dir, and what the gate checks of it, and when). The script is the branch's own code, so
    it runs as a gate stage runs session code, through `runGateChild`: in the sandbox, with
    the env allowlist and the stage timeout (decisions 28, 36). A process the script starts
    in a session of its own outlives the run's kill and keeps its write grant on the
    checkout's path, which the next stop's checkout reuses, so nothing the gate does there
    after the cut may open a path by name: the README is written by the child, under its
    grants, and read back through the one descriptor checked, so a link swapped in can
    neither aim the gate's write out of the checkout nor have git store a file the sandbox
    denies where gate children read. Its output is then measured by every stage,
    `pnpm lint`'s `adr-index.sh --check` included, like any file the branch changed.
    *Tests.* In `merge-gate.test.ts`: a branch never pushed and an open PR's branch, each
    adding a decision while main adds another, merge with no worker action, and the merged
    index passes `adr-index.sh --check` on a checkout of the result. A stop that also
    conflicts in another file, and an index the branch made a link, keep the plain refusal.
    A preamble both sides changed, a second begin marker, a side over the cap, a tree with no
    script, a script that appends outside the block, and one that leaves a link or a fifo
    are each refused with the plain detail and the reason. A link swapped in for the README
    right before git hashes it still merges the README checked, and the file it names never
    reaches the object store; where pup applies its own sandbox, a link swapped in before the
    child writes leaves the file it names untouched. An open PR's plain refusal carries git's
    `CONFLICT` line on a line of its own. A smudge filter armed before the scratch
    checkout throws `ArmedGitDriverError`, never runs, and leaves the rebase stopped with no
    abort tried even once it is disarmed; one armed after a refused stop throws it too. A
    branch recording two decisions has both its stops resolved. A stop whose state holds an
    `exec` step, an option file such as `gpg_sign_opt`, a strategy other than `ort`, or a
    link is refused with the plain detail and the reason, `--continue` never runs and the
    `exec` step never does; an `exec` step or another `head-name` written while the script
    runs throws with the rebase left stopped, neither continued nor aborted. Beside the hook
    test, a session's `pull.twohead` naming a script through the worktree leaves the rebase
    on `ort`, and the script never runs.
