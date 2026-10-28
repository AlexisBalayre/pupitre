# 0115. `pup plan edit --rescope` lets the operator widen a claimed task's scope-in, appending only, once no session is at work on it (2026-10-28)

- Status: accepted
- Amends: [0040](0040-a-task-can-exist-before-a-session-the.md)

115. **`pup plan edit --rescope` lets the operator widen a claimed task's scope-in,
    appending only, once no session is at work on it (2026-10-28).** Decision 40 froze a
    spec once a session claims its task, so the store never disagrees with what the agent
    was told. A CI review round (decision 90) can still ask for an edit outside scope-in,
    and the re-gate then fails scope-audit with no way out: on #161 the operator edited
    `tasks.spec` in `state.db` by hand.
    *The command.* `pup plan edit <task> --rescope --scope <glob...>` appends the globs not
    already there to the task's scope-in. It never removes one and takes no other field, so
    it can only let a session commit more, never less, and the goal and acceptance the
    session was told stay as they were. The widened spec passes `assertPlannableSpec`, as
    every stored spec does.
    *Who.* The operator only. A session is refused by `pup plan`'s existing rule (decision
    40), and the conductor here too: the conductor runs the fix rounds that hit the scope
    failure, and a scope the gate-failing side widens for itself is no scope at all.
    *When.* Allowed only while every session on the task is in a state listed as
    rescopable, `awaiting-review`, `blocked` or `merged`, or `killed`, which claims nothing,
    and no session on it has a window open. The list names the states that allow a rescope,
    and the refused ones are every other claimed state, derived from the state table as
    `claimedStates()` is, so a state added later is refused until someone names it. Today
    that refuses `queued`, `running` and `rejected`, whose hooks hold the old scope. A
    window is open when the default tmux server lists the session's recorded pane or a
    tmux session named `pup-<id>`. The probe is one `tmux -S /tmp/tmux-<uid>/default
    list-panes -a`, with tmux looked up on a fixed PATH (`/opt/homebrew/bin`,
    `/usr/local/bin`, `/usr/bin`, `/bin`) and none of the caller's environment, so a worker
    cannot hand it a fake tmux or point it at an empty server. Any failure, no server
    running or no tmux found included, counts as every window open and refuses. That covers
    a worker that ran its own `pup session done` and so sits `awaiting-review` with its pane
    alive: without the probe it could rescope its own task and keep editing, and the
    re-gate would pass. The gate kills a merged session's window, so a merged session
    passes. The cost of failing closed: an operator whose tmux runs under a custom
    `TMUX_TMPDIR`, or who has no tmux server running at all, is refused until the default
    server answers. A task no session claims is refused too: plain `pup plan edit --scope`
    edits it.
    *The globs.* Stricter than a plan's: a rescope widens a scope the gate already
    audited, so it names paths. Each glob is checked in the form the matcher reads it,
    trimmed and with one leading `./` dropped, so `./**` or ` **` cannot slip past a check
    on the raw string. Refused are an empty glob, an absolute one, one with a wildcard
    (`*` or `?`) anywhere in its first segment, which could match every top-level directory,
    one with a `..` segment, one under `.github` (in any case), whose workflows a same-repo
    PR runs with the repo's secrets, and any with a C0 control, DEL or C1 control.
    *Atomicity.* The read of the spec, the write, the window check, the tier raise and both
    records run in one `immediate` transaction, so no writer lands between the read and the
    write. The state rule is the `UPDATE`'s own guard, the one check of it, so no caller
    can write past it; an open window found after the write throws, which rolls it back.
    *What reads it.* The gate's scope-audit, `pup review` and `pup fix`'s recompiled
    profile all read `tasks.spec` through `readTaskSpec`, so the next re-gate and the next
    round's hooks see the widened scope with nothing else changed. Scope-out still wins
    over scope-in at the gate, so a glob added under a scope-out one opens nothing.
    *The tier.* A fix round's or a respawn's window routes from the session's own stored
    tier (decision 92), fixed at launch, so a standard task widened onto a critical area
    would climb the standard ladder while `pup plan` already shows it critical. When the
    widened scope-in implies critical, the same transaction raises each of the task's row
    and the claiming session's row that is stored as standard to critical, each settled
    from its own stored tier, since a relaunch routes from the task's and a fix round from
    the session's, and never the other way. A null tier is left alone: it is derived from
    the scope-in, which now implies critical. The session's rung and its
    reason are cleared, so its next window starts the critical ladder from the bottom, as
    a re-tiered task's does, rather than clamping a standard rung onto it. The tier the
    session now runs on, and whether the rescope raised it, are in the `rescope` event and
    the CLI's line; it counts as raised when either row was.
    *The record.* In the same transaction as the write, a `rescope` event on the claiming
    session names the task, the added globs and `by: 'operator'`, and a decision record on
    that session lists the added globs as its files, so `pup log` (and `pup log <module>`)
    shows the rescope beside the merges it changes.
    *Tests.* In `task-rescope.test.ts`, a rescope on a merged, awaiting-review or blocked
    session's task with its window closed appends and writes the event and the record. A
    queued, running or rejected one writes nothing, nor does an awaiting-review or blocked
    one whose pane is listed, whose name is listed, or whose probe fails (no server, no
    tmux), and the probe runs on the pinned socket and PATH whatever the caller's
    `TMUX_TMPDIR` and PATH. Each refused glob is refused, each matcher-form bypass with it,
    and globs the matcher reads as plain paths (`./docs/**`, `src/cli/`) pass. A re-gate's scope-audit then passes the added path and still fails a
    scope-out one. A standard task and session widened onto `src/core/merge-gate*` are
    raised to critical from the bottom rung; a standard glob leaves them standard, a task
    stored standard under a session already critical is raised on its own, and a critical
    tier is never lowered. `session-repository.test.ts` holds the statement's
    guard to each state, and `index.test.ts` refuses a session, the conductor and an open
    window.
