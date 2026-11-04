# 0130. `pup land` takes a squash or rebase merge whose tree is exactly the pinned content merged onto its base (2026-11-04)

- Status: accepted
- Amends: [0082](0082-three-edges-the-decision-80-review-left-open.md), [0084](0084-pup-land-session-closes-the-github-half-of.md)

130. **`pup land` takes a squash or rebase merge whose tree is exactly the pinned content merged
    onto its base (2026-11-04).**
    Amends decisions 82 and 84. Decision 84 refused every squash or rebase merge, reading decision
    82's "the PR vouched for the pinned sha only" as "origin's target must contain the pinned
    sha". That made `pup land` unusable on a repo that squash-merges, as this one does (#212 and
    #220 could not be landed), and it was stricter than its reason: what the gate measured is the
    pinned content, and a squash that carries exactly that content lands nothing the gate did not
    measure, while a merge commit over a moved target, which decision 84 takes, lands the same
    merged content under another shape.
    So the rule is now about content. When GitHub's merge commit contains the pinned sha nothing
    changes. When it does not, `pup land` computes the tree git would produce by merging the pinned
    sha into the commit the merge went onto (`git merge-tree --write-tree`), and takes the merge
    only when that tree id is the merge commit's own. A squash went onto the merge commit's first
    parent. A rebase merge replays the pinned branch's own commits, as many as the pinned sha has
    that the merge commit lacks, and GitHub reports its last one, so that commit's tree is checked
    against the first parent that many commits down; that base is tried before the first parent,
    which a rebase matches too, so the landed files the overlap steer reads (decision 99) are
    every replayed commit's and not the last one's alone. A squash or rebase that added, dropped or
    altered anything the gate did not measure gives another tree and refuses, and so does a merge
    that conflicts. The check runs from the scratch git dir the fetch runs from, with the same
    pins, for decision 54's reason: a merge reads its drivers from config, and the shared config a
    session can write is never read there.
    Every other refusal stays: a PR not `MERGED`, merged into another base, or with its head moved
    past the pin (a squash of a moved head included, since GitHub reports the moved head), a merge
    commit origin's target does not hold, a foreign url, and a local target with commits origin
    lacks. The refusal decision 84 added for a merge commit that does not contain the pinned sha
    while origin's target does, "the pinned commit reached the target some other way", goes: such a
    merge commit is now judged by its tree like any squash. Then the land runs as before: the local
    target is fast-forwarded, the audit runs unchanged, and the `landed` event records GitHub's
    commit. The session's branch is deleted when main holds every commit of it, or when it is an
    ancestor of the pinned sha whose content landed, so a squash-merged session is cleaned up too;
    a branch past the pin is still kept.
    Not covered: a squash whose base is several commits down yet whose commits in between, by
    someone else, are undone by the squash itself would match at that depth; the tree main ends on
    is still exactly the pinned content merged onto a commit of main.
    Tests: a squash of the pinned content onto a main another PR moved lands, fast-forwards main,
    deletes the branch, audits and records the event; a rebase merge of a two-commit pin onto a
    moved main lands and steers with both commits' files; a squash with an extra, a missing or an
    altered change each refuses with nothing landed; a merge commit over a head that moved past the
    pin still refuses.
