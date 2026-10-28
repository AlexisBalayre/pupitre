# 0120. Fresh-base regenerates a conflicted ADR index in the gate's scratch checkout (2026-10-28)

- Status: accepted
- Amends: [0109](0109-one-file-per-decision-under-docs-adr-numbered.md)

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
    *What still refuses.* A conflict list of any other shape (another path, a link, a side
    that added or deleted the file) is not two added lines and keeps the existing fresh-base
    detail unchanged. An extra or missing marker, an oversized or non-UTF-8 side, a change
    outside the block on both sides, a script that fails (one missing from the tree
    included), or output that is not a regular file of at most 1 MiB or changed the text
    outside the block keeps that detail and adds a line naming why the index was not
    regenerated.
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
    scratch checkout (what is cut, what is written into it, what is read back and how), and
    the script run. The script is the branch's own code, so it runs as a gate stage runs
    session code, through `runGateChild`: in the sandbox, with the env allowlist and the
    stage timeout (decisions 28, 36). A process the script starts in a session of its own
    outlives the run's kill and keeps its write grant on the checkout's path, which the next
    stop's checkout reuses, so nothing the gate does there after the cut may open a path by
    name: the README is written by the child, under its grants, and read back through the one
    descriptor checked, so a link swapped in can neither aim the gate's write out of the
    checkout nor have git store a file the sandbox denies where gate children read. Its
    output is then measured by every stage, `pnpm lint`'s `adr-index.sh --check` included,
    like any file the branch changed.
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
    abort tried even once it is disarmed; one armed after a refused stop throws it too.
