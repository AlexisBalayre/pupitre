# 0035. A running session is STALLED by events-file mtime, not a logged timestamp (2026-08-02)

- Status: accepted
- Amended by: [0103](0103-the-idle-prompt-is-a-turn-end-a.md)

35. **A running session is STALLED by events-file mtime, not a logged timestamp
    (2026-08-02).** Observed live: a transient API network error left a session dead at its
    prompt for an hour while `pup status` still read RUNNING — `classifySessionActivity`
    (decision 2) correctly classified the last hook event, but nothing carried an age, so a
    five-second permission ask and a silent hour-long wedge rendered identically. The
    operator only noticed by reading the tmux pane by hand. Hook events themselves carry no
    timestamp field (verified against a live `~/.pupitre/*/sessions/*/events.jsonl`), so
    staleness is read from the events file's mtime instead of adding one: every hook append
    already touches the file, so its mtime is the last-activity clock for free, with no
    change to the event schema or the hooks that write it. `STALLED_AFTER_MS` (10 minutes,
    `session-activity.constants.ts`) gates a running session whose events file is older than
    that, independent of its classified activity kind — staleness wins over
    awaiting-input/idle/working, since the whole point is that a wedge can present as any of
    them. `pup status` prints `STALLED (Nm)` and sorts stalled sessions to the top alongside
    `blocked` ones; `pup watch` emits one `STALLED` line per sweep for each.

    *Addendum, 2026-09-13: one reader of session activity, and it is not the CLI.* The stall
    rule and `classifySessionActivity` both lived in `src/cli/index.ts`, which was fine while
    the terminal list was the only surface that asked. The terminal UI is a second one, and
    two surfaces each reading the events files their own way is how a session ends up STALLED
    on one and working on the other — the exact failure this decision was written against,
    one layer up. So `buildDashboardSnapshot` (`core/dashboard.service.ts`) is now the single
    reader: it opens each running session's events file once, classifies it, ages it by mtime,
    and hands both out on the session row. `findStalledSessions` moved there beside it, since
    `pup watch` asks the same question on a sweep where there is no snapshot to build. The CLI
    keeps only the printing — `activityMarker` now reads the row, never the file.
    Two rules survive the move as written, and are worth naming because a reader of the
    snapshot could reasonably assume otherwise. Activity is read **only** for a running
    session with an events file: a finished session's last hook event is history, not
    activity, so the field is absent rather than `unknown`, and the marker is empty for the
    same reason it always was. And `needsHuman` is deliberately wider than what sorts first —
    it counts awaiting-input, which the sort does not, because a five-second permission ask
    flagged at the top would bury the blocked session the operator actually has to act on.

    *Addendum, 2026-09-14: the radar resumes a turn that died on an API error, and the pane
    is evidence, not state.* Observed twice on 2026-09-13: a machine asleep at 01:16 and a DNS
    outage at 13:00 each ended a running session's turn with `API Error: Connection lost while
    your computer was asleep` / `Can't reach the API server (ENOTFOUND)`. That is not a turn
    end — no Stop hook fires, so the events file stops dead, `pup status` read STALLED for
    hours, and the session sat at an empty prompt with its edits in the worktree. Both times
    the conductor's own waiting turn died the same way, so nobody resumed the worker until the
    operator typed into its window by hand. The stall rule had found the session; what was
    missing was the one further question the operator was answering by eye: is this pane
    showing a dead turn?
    So `pup watch`'s sweep now runs a turn watchdog (`core/turn-watchdog.service.ts`) over the
    sessions `findStalledSessions` flags: it captures each one's launch pane (by the pane id
    recorded at launch, decision 46) and, when the last transcript line above an *empty* input
    box matches `^⏺ API Error:`, appends a `turn_died` event with the error line (sanitized,
    decision 29) and steers the session with a fixed resume message, recorded as a `steer
    {kind: 'resume', by: 'watch'}`. A refused steer — the paste never landed, or the pane is
    gone — is recorded on the same `turn_died` event as its `refusal` and left for a human;
    `pup status` prints `TURN DIED (API error) — resumed by watch at hh:mm` (or `resume
    refused …, needs a human`) on that row instead of the bare age, and `pup watch --once`
    prints one line per resume. Four things were chosen deliberately:
    - **Decision 2 holds: the pane is read for recovery only.** The store keeps the event and
      the steer; nothing about the session's state is derived from the capture, and the
      capture is not kept. The alternative — a `deadTurn` field on the dashboard snapshot —
      would have made the pane a second reader of session activity, the exact split the
      previous addendum closed.
    - **Idempotence is a stall stamp AND an age, not "the newest event".** The spec's rule
      (skip when the newest event since the last steer is already `turn_died`) re-fires every
      sweep, because after a resume the newest event *is* the resume steer. The `turn_died`
      event instead carries `stalledAt`, the events file's mtime — the very clock this decision
      ages a stall by, which stands still for exactly as long as the session does — and a
      recorded dead turn blocks a new resume only while it is younger than `STALLED_AFTER_MS`.
      Both halves are needed. The stamp is what keeps one dead turn from being resumed every
      sweep, and gives a session that recovers, works and dies again a new stamp and its own
      resume. The age is the DNS-outage case the watchdog was written for: the resumed turn
      dies again at once, no hook fires, the stamp never moves, and a stamp alone would have
      left that session dead after the network came back. Past the window, the same error
      over the same empty box is the next dead turn of the same stall — a new `turn_died` with
      the same `stalledAt`, and `pup status` reads the newest. The cost is one resume message
      every ten minutes for as long as an outage lasts, into a box that is empty each time.
    - **One event carries the outcome.** The event is written after the steer attempt so a
      refusal sits beside its cause rather than in a second event. The window that leaves — a
      watcher killed between the steer and the write — costs one duplicate resume message,
      which lands in an empty box behind the first and reads as a follow-up. The other order
      would leave a refusal unrecorded and steer every fifteen seconds for the length of the
      outage.
    - **The conductor is nudged on its own socket, with a null-session event as its
      cooldown.** Its window lives on `conductorSocket` (decision 47) and records no pane id,
      so the watchdog resolves the pane with `list-panes` there — the lowest id, since the
      launch kills the server first and tmux never reissues an id within one — and types a
      one-line nudge (`Operator watchdog: your turn died with an API error; read pup status and
      resume any session that needs it`), last in the sweep so the sessions it will be asked
      about are already resumed. The nudge itself moves the pane past the error line; for an
      outage long enough to kill the nudged turn too, the nudge is recorded as a `turn_died`
      event with `session_id = NULL` (the conductor has no row; every other `events` query is
      keyed on a session id, so the row is inert for them) and not repeated inside
      `STALLED_AFTER_MS`.
    The radar is the watchdog's host, so `pup conductor start` brings it up when none is
    running — the store's watcher beat missing or stale, not a window name a session could
    mint — and says so: a conductor without a radar is the fleet that needed the operator
    twice. `pup watch` itself is operator-only, like `pup audit`: it types into panes and
    records resumes in the watcher's name, so a session or the conductor running it could forge
    a resume against another session; the detached radar passes because `launchWatcher` runs
    it from the main checkout with both tier variables stripped. Two more readings of the pane
    are refused on purpose: a line that carries `Retrying` is a turn still alive and backing
    off, not a dead one, however long the series outlasts the stall window; and a sweep that
    throws is printed to the radar's stderr and skipped, never allowed to kill a process whose
    beat the overlap scan has already recorded. Rejected: a Stop hook that would fire on an API
    error (Claude Code fires none), a retry inside the session (the turn is over; only a new
    prompt starts one), and a watchdog on the conductor's `pup status` reading (its turn is the
    one that dies).
    Accepted, not fixed in code: a forged `turn_died` row in the store — decision 46 takes store
    access as the root of trust — now turns a wrong STALLED age into a reassuring `resumed by
    watch` sentence on the row and, for one stall window, suppresses the real resume. A session
    with write access to the store could always mark itself done; this adds one more sentence
    it can make the operator read, and the age bound above puts a ten-minute ceiling on what
    the forgery suppresses.

    *Addendum, 2026-09-14: the line is on the snapshot, and the `deadTurn` field the addendum
    above rejected is now the right one.* The addendum shipped the line in `pup status` only:
    `deadTurnLabel` lived in `src/cli/index.ts` and called `lastDeadTurn` itself, so `pup ui`,
    which draws every column off `DashboardSnapshot`, still showed the bare STALLED age for a
    session the watchdog had already resumed. Two surfaces telling the operator different
    things about the same always-visible row is exactly the split decision 52 exists to
    prevent, so the sub-decision above — *no `deadTurn` field on the snapshot* — is reversed.
    Its reasoning does not survive the second surface: it read the field as making the pane a
    second reader of session activity, but nothing on the snapshot reads a pane. The watchdog
    captures the pane, keeps nothing of it, and writes a `turn_died` event; the snapshot
    matches that **stored** event against the stall stamp, which it takes from the same
    events-file mtime this decision ages every stall by. That is the store answering, like
    every other field on a row — the reading moved, not its source. Decision 2 is untouched:
    the pane is still read for recovery only, still by the watchdog, still once per sweep.
    Three details follow from where the code now sits. `findStalledSessions` returns
    `stalledAt` beside the age — it stats the events file already, and the stall's name and
    the stall's age are one reading — which also deletes the watchdog's private copy of that
    stat and, with `lastDeadTurn` now unused, the function itself. The direction of the
    import is why the match is written out again in `dashboard.service.ts` rather than called
    from the watchdog: `turn-watchdog.service.ts` imports `findStalledSessions` from the
    snapshot service, so the snapshot service reaching back for `lastDeadTurn` would be a
    cycle. And the sentence itself is one helper, folded into `activityLabel`
    (`cli/ui/dashboard-text.utils.ts`) rather than set beside it — which sentence that column
    carries is one decision, and a surface that had to remember to ask for the dead turn *and*
    the age would be the same drift one layer down. The `reason` — the pane's own error line —
    rides on the field but stays off both rows: it is the same sentence every time, `pup watch`
    prints it, and the row is already at the width where the `needs a human` tail truncates on
    an eighty-column terminal.
