# 0188. Operator-only commands refuse a caller under a pane pid a launch recorded, and a rescope shows wherever the merge is judged (2026-11-13)

- Status: accepted
- Amends: [0115](0115-pup-plan-edit-rescope-lets-the-operator-widen.md)

188. **Operator-only commands refuse a caller under a pane pid a launch recorded, and a
    rescope shows wherever the merge is judged (2026-11-13).** Decision 115 refused a
    rescope from under a session's or the conductor's window by the `--name pup-<...>` pair
    a launch passed Claude Code, read off `ps`'s arguments, which a process can overwrite,
    and named matching pane pids as the fallback. `pup respawn`, `pup unblock` and
    `pup kill --respawn`, which decisions 44 and 47 hold to the operator for the same
    reason, were refused by the session and conductor markers alone, which the caller can
    empty or unset, and `pup ui` handed such a caller its controls. And a rescope
    was recorded where only an audit would look: the reviewer of the PR and the operator at
    the merge click saw the plan's scope, not the one the gate held the diff to. The
    security review of task t-mvdw5id6 asked for all of it.
    *The record.* A launch asks tmux to print the new pane's pid with its id
    (`-P -F '#{pane_id} #{pane_pid}'`), and refuses output in any other shape, as it
    refused a missing pane id. Once the window is up, the launching `pup`, the operator's
    or the conductor's and never the window, writes the pid to `pane-pid`, beside the
    session's `tmux-socket` record, or to `conductor/pane-pid` under the project's store
    for the conductor, written beside and renamed over. Every window a session opens goes
    through the launch, so a respawn, a hard respawn and a fix round write over the record
    of the window they replaced. tmux starts the pane's command as that pid (the launch
    passes Claude Code as the pane's command, with no shell around it), and every Bash the
    window runs is under it.
    *The match.* `launchedAncestor`, now in `operator-guard.service.ts`, walks from the
    caller's parent up the one `ps` table decision 115 reads, and asks each pid first
    whether a launch recorded it, then whether its arguments carry the launch's `--name`.
    pid and parent pid are the kernel's and no process rewrites them, so a Claude Code
    that rewrote its title (`setproctitle`) still matches by its pid. The records read are
    each session's of the project in a state that can hold a window (`queued`, `running`,
    `awaiting-review`, `rejected`, `blocked`), and the conductor's while its window is up
    (`hasConductorWindow`), since a record outlives its window and its pid is the system's
    to reuse once that window is gone. The conductor has no state to bound its record, and
    neither `pup conductor stop`, a conductor that exits on its own nor a reboot removes
    it: read regardless, a stale one would refuse the operator from the day its pid went
    to one of their processes. A session id outside the minted shape names no path and is
    skipped. The arguments check stays: it reaches other projects' windows, whose records
    are in their own stores, and a window launched before the record existed.
    *The ceilings.* A pid the system reused after a window died while its session stayed
    in a holding state (a crashed pane on a blocked session) can be one of the operator's
    processes, which is then refused, the refusal naming the window and the pid; killing
    the session or ending that process clears it. That fails toward refusing, never toward
    passing. The records are in the store, which a session can write (decision 115's
    *Who*): a window that writes another pid over its own record, and runs under a Claude
    Code whose title no longer carries `--name`, is matched by neither check. The
    conductor's window is probed as `pup status` probes it, with the caller's `PATH` and
    `TMUX_TMPDIR`: a caller that points them elsewhere hides the conductor's record as one
    that writes over it does, and is still matched by its Claude Code's `--name`. Each record
    is read as one a session wrote, with no symlink followed, bounded, and only digits as
    a launch writes them counting. Another project's window is found only by its arguments.
    A process that left the tree (a double fork, `setsid`, a job tmux or launchd started)
    is under none of them, as decision 115 says.
    *The commands.* `pup plan edit --rescope`, `pup respawn`, `pup unblock`,
    `pup kill --respawn` and `pup dashboard`, whose page merges, lands, answers and closes
    debt in the operator's name, each ask after their marker checks, against the store of
    the project they act on, and refuse a caller found under a recorded pane (naming the
    process and the window), under a process carrying a launch's `--name`, or with a
    process tree `ps` could not read, changing nothing. So does every `pup merge`, before
    the gate writes anything: even with `--pr`, a merge writes a debt acceptance to the
    ledger under the approver it is handed, as a human's, and rejects or parks `blocked`
    the branch it gates, so a session that emptied its markers and left its worktree must
    not run one from its window. The conductor's own window, this project's, is spared
    only for a `--pr` with no debt or with one relayed under its approver's name (decision
    75), and is walked past rather than taken as the answer: every process above it is
    still asked, its arguments too at the pid its record names, and a session's record
    wins a pid the conductor's also names, so a session that sets a process's title or
    writes a record to name the conductor's window is still found by its own. The local
    fast-forward and a debt acceptance with no `--approved-by` or one naming `human`,
    which the ledger records as the operator's own, spare no window. "Whatever its
    environment says" is in the refusal: emptying or unsetting `PUP_SESSION_ID` and
    `PUP_CONDUCTOR` changes nothing here. The plain `pup kill` is not asked: it is the
    conductor's to run. The other commands the markers hold to the operator (`pup answer`,
    `pup debt close`, `pup retire`, `pup land --accept-head` among them) are not asked yet.
    `pup ui` asks the same question after the markers, and on any answer but none shows
    the dashboard read-only with the reason in its footer, as it does for a session or
    the conductor (its keys run the respawn, the unblock and the merge). The fleet view
    asks each store its reading opened, so a project the fleet refuses to open is not
    opened for this either, and is read-only when any of them finds the caller.
    *The overlap check.* The globs a rescope adds go through the check a launch runs
    (decision 99) against every live session of another task, inside the rescope's
    transaction: the files they share are recorded as a `scope_overlap` event on the
    claiming session, with `via: 'rescope'`, and printed as `OVERLAP <session> <file>`
    lines after the rescope's own. It never refuses: the operator widened the scope
    knowingly, and the next fix round introduces the workers as a launch's overlap does.
    *Where it shows.* `taskRescopes` reads every `rescope` event across the task's
    sessions, oldest first, so a relaunch after a kill still shows its predecessor's, each
    field taken only in the type a rescope writes. The PR body the gate writes gains a
    `## Rescopes` section between the acceptance and the commits, only when there is one,
    listing each rescope's time, session, added globs, tier and whether it was raised, and
    what was seen of the caller (`by`, `tty`, `tmuxPane`), said to be evidence and not
    proof. It is fenced as the commit subjects are, every value scrubbed to one line, and
    each line opens with `- `, which no closing fence does. A re-gate's rewrite of the
    body reads them again, so the section stays. `pup status`'s needs-you inbox, and the
    web dashboard that renders the same lines, append `; scope widened after launch:
    +<glob>, ...` to the lines whose next act is the merge, every `awaiting-review` and
    `pr-open` one, showing three globs and counting the rest; the session's
    `DashboardSession.rescoped` holds them all, scrubbed.
    *Tests.* `session-runtime.test.ts`: a session's launch and the conductor's record the
    pid tmux printed, a print that is not a pane id and a pid refuses the launch, and
    `recordedPanePids` names each window, reads only the sessions asked and the conductor's
    record only while its window is up, names a session's window for a pid the
    conductor's record names too, and ignores a malformed record and a symlink.
    `operator-guard.test.ts`: a recorded pid up the tree finds a session's or the
    conductor's window whatever the caller's environment and the arguments `ps` shows,
    wins over a launch name further up, reads only holding-state sessions and minted ids,
    and passes a tree that holds none; a spared window passes a caller under it alone, and
    a session's pane above a record or a title naming it, or a session's name at the pid
    its record names, is still found; `mergeCallerAncestor` finds the local merge and a
    debt accepted as the operator's own under the conductor's window, walks past it for a
    PR with or without a named approver, and finds a session's or another project's
    conductor's window for one; decision 115's arguments cases stay. `task-rescope.test.ts`: the overlap check records and returns another
    task's live session and leaves the task's own, and `taskRescopes` lists a task's
    rescopes across its sessions and no other task's. `index.test.ts`: each of the four
    commands is refused under a session's and the conductor's recorded pane with its
    markers emptied and unset, and when `ps` fails, writing nothing, and goes through with
    no recorded pane in its tree; the plain kill goes through under one; a rescope prints
    its overlaps. `index-3.test.ts`: `pup ui` is read-only under a recorded pane with its
    markers emptied and unset, and when `ps` fails, and the fleet is read-only under a
    pane one project's store recorded; `pup dashboard`, the local merge and a debt
    accepted in the operator's name are refused the same ways, a `--pr` with or without a
    named approver is refused under a session's pane and when `ps` fails, and goes through
    under the conductor's. `merge-gate.test.ts`: the body lists the rescopes,
    scrubbed, has no section without one, a gate opening a PR reads them off the store,
    and a re-gate's rewrite lists one taken after the first gate. `dashboard.test.ts`: the
    awaiting-review, refused-gate and
    open-PR lines name the added globs, an earlier session's included, a blocked line and
    an unwidened session do not, and a planted glob is scrubbed.
