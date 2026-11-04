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
    So the rule is now about content, for every shape of merge. `pup land` computes the tree git
    would produce by merging the pinned content onto the commit GitHub's merge went onto (`git
    merge-tree --write-tree`), and takes the merge only when that tree id is the one GitHub's
    commit holds. A merge commit or a squash went onto the merge commit's first parent and is
    checked against merging the pinned sha there; a merge commit is checked too, not taken on
    ancestry, since one carrying a change of its own still contains the pinned sha. A rebase
    merge replays the pinned branch's own commits, the ones the pinned sha has that the merge
    commit lacks, and GitHub reports its last one, so the base is the first parent that many
    commits down and each replayed commit's tree is checked against merging its own pinned commit
    onto that base. Checking the last tree alone would take a squash that also undid another PR
    landed just before it: that other commit plus the squash read as a two-commit replay onto
    main's older tip, with the pinned tree exactly. The rebase shape is tried before the squash
    shape, which a rebase's last commit matches too, so the landed files the overlap steer reads
    (decision 99) are every replayed commit's and not the last one's alone. A merge that added,
    dropped or altered anything the gate did not measure gives another tree and refuses, and so
    does one that conflicts. The check runs from the scratch git dir the fetch runs from, with the
    same pins, for decision 54's reason: a merge runs the drivers its attributes and config name,
    and neither the repo's `info/attributes` nor the shared config a session can write is read
    there. It also runs with `core.commitGraph=false`, since the commit graph is a cache in the
    object store a session can write. A git failure there refuses with nothing landed.
    Every other refusal stays: a PR not `MERGED`, merged into another base, or with its head moved
    past the pin (a squash of a moved head included, since GitHub reports the moved head), a merge
    commit origin's target does not hold, a foreign url, and a local target with commits origin
    lacks. The refusals decision 84 made on ancestry, a target or merge commit without the pinned
    sha, go: every merge commit is judged by its tree. Then the land runs as before: the local
    target is fast-forwarded, the audit runs unchanged, and the `landed` event records GitHub's
    commit. The session's branch is deleted when main holds every commit of it, or when it is an
    ancestor of the pinned sha whose content landed, so a squash-merged session is cleaned up too;
    a branch past the pin is still kept.
    Tests: a squash of the pinned content onto a main another PR moved lands, fast-forwards main,
    deletes the branch, audits and records the event; a rebase merge of a two-commit pin onto a
    moved main lands and steers with both commits' files; a squash with an extra, a missing or an
    altered change refuses with nothing landed, and so do a squash of a two-commit pin that drops
    the other PR's change, a squash of a pin that conflicts with the moved main, and a merge
    commit with a change of its own; a merge driver armed in the repo's `info/attributes` and
    config does not run during the check, where the repo's own `git merge-tree` runs it; a merge
    commit over a head that moved past the pin still refuses.
