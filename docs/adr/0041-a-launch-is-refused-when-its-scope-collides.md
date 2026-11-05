# 0041. A launch is refused when its scope collides with a live session; the backlog is visible where work is chosen (2026-09-04; the refusal is superseded by decision 99)

- Status: accepted
- Amended by: [0099](0099-workers-share-files-and-collaborate-a-launch-overlapping.md)

41. **A launch is refused when its scope collides with a live session; the backlog is
    visible where work is chosen (2026-09-04; the refusal is superseded by decision 99).**
    Decision 40 left three ceilings and this closes them: no admission control, `pup status`
    showing the backlog nowhere, and the report's live/queued section having nothing to hold.
    All three are the same gap — intent existed in the store and nothing consulted it.
    *The radar was the wrong instrument for the question.* `scanOverlaps` diffs live branches
    every 15 seconds and reports two sessions in one file, which is a fact about work already
    done: by the time it fires both agents have edited the file and one of them is going to
    lose. `pup launch` now asks the same question of two *scopes* before either has written
    anything, and refuses. `--allow-overlap` overrides, the considered-override shape
    `--accept-debt` established. The refusal names the session and the shared files, because
    "narrow the scope" is only actionable if the operator knows which files to drop.
    *A scope resolves to files through the gate's own precedence.* `scopedPaths`
    (`scope-audit.utils.ts`) is the complement of `auditScope`: the paths a task is allowed to
    edit are the ones the gate would not flag. So scope-out subtracts, protected paths never
    collide, and the check cannot drift into a second, laxer reading of what a scope means —
    a file a session could never commit is not a file it can conflict over. Both sides go
    through it against one `git ls-files -z` listing, then into `intersectSessionFiles`, which
    already computed pairwise same-file overlap for the radar and had only ever seen diff
    lists. Second use of that function, not a new abstraction.
    *`holdingStates` is `claimedStates` minus the terminal pair.* Derived the same way and for
    the same reason: a state added later holds its scope by default. `merged` and `killed`
    release it — a merged session's work is in the target and a killed one's is abandoned, so
    holding on would refuse every later launch over files the repo has ever touched. `queued`,
    `rejected` and `blocked` all still hold, because each transitions back to `running`.
    *The measurement reads the trusted checkout.* `repoRoot()` resolves `--git-common-dir`, so
    `git ls-files` lists the main checkout's index even when `pup launch` is run from inside a
    session's worktree — a session cannot aim the check at its own index to make it report
    nothing. Decision 30's rule, and the property the whole check rests on.
    *`--allow-overlap` is operator-only, and that is a record, not a control.* A considered
    override that waves off a collision with *another* session belongs to whoever answers for
    the collision, by decision 26's rule and detection, so the flag refuses a calling session.
    But the security review is blunt about what that buys: `pup launch` is not operator-only,
    and neither is `pup kill` — a session that wants a conflicting task launched does not need
    the flag, it kills the holder (`killed` releases the scope and returns the task to the
    backlog, decision 40) and launches plainly. The guard keeps the audit trail honest, the way
    decision 26's `--pr` guard does; it stops nothing. Extending operator-only to `launch` and
    `kill` is the natural close and is its own change (decision 42).
    *An override that leaves no record is not an override.* `--accept-debt` writes a ledger
    entry; this writes a `scope_overlap` event naming the sessions and files waved through.
    The conflicts are therefore computed on every launch, not only when the flag is absent:
    skipping the question when the answer would be ignored is how a defence ends up documented
    and inert.
    *`pup new` asks before it writes.* `createSession` is `planTask` then `launchTask`, and a
    refusal inside the second would have left the spec the operator just abandoned in the
    backlog — unclaimed, attributed to them as `origin='human'`, and launchable by any session
    through the open `pup launch`. Exactly the operator-attributed spec decision 40 stopped a
    session from authoring, handed over by accident; each retry with a narrower scope would
    have added another. The check now runs before the row exists, and the decision is made
    once: `createSession` hands `launchTask` an allowed overlap, so `launchTask` still
    measures — for its own `pup launch` path and for the `scope_overlap` record — but cannot
    refuse after the row is written. The second review found the version that re-decided: a
    holder appearing in the window between the two reads refused after `planTask`, recreating
    exactly the orphan the reordering was for. A holder that appears in that window is now
    recorded instead, the trade `--allow-overlap` already makes — and recorded as
    `via: 'raced'`, not as something the operator accepted, because they accepted nothing;
    the ledger's `acceptedBy` rule, applied to this record.
    *The audit sweep always overlaps, and says so.* `buildSweepTask` is scoped to `**/*`, so
    it collides with every live session there is; refusing it would have made
    `pup audit --sweep` unrunnable whenever anything else runs, with no flag on `pup audit` to
    say otherwise, and the refusal would have surfaced as a stack trace. It launches with the
    overlap allowed and the `scope_overlap` event naming every session it stepped on — the
    record was the point of the refusal, and a sweep keeps it.
    *A stored spec is validated before its globs are read.* The check is now the first thing
    to consume a spec read back from the store, ahead of `compileProfile`. A row written
    before decision 40's validation could be missing `scopeIn` altogether and would have died
    in `scopedPaths` with a bare TypeError; `launchTask` runs `assertPlannableSpec` first, and
    that predicate now treats a missing `scopeIn` as the empty scope it already refused.
    *Decision 28 closed hooks; the config keys git consults on pup's own commands were a
    class, and most of it is closed now.* `git ls-files` is a new call site, and looking at
    it showed that a session can write the shared, untracked `$GIT_COMMON_DIR/config` from
    its worktree with a plain `git config` — `.git/**` is seen by neither the scope hooks nor
    the gate — and name a command git then runs with the operator's environment. Each of
    these was verified against Apple Git 2.39.5, and each of the first attempts at the fix
    was reviewed again, which is how the second and third were found. **`core.fsmonitor`**
    runs on any index read (`ls-files`, `status`); `-c core.hooksPath=/dev/null` does not
    stop it, only `-c core.fsmonitor=` does, and the `=` is load-bearing since the bare key
    means `true`. **`gpg.program`** runs once per commit the gate's `git rebase` recreates
    whenever `commit.gpgsign` is set; clearing the sign flags is the lever, because
    `gpg.program` has no safe empty value. **`diff.external` and `diff.<driver>.textconv`**
    are the worst of the three, because they do not merely run: an armed external diff emits
    no hunks, `gitDiffAddedLines` returns nothing, and the coverage stage reads "no
    instrumentable changed lines" as a **pass** — decision 29's invariant inverted from a
    file the session writes. They are disarmed per call with `--no-ext-diff --no-textconv`
    (diff-subcommand flags, not top-level ones), not through `GIT_SAFE_CONFIG`, because an
    empty `diff.external` makes every diff die. The third pass showed those two flags were
    not the class either: **`color.ui=always`** forces ANSI through the pipe so no line
    starts with `@@`, and a **`* -diff` attribute** or `diff.<driver>.binary` turns every
    file into "Binary files differ" — both blank the patch the same way, both reproduced
    against the shipped function, both now covered by `--no-color --text` with a
    discriminating test each. `--text` is safe on a real binary because `patchCoverage`
    only counts files the coverage report instruments. Clearing the sign flag has a
    functional cost worth saying: an operator who signs every commit gets the gate's rebase
    rewriting theirs unsigned, and a branch rule requiring signatures then rejects the push
    — loud, and the right trade. `GIT_SAFE_CONFIG` (`git-diff.client.ts`)
    carries `hooksPath`, `fsmonitor` and both `gpgsign` keys (decision 79 adds
    `log.showSignature=false` and `merge.verifySignatures=false`), and every pup git call now
    spreads it — including `pushBranch`'s two, which the first version of this text claimed
    were converted and were not, and the three read-only calls (`log`, two `rev-parse`)
    that consult none of these keys today but cost nothing to cover. This was a
    pre-existing class; the change that happened to add a sixth instance is where it got
    closed. **What is not closed:** a smudge filter armed through the untracked
    `info/attributes` runs on `git worktree add` and on the gate's rebase, and has no `-c`
    disarm because its driver name is chosen by whoever wrote it. The honest fix is a loud
    refusal when that surface is armed, decision 6's shape, and it is its own change; until
    then it is a stated ceiling, verified reachable, not an accepted one (closed by
    decision 50). Two more, same status. **`gitDiffNumstat` is forgeable by the same `* -diff` line**, and `--text` does
    not restore `--numstat` the way it restores `-U0`: git emits `-\t-`, `countChangedLines`
    treats a null count as a real binary and skips it, so a 5 000-line diff reports zero
    changed lines, the `diff-size` stage passes and the review-queue risk score floors. The
    null skip is correct for a real binary; nothing anticipated the session choosing which
    files count as one. The fix is a measurement, not a flag — cross-check a null numstat
    against `gitDiffAddedLines`, which `--text` does restore, and flag the disagreement
    (closed by decision 53, which found the patch cannot be the discriminator).
    **The push target is session-controlled:** `url.<base>.insteadOf` or a rewritten
    `remote.origin.url` in the shared config sends `pushBranch` and `gh pr create` wherever
    the session says, verified under the full `GIT_SAFE_CONFIG`; the fix is to resolve
    `origin` once from the trusted checkout and push to the literal URL (the rewrite half
    closed by decision 54, the rewritten `remote.origin.url` by decision 56). A merge driver
    named through the same `info/attributes` runs on a conflicting rebase and is unlisted
    for the same reason as the smudge filter (closed by decision 50).
    *Unreachable is loud.* Two branches in `scopeConflicts` cannot fire while the store is
    pup's own — a session id containing `:`, and a session whose task row is missing under a
    NOT NULL foreign key. Both throw rather than skip: a scope the check cannot read is a scope
    it cannot clear, and comparing against nothing is the fail-open direction (decision 29).
    The candidate is also matched on either side of a pair rather than by insertion order, so
    a refactor that files it first cannot leave the check silently reporting no conflict.
    *The backlog renders where work is chosen.* `pup status` lists planned tasks under
    `planned` — the state `docs/01` has always given a task with no session row — in the
    session table's own columns, so what will be built sits beside what is being built rather
    than behind a second command. Its empty copy changed from "No sessions." to "Nothing
    running and nothing planned.", and the early return that produced it had to go: a project
    whose only content is a plan was reporting itself empty. `pup report` gains a Backlog
    section above Sessions, on the reasoning that a report opened to decide what to do next is
    answered there; the scope chips both sections draw are now one function.
    Ceilings, stated plainly. **Only the main checkout's tracked files can collide:** scopes
    resolve through `git ls-files`, so two tasks scoped to the same not-yet-created file both
    launch, and a holder whose real activity is in files it added on its own branch is
    invisible the same way; the radar catches both 15 seconds later like before. Widening this
    means comparing glob strings themselves, where `src/**` and `src/core/**` overlap without
    being equal — a real design question, deliberately not answered here. **A holder with an
    empty scope claims nothing:** a row written before decision 40's validation and never
    launched since is invisible to the check. **`merged` releases the scope** even for a
    `--pr` session whose pull request is still open (decision 26) — its worktree is gone and
    no agent is writing, so defensible, but unstated until now. **So does `killed`,** whose
    worktree, branch and commits survive by decision 40's ceiling, so a second task can be
    launched over files a killed session still holds commits for. **Protected paths never
    collide,** on either side, by construction. **A live session's own scope is trusted as
    stored:** a corrupt `tasks.spec` row throws on every launch rather than degrading, which is
    loud on purpose — and, because every `JSON.parse(row.spec)` in the CLI is raw, it surfaces
    as a stack trace rather than a named refusal. **A session-armed smudge filter still runs
    with the operator's environment** on `worktree add` and the gate's rebase, per the
    paragraph above (closed by decision 50). **Nothing re-checks after launch:** editing is
    refused at admission only, so the radar remains the only after-the-fact check (closed for a
    session's own writes by decision 63: every Bash call is now re-checked against the
    worktree after it runs; overlap between two live sessions is still the radar's). **A session
    can still deny launches:** `pup launch` is open, so a session can launch the broadest
    backlog task and every later operator launch overlapping it refuses; it is loud (a tmux
    window, a `pup status` row) and `--allow-overlap` is the operator's answer, so friction
    rather than denial (closed by decision 42). **The backlog is still flat** — ordering,
    dependencies and decomposition are untouched, and each still needs its own design
    conversation.
