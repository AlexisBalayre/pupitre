# 0168. A conductor no tell reaches for ten minutes is in Needs-you, and pup only looks (2026-11-09)

- Status: accepted
- Amends: [0083](0083-pup-status-opens-with-a-needs-you-inbox.md), [0085](0085-pup-attach-hands-the-terminal-to-the-conductor.md)

168. **A conductor no tell reaches for ten minutes is in Needs-you, and pup only looks (2026-11-09).**
    The conductor stops without a word when its input box holds an unsent draft, or when its pane
    shows something other than its main input: a subagent's view, the background-shell list, the
    rewind menu. Every worker's idle notice and every `pup conductor tell` is refused there, since
    decision 85's tell types only into an empty box on screen, and nothing told the operator. It sat
    idle from 06:41 to 09:22 on 2026-10-26, and overnight on 2026-10-24.
    `conductorBlock` makes the same look the tell refuses on, `readInputBox` on the conductor's
    pane, and only that look. Once the box has not been empty and on screen for over ten minutes
    (`CONDUCTOR_BLOCKED_AFTER_MS`), the snapshot's conductor carries `blocked` (`unsent draft` or
    `not on main input`, and its age). `needsYou` then lists it as a `conductor` line, after the
    questions and before every session need, since while it sits there no finished session's notice
    lands. The answer is the attach line. `pup status`, the fleet view, `pup ui` (the tab's
    needs-you count and its piped text) and `pup dashboard` all read it from that one inbox.
    `pup status` run by a session or by the conductor shows `the operator attaches` instead of the
    socket, as its conductor line already did (decision 47).
    Read-only, on purpose. pup never clears, submits or keys into the conductor's pane for this.
    The draft may be the operator's own from `pup attach`, and an overlay takes keys as choices,
    so the only safe hand on it is the operator's, attached.
    Ten minutes, so an operator typing into the conductor, or glancing at a subagent's view, never
    shows up. The clock is the time of the first look that found the box not empty, kept in
    `conductor/blocked-since` beside the session cap, because `pup status` is one-shot and has no
    earlier reading to compare with. Any look that finds the box empty drops it, and so does every
    `pup conductor start` before its window opens: a conductor stopped or crashed while unreachable
    leaves its clock behind, and the next one, booting or holding its kickoff, would otherwise be
    named blocked at once.
    Holding a draft and then an overlay keeps one clock, since a tell reaches neither. A tell that
    bounces off the box also starts the clock. So the first worker notice refused, not the
    operator's next `pup status`, is when the ten minutes begin. A file that holds no time, a time
    later than now, or a link is replaced rather than read or written through. A look whose
    capture fails says nothing either way.
    Rejected: clearing or submitting the draft automatically (the operator's text, lost or sent
    unread). Timing from the conductor's transcript or tmux's window activity (the transcript sits
    in a directory the operator's own sessions in the main checkout share, and an idle Claude
    Code window's redraws are no clock).
