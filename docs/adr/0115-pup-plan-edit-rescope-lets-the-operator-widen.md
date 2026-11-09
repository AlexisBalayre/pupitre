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
    every stored spec does; no glob the refusals below take can fail it today, so the call
    guards against the two drifting apart, and its test stubs the check to prove a refusal
    there writes nothing.
    *Who.* Meant for the operator only. A session is refused by `pup plan`'s existing rule
    (decision 40), and the conductor here too: the conductor runs the fix rounds that hit
    the scope failure, and a scope the gate-failing side widens for itself is no scope at
    all. This is not enforced, only inferred. The refusals read what a worker controls:
    its cwd, which it can leave, and `PUP_SESSION_ID` and `PUP_CONDUCTOR`, which it can
    unset (decisions 27, 44). The window probe below is the one check a worker does not
    pass by shedding its environment, and it stops only a worker whose window is still
    up. A process a worker detached before its window closed (`nohup`, `setsid`, a
    double fork) outlives the window, carries no marker, and can rescope its own task.
    Like the socket ceiling below, this is a limit of the design, not a bug to close
    here. What the rescope records says the same thing (see *The record*).
    *When.* Allowed only while every session on the task is in a state listed as
    rescopable, `awaiting-review`, `blocked` or `merged`, or `killed`, which claims nothing,
    and no session on it has a window open. The list names the states that allow a rescope,
    and the refused ones are every other claimed state, derived from the state table as
    `claimedStates()` is, so a state added later is refused until someone names it. Today
    that refuses `queued`, `running` and `rejected`, whose hooks hold the old scope. A
    window is open when a default tmux server lists a pane in a tmux session named
    `pup-<id>` (the launch's own name), or a pane whose start command carries the launch's
    `--name pup-<id>` pair. tmux fixes a pane's start command when it starts the pane, so a
    worker that renames its tmux session or moves its pane to another still matches, and
    only respawning the pane, which ends the worker in it, changes it. A recorded pane id
    is never matched: a `%N` names a pane only on the server that minted it, a restarted
    server numbers its panes from `%0` again, and another server numbers its own, so a
    recorded id can be one of the operator's panes. Each pane is listed as its id, its
    start command, then its session name, the one field a worker sets: a tab or a newline
    in a name, which tmux before 3.3 prints raw, can add lines but cannot move the start
    command out of its own. A launch hands
    tmux the launching shell's `TMUX_TMPDIR` (decision 47), so its window may be on the
    server at `$TMUX_TMPDIR/tmux-<uid>/default` or, unset, at `/tmp/tmux-<uid>/default`.
    The caller's own `TMUX_TMPDIR` cannot say which: a caller that unset it would probe
    only `/tmp`'s and miss a live window on the operator's socket. So `launchSession`
    records the socket before the window opens, in `tmux-socket` beside the session's
    compiled profile, written by the operator's or the conductor's `pup`, never by the
    session. The probe asks `/tmp`'s server always, the one under the caller's
    `TMUX_TMPDIR` when set, and each socket a session on the task recorded, each with one
    `tmux -S <socket> list-panes -a`. A session can write that file, so it is read as one
    it wrote: no symlink followed, no fifo opened, a bounded regular file, and only an
    absolute path ending `tmux-<uid>/default` with no control character counts. A missing
    or malformed record (a launch from before it, a removed session dir) records nothing,
    and the default sockets are probed, failing closed as before. tmux is
    looked up on a fixed PATH with none of the caller's environment: `/opt/homebrew/bin`,
    `/usr/local/bin`, `/usr/bin` and `/bin`, then the fixed prefixes of MacPorts
    (`/opt/local/bin`), NixOS (`/run/current-system/sw/bin`), multi-user Nix
    (`/nix/var/nix/profiles/default/bin`) and Linuxbrew (`/home/linuxbrew/.linuxbrew/bin`),
    each reached only when none before it holds a tmux. So a worker cannot name a fake tmux
    through its environment. One that can write one of those directories can still replace
    the tmux there, as an operator-owned Homebrew or Linuxbrew prefix or a single-user Nix
    store lets it; that is a ceiling like the socket one. No directory under a home is on
    the PATH, since a worker writes there, so a tmux only in `~/.nix-profile/bin`,
    `/etc/profiles/per-user/<user>/bin` or another per-user prefix is not found, and the
    operator links it into one of the directories above. Each probe gets two seconds: it
    runs inside the store's write lock, and a listener at the socket that never replies
    must not hold every writer out. Either server listing the window refuses, and so does
    any probe failure, no server running, no tmux found and a timeout included. The
    refusal names what the probe saw, since each has its own way out: the server and pane
    that list a window, which the operator closes; a server that did not answer, with the
    first line tmux printed or the timeout, where the operator starts one (a version
    mismatch between the probe's tmux and the server's shows here too); or no tmux on the
    fixed PATH, which it names. The probe is the runtime's `mayHaveOpenWindow` in
    `src/claude/session-runtime.service.ts`, the one module that touches tmux, so it reads
    the launch's name from `tmuxName` rather than spelling it again; the rescope hands it
    each session's id, a merged or killed one's included. Its PATH and its
    environment differ from a launch's on purpose: the launch trusts the operator's shell,
    the probe must not trust a worker's. That covers
    a worker that ran its own `pup session done` and so sits `awaiting-review` with its pane
    alive: without the probe it could rescope its own task and keep editing, and the
    re-gate would pass. The gate kills a merged session's window, so a merged session
    passes. The cost of failing closed: the operator is refused until every server asked
    answers, so one with no tmux server running at `/tmp`, or none at `TMUX_TMPDIR` when it
    is set, starts one first, and one whose tmux is only on a per-user prefix links it onto
    the fixed PATH. The ceiling: the probe trusts whatever server answers at
    those sockets, so a worker that removes a socket and starts a fresh, empty server at
    its path hides the windows of the old one, which keeps running unlisted. A worker that
    rewrites its own `tmux-socket` record does the same for a window on the operator's
    socket, when the caller's environment does not name that socket too. A task no
    session claims is refused too: plain `pup plan edit --scope` edits it.
    *The globs.* Stricter than a plan's: a rescope widens a scope the gate already
    audited, so it names paths. Each glob is checked in the form the matcher reads it,
    trimmed and with one leading `./` dropped, so `./**` or ` **` cannot slip past a check
    on the raw string. Refused are an empty glob, an absolute one, one with a wildcard
    (`*` or `?`) anywhere in its first segment, which could match every top-level directory,
    one with a `..` segment, one under `.github` (in any case), whose workflows a same-repo
    PR runs with the repo's secrets, and any with a C0 control, DEL or C1 control. `[`,
    `]`, `{`, `}` and `\` are no bypass: the matcher escapes them, so `[.]github/**`,
    `{docs,.github}/**` and `\.github/**` are literal paths that match nothing under
    `.github`, and the rescope takes them as such.
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
    added globs imply critical, the same transaction raises each of the task's row
    and the claiming session's row that is stored as standard to critical, each settled
    from its own stored tier, since a relaunch routes from the task's and a fix round from
    the session's, and never the other way. Only the added globs count, not the old ones:
    a task the operator pinned standard over a critical scope (`pup plan edit --tier`,
    decision 92) keeps its pin, its rung and its reason, since the spec freeze leaves no
    way to put the pin back once the rescope took it. A null tier is left alone: it is derived from
    the widened scope-in, which now implies critical. The session's rung and its
    reason are cleared, so its next window starts the critical ladder from the bottom, as
    a re-tiered task's does, rather than clamping a standard rung onto it. The tier the
    session now runs on, and whether the rescope raised it, are in the `rescope` event and
    the CLI's line; it counts as raised when either row was. The tier reported is the one
    the session's next window routes on, read after the raise as the window's route reads
    it, so with both rows null it is the widened scope-in's, not the old one's.
    *The record.* In the same transaction as the write, a `rescope` event on the claiming
    session names the task and the added globs, and records what was seen of the caller,
    not who it was. `by: 'inferred-operator'` says the operator was inferred from absent
    markers. `tty` is the terminal on the caller's stdin, as the system's `tty` names it,
    or null. `tmuxPane` is the pane `TMUX_PANE` names, or null when unset or not a pane id.
    The caller can set all of these, so they are evidence an audit weighs, not proof: an
    inferred operator on no terminal and no pane is the case to look at. A decision record
    on that session lists the added globs as its files and says the caller was taken for
    the operator, so `pup log` (and `pup log <module>`) shows the rescope beside the merges
    it changes.
    *Tests.* In `task-rescope.test.ts`, with the probe mocked, a rescope on a merged,
    awaiting-review or blocked session's task with its window closed appends and writes the
    event and the record. A queued, running or rejected one writes nothing, nor does one
    whose window the probe reports open, nor one where a server did not answer or no tmux
    was found, each refused with its own message, and the probe is handed every session on
    the task, merged and killed ones included. In `session-runtime.test.ts`,
    `mayHaveOpenWindow` reports a window a server lists by its launch name or, renamed, by
    its start command, naming the server and the pane, and a tab or a newline in a session
    name does not hide it. It passes one listed nowhere, whatever pane ids and prefix-pair
    names the server lists. It reports a server that did not answer with what tmux said or
    the timeout, and no tmux on the pinned PATH as such. It runs on the pinned PATH with a
    timeout whatever the caller's PATH, asks only
    `/tmp`'s server when `TMUX_TMPDIR` is unset and both when it is set, and reports the
    window when only `TMUX_TMPDIR`'s lists it or does not answer. A launch records the
    socket under the launching shell's `TMUX_TMPDIR`. A window on that socket is reported
    even when the caller's environment lacks `TMUX_TMPDIR`. A record that is relative,
    names another socket or holds a control character reads as none. Each refused glob is
    refused, each matcher-form bypass with it, and globs the matcher reads as plain paths
    (`./docs/**`, `src/cli/`) pass, as do `[.]github/**`, `{docs,.github}/**` and
    `\.github/**`, none of which matches `.github/x`. A stub of `assertPlannableSpec`
    shows the widened spec goes through it, and a refusal there writes nothing. The event
    records the caller as an inferred operator, with its tty and tmux pane. A re-gate's scope-audit then passes the added path and still fails a
    scope-out one. A standard task and session widened onto `src/core/merge-gate*` are
    raised to critical from the bottom rung; a standard glob leaves them standard, a task
    pinned standard over a critical scope and widened with `docs/**` stays standard, a task
    stored standard under a session already critical is raised on its own, a pair of null
    rows reports the widened scope-in's critical, and a critical tier is never lowered. `session-repository.test.ts` holds the statement's
    guard to each state, and `index.test.ts` refuses a session, the conductor and an open
    window, and records the tty and `TMUX_PANE` it saw, dropping a pane that is not one.
