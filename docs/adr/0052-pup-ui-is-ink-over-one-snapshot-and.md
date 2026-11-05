# 0052. `pup ui` is Ink over one snapshot, and it renders rather than decides (2026-09-13)

- Status: accepted

52. **`pup ui` is Ink over one snapshot, and it renders rather than decides (2026-09-13).**
    Decision 41 put the backlog into `pup status` and decision 35 put stalled sessions there, and
    the command has been printing a longer and longer list ever since: it is the one place the
    operator looks to decide what to do next, and it answers by scrolling. What the operator asked
    for is a screen that stays open. That is a different artefact from a printed list, and the
    first thing it needs is to stop being two artefacts: `pup status` and a dashboard querying the
    store separately is how a session reads STALLED on one and fine on the other. Part 1
    (`buildDashboardSnapshot`) settled that — one reading, taken at one instant, for both. This is
    the screen on top of it.
    *Ink, and the cost said out loud.* A live dashboard is panes that come and go — a header, a
    table, a radar, a footer, and the controls part 3 adds — and keeping them consistent while
    one of them changes is what a component model is for. React is also the one framework Claude
    Code itself ships, so the thing pupitre supervises and the thing that watches it are written
    the same way, and an operator who can read one can read the other. The price: two runtime
    dependencies in what was a four-dependency app, and a Node 22 floor, because Ink 7 declares
    one. The alternative was ANSI by hand, and it was rejected on the second pane rather than the
    first — cursor arithmetic is cheap once and compounding after that, and it is the part nobody
    writes a test for. `ink-testing-library` renders each component to a string, so every pane
    here has one.
    *No logic in a component.* Every value on screen is a field of the snapshot; a component that
    needed a value the snapshot does not carry could not be written against the fixtures its test
    renders from, which is the rule made enforceable rather than aspirational. `src/cli/ui/` holds
    the components, the hook and the words; nothing else imports Ink or React. The corollary for
    part 3: an action will call the same core function the CLI command calls, never a private path
    of its own — the rule the snapshot enforces for reads, kept for writes.
    *Two departures from what `pup status` prints, both because a screen is held open.* The goal
    moved to the end of a session row: a printed row is read once and leads with what the session
    is for, a row here is read fifty times to answer "what needs me", and the 44-char goal column
    pushed every marker that answers it past the end of an eighty-column terminal. And merged and
    killed sessions are a count, not rows — pupitre's own store had 27 of them the first time this
    rendered, which pushed the header, the radar and the footer off a 40-row screen to show work
    nobody can act on. Both are selections and reorderings of snapshot fields, not new readings;
    `pup status` still prints every session, and the counted line says so.
    *What the words are, both surfaces share.* `goalColumn`, the origin marker, the activity
    marker, the context reading, the gate and the steer moved out of `index.ts` into
    `src/cli/ui/dashboard-text.utils.ts`, and `pup status` now calls them too. One snapshot keeps
    the two from disagreeing about what is running; sharing these keeps them from disagreeing
    about what to call it, which is the same split one layer down.
    *A terminal that is not a terminal gets the text.* Piped, redirected or captured by a hook,
    `pup ui` prints what `pup status` prints — the same function, not a second rendering — and
    exits 0. Typing a dashboard command in a script is a reasonable thing to have done, and a
    refusal there buys nothing. On a TTY it takes the alternate screen, vim's and htop's buffer,
    so quitting hands the scrollback back untouched; `q`, Ctrl-C, SIGINT and SIGTERM all reach
    `unmount`, which is what restores it.
    *Who may see the attach command is still the reader's call.* The snapshot carries the
    conductor's attach command with its `-L` socket for every caller; decision 47 says the operator
    is the only one shown it. `pup ui` asks that question through the same `showAttachCommand` the
    status printer uses and passes the answer down as a prop — a component does not get to decide
    it, and the two surfaces cannot answer it differently.
    *Not built here, and why.* The detail pane this task described — goal, scope, acceptance
    criteria, the last gate's stages and the last five events behind a selected row — is not in
    this cut. Three of those five are not in the snapshot: a session row carries no scope, no
    acceptance list, and its `lastGate` is a verdict and a failed stage rather than the stage list,
    and there are no events on it at all. Adding them is a change to `src/core`, which this task's
    scope-in does not include, so the honest options were a pane missing three of its five sections
    or no pane. The cursor it would have opened from is here and working, because part 3's actions
    need it; `Enter` and `Esc` are unbound until there is something to open.
    *Addendum (2026-09-13, part 3): the keys, and the one rule they all obey.* The screen now
    launches, steers, interrupts, kills, unblocks, respawns, attaches, toggles the conductor and
    merges, so the operator's loop runs from one place. Every key goes through
    `src/cli/ui/actions.service.ts`, and every function there calls the same core function the
    command of that name calls — this is the corollary above, made a file rather than a habit: a
    component imports actions, an action imports core, and there is no third path. The result of
    a key is a line in the status bar rather than a print, because an action on a row three lines
    up leaves nothing on that row to read; the reading refreshes right after it, so the row
    catches up on its own.
    *Errors become lines, not stack traces.* A CLI command that hits something unexpected should
    die with its stack — the operator gets the shell back and can read it. A held-open screen that
    did the same would tear down the render and leave the terminal on the alternate buffer, so
    every action answers with a message and a failed flag. The refusals the core throws are
    already written for a person to read; this is where they are read.
    *`j`/`k` are gone from the cursor.* `k` is the kill. A key that sometimes moves the cursor and
    sometimes proposes killing a session is worse than either, and half a vim pair is worse still,
    so navigation is `↑`/`↓`. The confirmations are the operator's own: `y`/`n` on the kill and on
    the unblock, which shows the reason the gate recorded before it asks — unblocking is a claim
    that *that* was addressed, and the claim cannot be made about a reason nobody was shown. The
    merge is confirmed too, which the task did not ask for: a passing gate pushes a branch and
    opens a pull request, and `m` sits under the keys this screen is navigated with.
    *Two actions do not fit inside a frame, and each bends in its own direction.* The respawn's
    wait is `pup respawn`'s wait, except that the CLI's `awaitHandoffReady` sleeps the thread —
    here that would freeze the clock, the redraw and every keystroke for up to ten minutes, which
    is the one thing a screen held open must not do. Same poll, awaited instead of slept, with the
    elapsed seconds on screen. The merge runs as a child process, `pup merge <session> --pr` with
    this process's own bin: `runMergeGate` is one synchronous pipeline of clone, install, build,
    test and audit that returns a report at the end, so called in-process it would show nothing
    for the minutes the operator most wants to watch. The child prints a stage as it finishes and
    the pane fills as the gate runs. What the child does *not* do is decide who may merge: it is
    spawned with `cwd` at the repo root, where `callingSession`'s worktree detection finds
    nothing, so its tier check is weaker than the parent's, not a second opinion on it. The parent
    decides the tier — the rule below, applied before a key is bound at all — and the child
    re-checks what only it can: the session's state and whether there is an adoptable PR. `q`
    ends that child with SIGTERM rather than leaving Ctrl-C to signal it, because the gate's lock
    directory is released in a `finally` no signal-killed process reaches; `pup merge` now removes
    the lock on SIGINT and SIGTERM itself, so an interrupted gate cannot wedge the next one.
    *Attach is Ink's `suspendTerminal`, not an unmount.* Ink 7 leaves the alternate screen, hands
    the input stream back, runs the child and forces a full redraw after it. That is exactly an
    attach, and it costs nothing: the reading, the cursor and the status line are all still there
    when tmux lets go. The conductor's window is on a socket of its own (decision 47), so it is
    `A` with the `-L` on the argv rather than a row in a list it is not part of.
    *Operator-only, as a whole rather than per key.* Every key here runs a command that is
    operator-only somewhere — the launch, the kill and the steer are refused to sessions, and the
    merge, the respawn and the unblock to the conductor as well (decisions 42, 44, 47). A screen
    that offered all of them and refused each keystroke one at a time would be a menu of things
    that do not work, so `callingSession` or `callingConductor` unbinds and hides the whole set
    and puts the reason on screen instead. Looking, re-reading and leaving are not refused to
    anyone.
    *The dead exports part 2 left.* `GOAL_COLUMN_CHARS` and `SnapshotReading` were exported and
    imported by nothing, which is what ledger #18 recorded. Neither wanted an importer: the width
    is how `dashboard-text.utils.ts` fits a goal, and every caller that reached for it wanted the
    fitted string, while `SnapshotReading` names half of the hook's own return type. Both are now
    private to their file.
    *Addendum (2026-09-17): the detail pane, now that the snapshot carries it.* The pane the first
    cut left out is in, and it went in the order this decision's rule demands — the snapshot
    first, then the component. A session row now carries its task's `scope` and `acceptance`, its
    `lastGate` carries the stage list with each stage's status and detail, and `recentEvents`
    holds its five newest stored events, oldest of them first; a backlog row gains `acceptance`
    beside the scope it already had. All of it is sanitized in `buildDashboardSnapshot`, like
    every other string there: a stage detail is a failing test's output and an event payload is
    a session's own words, so each goes through `asStageArray`'s shape guard or a type check and
    then `sanitizeReason`, and each is tested against a real store with an escape in it. What an
    event says is decided there too — the transition and verdict on a gate result, a steer's kind
    and sender, a finished session's summary — as one `detail` line, because the alternative was
    a component reading raw payloads, which is a second reader of the store under another name.
    Five, because the pane answers "what happened to this last", and `pup report` holds the rest.
    `detail.component.tsx` draws a `DetailRow` the controls hook hands it — the selected session
    or planned task as the snapshot has it — and computes nothing. `Enter` and `Esc` are bound in
    `use-controls.hook.ts`, not `app.component.tsx` as the task first said: part 3 moved every key
    there, and the precedence is the point. An open prompt keeps `Esc` for cancelling, a finished
    merge log keeps `Enter` for closing, and only then does either reach the pane — a key that
    silently changed meaning because a new pane was added is the failure part 3's one modal hook
    exists to rule out. The pane is not a mode: it shows whatever row the cursor is on, the arrows
    still move it, and the action keys still act on the row it names, so nothing on screen can
    disagree about which row an action will hit. It replaces the table rather than sitting under
    it, because acceptance, stages and events run to twenty lines and would push the radar and the
    footer off a 40-row screen; the row's state and id head the pane, so the cursor is not lost.
    Read-only callers get it: reading a row is looking. The footer's two lines were re-packed to
    fit it — `a attach` joined the row actions, and the conductor keys shortened to
    `A conductor c on/off` — so both still fit eighty columns.
