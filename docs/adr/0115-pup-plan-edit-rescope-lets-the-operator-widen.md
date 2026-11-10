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
    session was told at launch stay as they were. Nothing messages the session when a
    rescope lands, since none of its windows is open then (see *When*): the next `pup fix`
    round recompiles its profile, the context it reads and the hooks it runs under, from
    the widened spec, and that round's brief carries only the review threads, so the
    session learns of the wider scope from its profile, not from a message. The widened spec passes `assertPlannableSpec`, as
    every stored spec does; no glob the refusals below take can fail it today, so the call
    guards against the two drifting apart, and its test stubs the check to prove a refusal
    there writes nothing.
    *Who.* Meant for the operator only. A session is refused by `pup plan`'s existing rule
    (decision 40), and the conductor here too: the conductor runs the fix rounds that hit
    the scope failure, and a scope the gate-failing side widens for itself is no scope at
    all. This is not enforced, only inferred. The first refusals read what a worker
    controls: its cwd, which it can leave, and `PUP_SESSION_ID` and `PUP_CONDUCTOR`, which
    it can unset (decisions 27, 44). Two checks do not rest on either. The first is the
    process tree: the CLI walks from its parent up, with one `ps -ww -A -o pid= -o ppid=
    -o args=` on the probe's pinned PATH (see *When*), and refuses when a process there
    carries the `--name pup-<...>` pair a launch passed Claude Code (`launchArgs`), a
    session's window or a conductor's, of any project. So `env -u PUP_CONDUCTOR pup plan
    edit ... --rescope` from the conductor's own Bash is refused, as is a worker that
    shed its markers and left its worktree, whatever its tmux socket record says. A tmux
    process on the way up is passed over: a server lists the command that started it,
    which is a launch's when a launch started the server, and the operator's own panes
    run under it. A `ps` that fails refuses too, as unreadable. The check reads the
    arguments as `ps` shows them, which a process can overwrite (as `setproctitle` does on
    Linux), so it was checked against what `ps` really prints. On macOS (Darwin 27, Claude
    Code 2.1.322's native build, 2026-11-10), `ps -ww -o args=` up a session's own Bash and
    the conductor's showed each Claude Code with its whole launch argv, `--name pup-t-<id>`
    and `--name pup-conductor-<project>` included, under the tmux server its launch started,
    which shows the creating command (`new-session ... -s pup-watch-<project>` for a
    session's, `-L pup-conductor-<project> new-session ... --name pup-conductor-<project>`
    for the conductor's). The tests replay those lines. Linux was not checked: a Claude Code
    build that rewrote its title there would show no `--name`, and this check would pass it.
    Matching each ancestor's pid to a tmux `pane_pid` whose `pane_start_command` is a
    launch's would not depend on that, but needs every server's socket, the conductor's own
    and other projects' included, so it is the fallback for such a build, not built now.
    The suggested check on the
    caller's tmux pane or terminal would not hold: `TMUX_PANE` is a variable the caller
    unsets, and Claude Code's Bash runs a command with no terminal at all. The second
    check is the window probe below, which stops a worker whose window is still up.
    Neither reaches a process that left the tree: one a worker or the conductor detached
    (`nohup` with `&`, `setsid`, a double fork) or had something outside the tree start
    (`tmux new-session` on any server, launchd, cron, `at`). Such a process carries no
    marker and no launch ancestor, and once the task's windows are closed it can rescope.
    So can a process the conductor starts that way while its own window is up, since the
    probe looks only for the task's sessions. Refusing a caller with no terminal would
    stop the plainest of these, but `script` hands any process a terminal, and the refusal
    would also stop the operator's own `! pup ...` from Claude Code and any script, so it
    is not done; the record keeps the terminal as evidence instead (see *The record*).
    A worker can also skip the command and write `tasks.spec` in `state.db` with
    `sqlite3`, as the operator did on #161: no hook pup compiles stops a session's Bash
    writing the store. These are limits of the design, like the socket ceiling below, not bugs to
    close here, and what the rescope records says the same thing.
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
    fixed PATH, which it names. The probe's reads are the runtime's `windowSockets` and
    `listPanes` in `src/claude/session-runtime.service.ts`, the one module that runs tmux,
    beside the launch that records the socket; the rescope hands them each session's id, a
    merged or killed one's included, and matches the lines against the launch's name, read
    from `windowLabel` rather than spelled again. The process tree's `ps` is that module's
    `listProcesses`, and the walk up it the rescope's `launchedAncestor`. Its PATH and its
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
    socket, when the caller's environment does not name that socket too. Either works only
    for a caller outside the process tree, since one under the window is refused by the
    tree check (see *Who*). Checking the record against a copy pup keeps would need a copy
    the session cannot write, and the store is not one (see *Who*), so no copy is kept. A task no
    session claims is refused too: plain `pup plan edit --scope` edits it.
    *The globs.* Stricter than a plan's: a rescope widens a scope the gate already
    audited, so it names paths. Each glob is checked in the form the matcher reads it,
    trimmed and with one leading `./` dropped, so `./**` or ` **` cannot slip past a check
    on the raw string. Refused are an empty glob, an absolute one, one with a wildcard
    (`*` or `?`) anywhere in its first segment, which could match every top-level directory,
    one with a `..` segment, one under `.github` (in any case), whose workflows a same-repo
    PR runs with the repo's secrets, one under a path the gate protects from every session
    whatever its scope (`PROTECTED_PATH_GLOBS`: `.claude/**`, the hooks and settings, and
    `.pupitre/**`, the gate's own config), matched in any case as scope-audit matches them,
    and any with a C0 control, DEL or C1 control. The protected check reads the constant
    scope-audit reads, so the two cannot drift, and it tests a path in the glob's first
    segment, which the wildcard refusal leaves literal. The gate would fail such a path
    anyway, but the edit hooks a rescope recompiles would let a session write under
    `.pupitre`, so the rescope refuses rather than open what the gate then refuses.
    Nothing else is held back: `package.json`, git hook directories and the gate's own
    source are code an operator may mean a task to change, which the PR review sees, and
    a glob onto `src/core/merge-gate*` raises the task to critical (see *The tier*). `[`,
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
    *Tests.* In `task-rescope.test.ts`, with the tmux and `ps` reads mocked, a rescope on
    a merged, awaiting-review or blocked session's task with its window closed appends and
    writes the event and the record. A queued, running or rejected one writes nothing, nor
    does one whose window a server lists, nor one where a server did not answer or no tmux
    was found, each refused with its own message, and the sockets of every session on the
    task, merged and killed ones included, are asked. A window is found by its launch name
    or, renamed, by its start command, naming the server and the pane, and a tab or a
    newline in a session name does not hide it; one listed nowhere passes, whatever pane ids
    and prefix-pair names the server lists. Each socket decides alone, and a server that did
    not answer is named before a window another lists. `launchedAncestor` finds a
    conductor's or a session's Claude Code up the tree whatever the caller's environment
    says, passes over a tmux process whose arguments are a launch's, passes the operator's
    own Claude Code and a process with no `--name pup-` pair, stops at a loop in the table,
    and is unreadable when `ps` failed. In `session-runtime.test.ts`, `listPanes` runs on the
    pinned PATH with a timeout whatever the caller's PATH, and reports a server that did not
    answer with what tmux said or the timeout, and no tmux on the pinned PATH as such.
    `windowSockets` names `/tmp`'s server alone when `TMUX_TMPDIR` is unset and both when it
    is set. A launch records the socket under the launching shell's `TMUX_TMPDIR`, which
    `windowSockets` names even when the caller's environment lacks `TMUX_TMPDIR`; a record
    that is relative, names another socket or holds a control character reads as none.
    `listProcesses` reads each process's parent and arguments, an empty one included, runs
    `ps` on the pinned PATH with a timeout, and is undefined when `ps` fails. Each refused glob is refused, each matcher-form bypass with it, `.claude` and
    `.pupitre` paths in any case among them, and globs the matcher reads as plain paths
    (`./docs/**`, `src/cli/`, `.claudeignore`, `docs/.claude/x`) pass, as do `[.]github/**`, `{docs,.github}/**` and
    `\.github/**`, none of which matches `.github/x`. A stub of `assertPlannableSpec`
    shows the widened spec goes through it, and a refusal there writes nothing. The event
    records the caller as an inferred operator, with its tty and tmux pane. A re-gate's scope-audit then passes the added path and still fails a
    scope-out one. A standard task and session widened onto `src/core/merge-gate*` are
    raised to critical from the bottom rung; a standard glob leaves them standard, a task
    pinned standard over a critical scope and widened with `docs/**` stays standard, a task
    stored standard under a session already critical is raised on its own, a pair of null
    rows reports the widened scope-in's critical, and a critical tier is never lowered. `session-repository.test.ts` holds the statement's
    guard to each state, and `index.test.ts` refuses a session, the conductor and an open
    window, refuses a conductor or a session the process tree finds with its markers unset
    and a process tree it cannot read, writing nothing, and records the tty and
    `TMUX_PANE` it saw, dropping a pane that is not one.
