# 0040. A task can exist before a session; the backlog is derived, not stored (2026-09-04)

- Status: accepted
- Amended by: [0090](0090-pup-fix-session-hands-the-ci-review-s.md)

40. **A task can exist before a session; the backlog is derived, not stored (2026-09-04).**
    `insertTask` had exactly one caller — `createSession` — which had already created a git
    worktree two lines earlier and launched tmux four lines later, so planned work could not
    exist. `docs/01` has documented `queued -> running` as the first transition since the
    beginning and it was unreachable: `createSession` transitions straight to `running`, which
    is why `pup report`'s live/queued section is permanently blank. This is the "what will be
    built" artefact the vision asks for, at its smallest honest size: intent you can write,
    read and revise before anything runs.
    `planTask` (`pup plan add`) writes a row and does no git or filesystem work. `launchTask`
    (`pup launch`) does everything else. `createSession`
    (`pup new`) is now their composition, unchanged from the operator's side — the one-liner
    that launches a session in a single keystroke is the daily path and stays.
    Three sub-decisions:
    *Membership is derived* — the backlog is tasks no session in `queued`, `running`,
    `awaiting-review`, `rejected`, `blocked` or `merged` has claimed. `tasks.status` used to
    hold this and is **dropped**: it was written on every insert and on merge, read by nothing,
    and a second copy of session state can only drift from the sessions table that owns it. The
    drop needed a new migration kind — `MIGRATIONS` entries were add-if-absent, now they carry
    `kind: 'add' | 'drop'` and the guard reads `present === (kind === 'drop')`.
    *`killed` is deliberately absent from that list* — abandoned work returns to the backlog and
    `pup launch` can retry it. Today a killed session leaves its task `status='open'` with
    nothing able to relaunch it, so the intent silently evaporates. `sessionSlug` already counts
    a task's sessions, so the second one gets its own slug without change.
    *A claimed task's spec is frozen* — `deleteTask` and `updateTaskSpec` both refuse once a
    session exists, because the spec is compiled into that session's `context.md` at launch and
    editing it afterwards would leave the store disagreeing with what the agent was told. This
    is also the first `UPDATE tasks SET spec` in the codebase; the spec was previously
    write-once.
    Two things moved while the seam was open. The **knowledge slice is now built at launch, not
    at plan time** — the code map moves on between planning a task and launching it, so a slice
    captured with the intent would describe a repo that no longer exists; it also moves that
    logic out of the CLI, where `pup new` had been assembling it. And **`pup new --role` is
    removed**: it was declared "informational for now", `opts.role` was read nowhere, and
    `tasks.role` is written from it but never read. Deleting the flag is honest about that
    rather than leaving an option that does nothing.
    Five guards the security review put on this, four of them closing holes the split itself
    opened. They are the useful part of the record, because each one is a consequence of intent
    outliving the command that wrote it.
    *A spec is validated where it is written* — the split had left all validation in
    `compileProfile`, which runs after `git worktree add`. A backlog row with an empty or
    malformed scope therefore compiled fine at plan time and threw at launch, after the worktree
    and branch existed, leaving orphans and a task that could never be launched again because
    the branch name was taken. `planTask` now runs the launchable subset of that validation, and
    `startSession` compiles *before* it touches the filesystem. `pup new` had the same ordering
    and it did not matter, because the operator had typed the failing input a second earlier.
    *A scope glob may not carry a control character* — `scope-in.pat` is line-oriented and read
    by `grep -qE -f`, where a blank line is a pattern that matches everything, so a single
    newline inside a glob silently turned the Edit/Write hook into allow-all. Verified against
    the system grep the hook actually runs. Rejected in `assertPlannableSpec`
    (`task-spec.utils.ts`, run by `pup plan add` and `pup plan edit`) and again in
    `validateInput`, so every compile path is covered. `globsToGrepFile` drops a glob carrying
    one outright rather than splitting it: the first attempt filtered blank *elements*, which is
    inert because a converted glob is always `^…$` and never blank, and splitting on the newline
    instead would emit the tail as an **unanchored** fragment matching more than the glob ever
    named. Dropping the whole malformed glob is the only fail-closed option.
    *`pup launch` refuses a claimed task* — without it, a session parked `blocked` by decision
    7's reject cap could relaunch its own task and get a fresh session with `reject_count = 0`,
    stepping over the parking that needs a human. Decision 40's stated "no admission control"
    ceiling was about scope overlap between *different* tasks and never covered this.
    *Writing a spec is operator-only* — `pup plan add|drop|edit` **and `pup new`** refuse when a
    session is calling, by decision 26's rule and detection. Guarding only the new commands was
    the first attempt and was worthless: `pup new` is `plan add` plus a launch, so it is the same
    capability under an older name, and it additionally hands a session parked `blocked` a fresh
    session past decision 7's reject cap. The lookup itself moved into one `callingSession`
    helper, because `merge --pr` had been carrying its own copy of the same trust-boundary check
    and two copies of it would drift. A session could otherwise author a task whose
    `goal` becomes a later session's kickoff prompt verbatim and whose `scopeIn` becomes the hook
    allowlist the gate audits against, recorded as `origin='human'`: prompt injection carrying
    the operator's attribution. `pup plan` (list) stays open, since reading is not authoring.
    Listed goals and globs go through decision 29's sanitizer, and `pup launch` prints the goal
    and scope it is about to compile, so the operator's review is bound to the spec that actually
    runs.
    *The row key owns identity* — `launchTask` takes the task id from the trusted primary key and
    the spec blob only for intent. A spec whose `id` had drifted would compile one task's hooks
    under another task's session row, so the hooks would enforce one scope while the gate audited
    another.
    Two smaller corrections. `deleteTask` refuses **any** task a session ever ran for, not merely
    a claimed one: `sessions.task_id` is a NOT NULL foreign key, so deleting a task whose killed
    session returned it to the backlog aborted on the constraint and surfaced a raw SQLite error
    instead of refusing. And the `drop` migration is *tolerated* rather than fatal — a table
    rewrite can fail on a concurrent lock or a user-added index over the column, and nothing
    reads a dropped column, so leaving it costs nothing where a throwing `openStore` would take
    every `pup` command with it.
    Ceilings, stated plainly. **No ordering, dependencies or decomposition:** the backlog is a
    flat list ordered by creation. Those were the other readings of "what will be built" and
    each needs this primitive first. **No admission control yet:** `pup launch` does not check
    the task's scope against live sessions, so two sessions can still hold identical scope and
    only the post-hoc 15s diff sweep notices — the next change closes that. **`pup status` and
    the report still show the backlog nowhere**, so a planned task is only visible to
    `pup plan`; same next change. **Claude still never authors a spec** — every task is
    operator argv or `buildSweepTask`'s hardcoded template, so `docs/07`'s promise that each
    audit finding becomes a pre-scoped task remains unkept, though it is now buildable for the
    first time. **A task with history can never be dropped**, per the foreign key above, so a
    killed session's task returns to the backlog and stays there until it is launched again.
    **`pup kill` leaves the worktree, branch and commits behind** while returning the task; a
    relaunch is safe because `sessionSlug` mints a new slug, but each cycle accumulates an orphan
    branch holding commits no `pup merge` will take (the gate refuses a non-`awaiting-review`
    session). **A `--pr` session whose pull request is closed unmerged stays `merged`**, so its
    task is claimed forever and can no longer be launched, dropped or edited — decisions 26 and
    27 accepted the stranded session; the stranded task is new, and is the price of deriving
    backlog membership from session state.
