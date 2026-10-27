# 0047. A conductor session is the operator's delegate for everything but the merge, and every session is addressable by its peer name (2026-09-12)

- Status: accepted
- Amended by: [0075](0075-the-conductor-gates-a-branch-with-pup-merge.md), [0087](0087-pastes-go-through-a-buffer-named-for-the.md)

47. **A conductor session is the operator's delegate for everything but the merge, and every
    session is addressable by its peer name (2026-09-12).** The loop the operator runs by hand
    — `pup status`, launch a task, wait for the session to go idle, steer it with evidence,
    read the branch, hand it to review — is one a model can run, and on a larger model than the
    sessions it drives (Fable conducting Opus sessions). Subagents inside one session were the
    alternative and lose what a session has: its own worktree, branch, scope hook, events and
    gate. So `pup conductor [--model <m>] [--worker-model <m>]` opens one Claude Code window
    per project, the conductor, and `pup conductor stop` closes it.
    *Every session launches with `--name pup-<id>`.* Claude Code's cross-session messaging
    (ListAgents, SendMessage; on by default since 2.1.224) lists a session under its display
    name, so the name is the tmux name: the id `pup status` prints and the operator attaches
    to is the one a peer addresses. The peer socket is the better steer transport — a message
    lands whole and queues until the current tool call ends, where the input box has decision
    45's paste cliff and the dim suggested prompt that refuses every post-turn steer — and
    `notify_when_idle` is a one-shot "finished its turn" where the operator polled
    `events.jsonl`. pupitre never speaks the socket protocol, which is undocumented; the
    conductor does, with its own tools. Decision 1 stands: tmux is pupitre's transport, and
    `pup steer` still types.
    *What the conductor is.* Not a session: no task, worktree, branch or row. An interactive
    `claude` in tmux named `pup-conductor-<project id>`, cwd the main checkout, bypass
    permissions and user setting sources like a session, and a compiled profile under
    `~/.pupitre/<id>/conductor/compiled` whose PreToolUse hooks refuse every Edit and Write
    and guard `.claude/` in shell — no scope files, no event hook, since it has no scope to
    enforce and no row for events to land on. `PUP_CONDUCTOR=<project id>` is exported in
    place of `PUP_SESSION_ID`; the guards tell the two apart by which variable is set, and
    tmux's `-e` sets the window's environment, not the server's, so the variable does not
    reach the sessions it launches. Its kickoff is a compiled context: the commands it may
    run, the peer protocol, the refusals, and the protocol — one session per backlog task,
    subscribe for idle, steer with the exact unmet criterion, report and stop.
    *The tier.* A session is refused `plan add|drop|edit`, `new`, `launch`, `kill`, `merge`,
    `respawn` and `--project` (decisions 40, 42, 43, 44). The conductor is allowed the first
    four and `steer`, `interrupt`, `status`, `review`, `debt`, `log`; it is refused `merge`,
    `respawn`, `kill --respawn`, `debt close`, `--project` and `pup conductor` itself
    (*amended by decision 75:* it may run `merge --pr`, never the local merge). The
    operator has everything. The merge stays with the operator because the verdict moves a
    branch onto main and the human is the reviewer — the product is the operator's
    understanding, not throughput, and a conductor that merged would be a session merging
    sessions under another name. The respawn stays because its kickoff quotes a handoff any
    window with a shell in the store can write (decision 44) — and so does `kill --respawn`,
    whose kickoff is the `context.md` under the store's compiled dir, the same directory; the
    security review found the plain `kill` guard covering it and the conductor walking through.
    `debt close` was guarded for nobody; a session or a conductor retiring an entry erases the
    operator's own overdue-debt reminder, so it is operator-only now for both. A session or a
    conductor minting a conductor is refused for the same reason a session cannot launch: it
    would hold every launch and kill under a name that is not its own.
    *Attribution, not prohibition.* Decision 40 refused a session-authored spec because it
    would carry `origin='human'` — the operator's attribution on a prompt the operator never
    wrote. A conductor-authored task carries `origin='conductor'`: the CHECK on `tasks.origin`
    gains the value, and a store from before it is rebuilt once on open — `tasks_rebuilt`
    with the current constraint, rows and ids copied, the swap done with foreign keys off
    because `sessions.task_id` names the table by a name that is gone between the drop and
    the rename, and `foreign_key_check` empty after (verified on better-sqlite3 13 before the
    migration was written). The rebuild is tolerated like the drop migration: a lock fails it
    and the next open retries. An overlap the conductor waves through is recorded
    `via: 'conductor'`, so `scope_overlap` names who answered for it. A steer delivered by
    message never touches `pup`, so `pup steer <session> --sent "<message>"` records it —
    `{kind: 'message', by}`, nothing typed, where `by` is `session:<id>` for a session pup can
    identify before it is the conductor's or the operator's word (decision 44's order: a
    session that exports `PUP_CONDUCTOR` is still the session) — because without it the
    dossier's timeline showed a session corrected by nobody, and `isHandoffReady`'s last-steer
    query would not see a request that went by message; the dossier prints the sender. The
    origin is shown where the operator decides, not only in the report: `pup plan` and the
    `planned` rows of `pup status` carry `(from conductor)`, since the loop the operator runs
    is status, review, merge, and the report is none of those.
    *Verified.* The runtime spawns the conductor's window with the name, `PUP_CONDUCTOR`, no
    `PUP_SESSION_ID`, and the checkout as cwd; the compiled hooks are executed under `sh` and
    the edit block refuses every path; the CLI suite drives each tier through every guard — a
    session and a conductor are refused `pup conductor`, the conductor launches with
    `overlapVia`, plans with `origin`, kills, and is refused the merge, the respawn and
    `--project` with a message that says who merges; the migration runs against a store
    rebuilt to the old CHECK with a session referencing its task, and the row, the foreign
    key and idempotence are asserted.
    *What this leaves open.* **The conductor is the highest-privilege agent in the system.**
    Bypass permissions in the main checkout: the edit hook stops Edit and Write, the bash
    guard stops shell writes into `.claude/`, and nothing stops `git commit` or `git push`
    from the root — one Bash call. Remote branch protection and a sandbox are the
    instruments, not another grep. **Any session can reach the conductor, by two channels.**
    The peer socket namespace is per OS user, so a session's SendMessage into the conductor
    is one injection path; the tier bounds what it can be talked into — a plan, a launch, a
    kill, each recorded as the conductor's own, never a merge — and the context says a
    session's message is a report. Claude Code's `crossSessionInbound: hold` on the
    conductor's settings would put the operator on every such message, at the cost of the
    automation; not set, and worth a flag if the injection is ever seen live. The stronger
    channel is tmux itself: the conductor's window is on the default server every session
    holds `$TMUX` for, under a name any session can compute from the repo path, so one
    `tmux send-keys -t =pup-conductor-<id>:` from a session lands in the conductor's input box
    as if the operator had typed it — no "report, not instruction" rule applies to a keystroke
    — and `capture-pane` reads its whole transcript. The close is a separate tmux socket for
    the conductor (`-L`), which has to be threaded through spawn, kill, probe and the kickoff's
    paste path, and `pup launch` run from inside it must then put sessions back on the default
    socket, since `$TMUX` in the conductor's pane would select its own. Its own change,
    planned in the backlog; until it lands, the conductor is as reachable by a session as a
    sibling session is (decision 46's cross-session moves), with more to lose. **`--sent` is
    the caller's word past what pup can see.** A shell that unsets both variables writes the
    event as the operator; the record is honest when the caller is, decision 27's best
    effort. **Conductor-authored scope is unconstrained.** `assertPlannableSpec` refuses an
    empty scope and control characters, nothing else, so a conductor talked into `--scope
    '**/*'` launches a session whose hook allows every path but `.claude/`; the origin marker
    is what the operator has, and a scope floor for agent-authored specs is a design question
    left open. **Killed by name.** No pane is pinned
    for the conductor (nothing types into it after its kickoff), so `pup conductor stop` is
    the name-only kill decision 46 describes, and a rename from inside survives it. **Open as
    before:** `pup audit` and `--sweep` are reachable by the conductor as by a session
    (backlog t-mtnhzcng). **Unverified live:** whether a message that starts a new turn fires
    the Stop and PostToolUse hooks the way a typed prompt does — decision 2's activity
    classification may lag a message-driven turn — and whether the dim suggested prompt
    affects a message-started turn at all. The first live conductor run answers both.
    *Addendum, 2026-09-12: the conductor's own duplication, folded.* Three merges landing the
    conductor and the pane pin took duplication 74 -> 88 -> 106 -> 124, each increase accepted
    as debt or merged outside the gate (ledger #10, #12). The clones were the shapes this
    decision multiplied, not accidents: every tier guard is the same
    `console.error` + `process.exitCode = 1` + `return`, every launch path the same
    roll-back-a-refused-kickoff-then-print-the-window tail, and the conductor's window the same
    trust-resolve-spawn as a session's. So each is one place now — `refuse(message)` for every
    refusal, `launchOrRefuse` + `reportLaunched` for `new`, `launch` and `--sweep`, and
    `spawnClaudeWindow` for both windows, whose only difference is the cwd and the one variable
    that names the caller. `rollBackRefusedLaunch` keeps the order both rollbacks need — the
    refusal first, so an `undo` that throws cannot hide why the launch failed — and takes the
    undo and its sentence from the caller, because a session's rollback kills a session and the
    conductor's kills a window. Every message is unchanged, so no test moved with them.
    *What did not get folded, and why.* `startConductor` and `startSession` share a
    compile-write-launch-kickoff shape, but `startSession` interleaves the worktree, the branch
    and three store writes between those steps in an order it needs (decision 40), and lives
    outside this task's scope; a helper spanning them would be a shape, not a behaviour. The
    measured clone the gate had actually flagged there was between the production
    `new-session` argv and the three test sites spelling it out, which is now one `spawnPrefix`
    helper in the test. *Verified.* The duplication capability the merge gate runs, pointed at
    the branch, reports 62 duplicated lines in 6 blocks against main's 124 in 11; every block
    left is outside this change. The full suite passes unchanged but for that argv expectation
    and one stub: `PUP_CONDUCTOR` now joins `PUP_SESSION_ID` at `''` in the CLI suite's
    `beforeEach`, because a suite run from inside the conductor's own tmux inherits the
    variable and 37 project-resolution tests then fail on a guard that is working correctly.
    *Addendum, 2026-09-12: the conductor's own tmux socket.* The stronger of the two channels
    above is closed: the conductor's window opens on `-L pup-conductor-<project id>`, a server
    of its own, and the flag is threaded through the launch, the stale-name kill before it,
    `pup conductor stop`, the running probe, and the kickoff — the pane the launch returns
    carries its socket, so every `load-buffer`, `paste-buffer`, `send-keys` and `capture-pane`
    of the paste path names the same server. A socket is not a name to guess past: a client
    asks one server and is told nothing about any other, so the `send-keys` and `capture-pane`
    a session could aim at a computable window name now answer `can't find session` (verified
    on tmux 3.7b against a throwaway socket). The window also leaves the server a session's
    own `kill-server` or decision 46's cross-session pane moves can reach.
    *The other half is `$TMUX`.* tmux takes its socket from `-L`, and only then from `$TMUX`,
    and only then from the label `default` — so `pup launch` run in the conductor's pane, which
    is where the conductor runs it, would have opened the session on the conductor's own server,
    back inside `send-keys` reach. Every tmux call in the runtime now drops `$TMUX` from the
    environment it hands the client, which leaves it at `default`: the conductor names its
    server with `-L`, everything else means the operator's, and no call inherits which one.
    `PUP_CONDUCTOR` and `PUP_SESSION_ID` are dropped with it, because tmux copies the
    environment of the client that STARTS a server into that server's GLOBAL environment, and
    every window opened on it afterwards inherits that — verified: a server first started by a
    client carrying `PUP_CONDUCTOR=probe-value` handed the variable to a second window that was
    launched with no `-e` and from an environment without it. A default server first started by
    a launch from the conductor's pane would have minted sessions that read as the conductor to
    every guard. What a window is, its own `-e` says, and nothing else.
    *And the security review found the rest of that environment worse than the two variables.*
    `pup launch` from the conductor's Bash starts the default server whenever the operator has
    no tmux up, and a tool shell carries `CLAUDE_CODE_MESSAGING_SOCKET` and
    `CLAUDE_CODE_MESSAGING_TOKEN` — the peer channel's credentials — along with
    `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE` and `CLAUDE_CODE_EXECPATH`. A server's global
    environment is readable by ANY client of that server (`show-environment -g`), so a session
    could have read the conductor's peer credentials off the server it was launched on and
    spoken the channel AS the conductor, past the tier entirely. The scrub is patterns now, not
    three names: `TMUX`, `PUP_CONDUCTOR`, `PUP_SESSION_ID`, `^CLAUDE`, `^ANTHROPIC_` and
    `NODE_OPTIONS` — the last because `--require` in a server's environment is code execution in
    every node process a window later starts. `PATH`, `HOME`, `TERM`, `SHELL`, `LANG` and
    `TMUX_TMPDIR` pass through; tmux needs the last to find its own socket.
    *The conductor's server is killed whole before its window opens.* The stale-name kill was a
    `kill-session`, which leaves the SERVER up — and whoever started a server owns its global
    environment. The socket label is as computable as the window name, so a session could
    pre-start a server on it carrying `NODE_OPTIONS=--require`, and the conductor's `claude`
    would inherit that at spawn: the isolation would have handed the attacker the window it was
    built to protect. `launchConductor` now runs `kill-server` on its socket first, so the
    conductor always opens on a server this process started, with the environment above.
    `pup conductor stop` keeps the name-pinned kills, which is what a leftover needs.
    *One field to distrust.* `ConductorHandle.paneId` is a `%N` with its server stripped off; a
    pane id is only meaningful together with its socket, and a future caller that passed this one
    to a default-socket kill would kill whatever pane wears that id there — a session's. Nothing
    reads the field today, and whatever does should take the socket with it.
    *Two smaller consequences.* `pup conductor stop` kills the pinned name on the conductor's
    socket AND on the default one, where nothing pup runs wears that name: what is there is a
    window from before this split, or one a session minted to look like the conductor. The
    probe is not symmetric — `isConductorRunning` asks only the conductor's socket, because a
    window on the default server is not the conductor and answering for one would report a
    conductor that is not there. It is no forgery defence: the conductor's socket is reachable
    by anything running as the same user, so a window minted on it passes the probe, and
    `pup status`'s conductor line stays the tmux server's word at decision 27's ceiling, like
    every other env-declared fact. And the attach is printed with its socket now
    (`tmux -L pup-conductor-<id> attach -t pup-conductor-<id>`), since a bare `tmux attach -t`
    no longer finds the window — in `pup conductor`, which is operator-only, and in
    `pup status` only when neither `PUP_SESSION_ID` nor `PUP_CONDUCTOR` is set: the operator is
    the only caller that attaches, and pup should not be the thing that hands a session the
    socket the conductor lives on. A session can still compute the label, as it could the name;
    not printing it is the same best effort as the rest.
    *Verified.* The suite's fake tmux models servers, not just panes: a leading `-L` selects a
    state directory, and a socket with no directory fails the way a socket with no server does.
    The conductor's launch, its stale-name kill, its kill, its probe and every command of its
    kickoff carry the flag; a steer and a kickoff addressed to the conductor's pane by a client
    with no `-L` raise `SessionPaneMissingError` and type nothing, on either server; a session
    launched with `$TMUX` naming the conductor's socket and `PUP_CONDUCTOR` set carries no
    `-L`, and no tmux call of that launch sees `TMUX`, `PUP_CONDUCTOR` or `PUP_SESSION_ID`,
    while the window's own `-e` still says `PUP_SESSION_ID=<id>`; a launch whose environment
    holds the messaging token, the session id, `CLAUDECODE`, an `ANTHROPIC_API_KEY` and a
    `NODE_OPTIONS=--require` hands tmux none of them and `TMUX_TMPDIR` and `HOME` unchanged; the
    conductor's launch kills its whole server before the stale-name kill and the spawn; and
    `pup status` prints the attach line to the operator and the bare `conductor running` to a
    session and to the conductor.
    *What this leaves open.* **The OS user is still the boundary.** Socket files live in
    `$TMUX_TMPDIR/tmux-<uid>/`, a directory the user owns and can list, so a session that
    thinks of it reaches the conductor with `tmux -L pup-conductor-<id> send-keys` as before —
    the label is as computable as the name was, and no label is secret from a shell running as
    the same user. What the split closes is the whole default-socket surface: the tool that
    inherits `$TMUX` and addresses a name, the stray keystroke, the transcript read from the
    server the session is already attached to, `kill-server`, and the pane moves decision 46
    describes. The sandbox is still the instrument for the rest, as decisions 44 and 45 said,
    and this is the same OS-user boundary the peer socket has — which is untouched: a session's
    SendMessage into the conductor remains the injection path the tier bounds. **Killed by name**
    stands: no pane is pinned for the conductor, so a rename from inside still survives
    `pup conductor stop`, now on a server the operator reaches only with `-L`.
