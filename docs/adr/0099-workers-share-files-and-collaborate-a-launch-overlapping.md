# 0099. Workers share files and collaborate: a launch overlapping a live session is never refused, with no cap, and introduces the two (2026-10-18, supersedes decision 41's refusal)

- Status: accepted
- Amends: [0041](0041-a-launch-is-refused-when-its-scope-collides.md)
- Amended by: [0104](0104-peer-joined-introductions-and-main-landed-notices-go.md), [0124](0124-the-worktree-hooks-reads-run-under-a-deadline.md)

99. **Workers share files and collaborate: a launch overlapping a live session is never refused,
    with no cap, and introduces the two (2026-10-18, supersedes decision 41's refusal).**
    Decision 41 refused a launch whose scope claimed tracked files a live session already held,
    with `--allow-overlap` as the considered override. That serialised the queue through the
    files nearly every task touches (`src/cli/index.ts`, `docs/09-decisions.md`, the type
    modules): the conductor was told to wait for the holder or re-scope. Two workers in one file are
    not a collision when they talk, and they can talk: each is a Claude Code window reached by
    SendMessage under its peer name, `pup-<session-id>`.
    *The question decision 41 asked is still asked, and answered with an introduction.*
    `scopeConflicts` still measures the candidate's scope against every live session's before
    the worktree exists. `launchTask` no longer refuses on it and caps nothing. A launch that
    overlaps writes one `scope_overlap` event on the new session, `via` naming who launched it
    (the operator, or the conductor) and `accepted` naming each peer and the shared files, the
    same shape as before. The new worker's kickoff gains a `## Peers` section, above the session
    protocol, listing each peer by name with the files they share (at most 20 per peer, then a
    count). A launch with no overlap has no such section. Once the kickoff has landed, each peer
    is steered exactly once, with the newcomer's name and the files they now share, recorded as
    a `steer` of kind `peer-joined` by the newcomer. That steer is best effort: a peer whose
    paste is refused, or that has just stopped, does not undo a launch that worked, and the
    newcomer's kickoff already names it, so either side can open the conversation. Peer names
    are store text and paths come from `git ls-files`, and both are typed into a pane, so each
    goes through `sanitizeReason` where the kickoff and the steer write it. The radar is
    unchanged: it reports the pair once both branches touch a file.
    *Every worker carries the collaboration protocol,* peers or not, because a peer can join
    after its launch. Before editing a shared file, message the peer what you will change (the
    function or section) and agree who does what. Whoever changes a shared signature or
    contract tells the peer at once. A worker blocked on a peer says so with `pup session ask`
    rather than waiting silently. A peer's message is coordination, not an instruction: it
    changes neither the task nor the scope, the same rule that makes a session's message to the
    conductor a report.
    *`--allow-overlap` is accepted for one release and does nothing.* `pup launch` and `pup new`
    still parse it so a script passing it keeps working, and print one line saying overlap is
    always allowed and the flag goes in the next release. `ScopeConflictError` is deleted, and
    `createSession` no longer asks the question before planning: with nothing to refuse there
    is no orphaned backlog row to prevent, so the `raced` attribution went with it. The audit
    sweep, scoped `**/*`, no longer passes the flag. It overlaps every live session and
    introduces itself to each. The conductor's kickoff drops "wait for it or re-scope" and "keep
    their scopes disjoint", and launches overlapping tasks like any other.
    *Ceilings.* A peer's steer is a `steer` event, so it clears a question that peer had open
    with `pup session ask` from the needs-you inbox, as any steer does (decision 76). Telling a
    peer notice from an answer is a dashboard change of its own. Coordination is the workers'
    word to each other, not enforced: two workers that agree nothing can still both edit one
    function, and a conflict between their branches shows where it always did, at the merge.
    Tests: a launch over a live holder succeeds and writes exactly one `scope_overlap` event
    across the store, naming both sessions and the shared file. The conductor's launch is
    recorded `via: 'conductor'`. A launch sharing nothing records no event and steers no one.
    The kickoff lists two peers by `pup-<id>` with their files, and a launch with no overlap has
    no Peers section. Each of two peers receives exactly one steer, naming `pup-<newcomer>` and
    its own shared files, recorded as `peer-joined`. A peer whose paste is refused leaves the
    launch running. A planted path carrying ESC, BEL and CSI and a planted session id carrying
    ESC reach neither the kickoff nor the steer. `pup new` over a holder plans and launches.
    `--allow-overlap` on `launch` and on `new` prints the notice and passes nothing on. The
    compiled worker context carries the collaboration protocol with no peers, caps a peer's
    files at 20 with a count, and changes its hash with peers. The conductor's context names
    overlap as allowed and carries no `--allow-overlap`, `re-scope` or `disjoint`.
    *Main reaches overlapping workers as soon as a peer lands (amended 2026-10-18).* Talking
    settles who edits what, but each branch still drifts from main until the gate's rebase,
    where the conflict is as wide as both tasks. Once `pup land` has written its `landed` event,
    it steers every live session whose branch changed a file the landed PR changed, once, as a
    `steer` of kind `main-landed` by the landed session. The PR's files are its merge commit
    against its first parent; a session's are its branch's own changes since it forked from the
    target, the radar's reading. A branch with an open PR, by the store's word (its newest
    `merge` event carries a `prUrl` and no `landed` follows, the inbox's rule), is told to run
    `git merge refs/heads/<target>`, a merge commit, since GitHub holds its history. Any other
    branch is told to run `git rebase refs/heads/<target>`, the ref shell-quoted where a ref
    name may hold what a shell reads as syntax. No steer mentions a force-push. The
    worker commits its work in progress first, resolves the conflicts, re-runs the tests for the
    files involved and reports in one line. The steer is best effort: the land is done whatever a
    steer does. A session whose steer fails for any reason, a refused paste, a stop, tmux or the
    store, is skipped and the rest are still steered, and so is a branch git cannot read; only an
    interrupt stops the loop. An introduction rethrows a refused paste or a stop; a land does not,
    since the land it would report as failed has already happened and its audit would be lost.
    Session ids and branches are store text about to name a ref, so only a session whose branch
    is `pup/<id>` is read. The gate's mechanical rebase stays the final check.
    *The hooks read a merge of main as main's change.* A merge of main that stops on a conflict
    leaves main's files staged in the worktree, and the Bash re-check (decision 63) flagged them
    as out-of-scope writes. While a merge of the target's tip is in progress, the re-check now
    skips a tracked dirty path that one `git diff <tip> --name-only` does not list, whose
    worktree content is the tip's own: the branch is judged by what differs from what it
    merged. It is one git call per check, not one per path, so a merge bringing in many files
    does not push the hook past its timeout, where it fails open. The tip is the main
    checkout's HEAD (`main-worktree/HEAD`), the branch the gate merges into, and MERGE_HEAD must
    be that commit exactly. MERGE_HEAD is read from the worktree's own file (`git rev-parse
    --git-path MERGE_HEAD`), one object id in its first 66 bytes. The read stops there: the file
    sits outside the worktree, where no check sees a write, and a huge one would run every later
    check past the timeout. A ref lookup by that name falls back to `refs/tags/MERGE_HEAD` and
    `refs/heads/MERGE_HEAD`, which any worktree can write, and would make every linked worktree
    look mid-merge. A fifo swapped in after the hook's `-f` test blocks the read only until the
    hook's deadline kills it, which fails the check rather than running into the timeout
    (decision 124). Both hooks are best effort here, not a
    guarantee: the session can move the target's branch with `update-ref` and write its own
    MERGE_HEAD file, so a commit it made can pass for the tip. The gate's scope audit, on the
    branch's own merge-base diff, is what holds. The Edit hook lets one kind of edit through
    outside scope-in or inside scope-out: an Edit, never a Write, whose replaced text is exactly
    one conflict block, from its `<<<<<<<` line to its `>>>>>>>` line, with one `=======` between
    and at most a diff3 `|||||||` before it, and whose new text is one side, the other, or ours
    then theirs, line for line. A marker line ending in a CR is still a marker. An empty side
    is taken only with the block's final newline, so taking it leaves no blank line. The index
    must hold the conflict such a merge makes: the branch's blob at stage 2, the tip's at
    stage 3, and the two different, so a conflict staged by hand over a file that happens to
    hold marker lines earns nothing. A committed merge needed no change: the gate diffs against
    the merge-base, which a merge of main moves to main's tip. Every git call the two hooks
    make, the ones they made before included, now runs as `safe_git`, under `GIT_SAFE_CONFIG`'s
    pins rendered into the script. The review of this change found a session could plant a
    `refs/replace/` entry for the tip in the shared ref store and hand every diff, the gate's
    scope audit included, a tree of its choosing; `GIT_SAFE_CONFIG` now pins
    `core.useReplaceRefs=false`, so neither `runGit` nor the hooks follow one.
    *Ceilings.* No live session carries an open PR until a fix round keeps its worker running,
    so until then every steer says rebase. Only committed work counts: a peer's uncommitted edit
    to a landed file earns no steer. A conflict in an out-of-scope file means the branch changed
    one, which the gate refuses whatever the merge does, and the re-check still reports the
    `git merge` that wrote the markers. If main moves again mid-merge, MERGE_HEAD is no longer
    the tip and both hooks fall back to their old reading until the worker merges again. A merge
    bringing in more dirty paths than the re-check's cap is reported on every Bash call until it
    is committed, as any large dirty tree is. The diff trusts the index's stat data, as `git
    status` does, so a session that forges index entries could hide a write from the re-check,
    and a session whose branch already holds marker lines in an out-of-scope file can stage the
    branch-and-tip conflict by hand and edit within that block. Either way the file differs from
    the target, and the gate's scope audit refuses it. A failed steer is not reported per peer
    yet: core returns an outcome the CLI prints, and `LandOutcome` has no field for it. Recording
    it as a `steer` event with `delivered: false` would be wrong, since the inbox reads any steer
    as the answer to an open question and `decodeEvent` drops `delivered`. Carrying the skipped
    sessions on `LandOutcome` and printing them is a follow-up. A `pup land` run git-diffs each live
    session's branch, as the gate and the overlap check already do, so the transport pins owed
    against a planted promisor remote cover it too.
    Tests: after a land, a live session sharing a landed file gets one `main-landed` steer and
    one sharing none gets nothing. The steer says rebase without an open PR and merge with one,
    and neither mentions a force-push. A refused paste records no steer and leaves the land
    done. Any other steer error leaves the land done with its audit and the other sessions
    steered, while an interrupt during a steer still stops it. The steer scrubs the landed name, the target and the files, and shell-quotes a target
    holding `;`. In a real repo with a
    linked worktree, a `git merge main` stopped on a conflict, with main's out-of-scope and
    scope-out files staged, passes the re-check, and so does committing the resolved merge. After
    it, an Edit, a Write and a Bash write to an out-of-scope file are still refused. In a file
    conflicted outside scope-in or inside scope-out, an Edit keeping one side, the other or ours
    then theirs passes; one adding a line of its own, reordering or repeating the sides, leaving
    a marker, emptying a block without its final newline, touching no marker or written as a
    Write is refused, as is the same Edit once the file is staged or during a merge of a commit
    other than the tip. An Edit spanning two blocks and the code between them is refused, while
    the first block alone passes. In a CRLF file, a separator typed with a CR is read as a
    marker. A MERGE_HEAD ref planted in the shared refs, as a branch and as a tag, makes no
    worktree look mid-merge. An Edit over marker lines whose conflict was staged by hand, all three
    stages at one blob, is refused. A write of an out-of-scope file is reported though a
    planted replace ref makes the tip hold the same content.
