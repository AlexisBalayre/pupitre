# 0133. The ADR index is printed, not committed (2026-11-07)

- Status: accepted
- Amends: [0109](0109-one-file-per-decision-under-docs-adr-numbered.md), [0120](0120-fresh-base-regenerates-a-conflicted-adr-index-in-the.md)

133. **The ADR index is printed, not committed (2026-11-07).**
    Amends decisions 109 and 120. Decision 109 kept a generated one-line-per-decision index in
    `docs/adr/README.md`, so every PR that records a decision added a line at the same place, and
    every second such PR conflicted there. Decision 120 taught the merge gate to regenerate the
    block, but only on the gate's merge path: a conflict on GitHub, or in a hand rebase, still
    needed a hand merge of a file nobody edits by hand.
    `bash scripts/adr-index.sh` now prints the index from the decision files and the README
    holds none. `--check`, which `pnpm lint` runs, validates every file's title and status and
    fails when two files share a number, the collision that two PRs numbering from the same
    `origin/main` produce and that no merge conflict reports.
    A landed decision no longer gets an `Amended by:` line when a later one amends it: the
    amending file's `Amends:` is the link, and two PRs amending one decision conflicted on its
    header. Existing lines stay.
    *Decision 120's gate code goes.* With no markers in the README there is nothing for
    fresh-base to regenerate: a conflict in `docs/adr/README.md` is now an ordinary conflict
    and keeps the plain refusal. `regenerateAdrIndex` and its scratch checkout are deleted from
    the merge gate, along with their tests. The rebase pin 120 added to decision 79 stays.
