# 0102. While the project's conductor runs, a session awaiting review is left out of the needs-you inbox (2026-10-23)

- Status: accepted
- Amends: [0083](0083-pup-status-opens-with-a-needs-you-inbox.md), [0097](0097-pup-ui-shows-the-fleet-in-the-terminal.md)

102. **While the project's conductor runs, a session awaiting review is left out of the
    needs-you inbox (2026-10-23).**
    Amends decisions 83 and 97. The inbox listed every `awaiting-review` session with `pup review
    <id> then pup merge <id> --pr`, which predates the conductor gating its own branches (decision
    75 onward) and running `pup merge <id> --pr` on every finished one (the kickoff since #140).
    With a conductor up, that line asked the operator for a step the conductor was already
    taking, and an operator who ran it would race the conductor to the same gate.
    `needsYou` now reads `snapshot.conductor.running`, the answer `buildDashboardSnapshot`
    already records, and lists an awaiting-review session only when it is false. Core asks tmux
    nothing new. With the conductor running, the session stays in the session list, the
    table and the web dashboard's `awaiting-review` group, where the conductor reads
    it from `pup status`. Its operator turn comes back as the `pr-open` line once the gate opens
    the PR. A question, block or stall on the session still leads, as before. Every surface
    reads the same function, so `pup status`, `pup ui`, the terminal tab's need
    count and the web dashboard's inbox agree. With no conductor running, the line is unchanged.
    A gate refused on flagged debt is the exception (found on CI review). It writes a
    `gate_result` with `outcome: 'refused'` and leaves the session in awaiting-review, and
    accepting the debt takes a named human (decision 75), so the conductor cannot take it further
    and the session would have dropped off every surface but the table. The snapshot marks an
    awaiting-review session `gateRefused` while that refusal is the newest of its `gate_result`,
    `steer` and `session_done` events: a steer answers it, as it answers a question, and a new
    `pup session done` is new work to gate, and neither logs a transition, since the state does
    not move. Such a session is listed, conductor or not, as `gate refused on flagged debt` with
    `pup merge <id> --pr --accept-debt "<reason>" --review-by "<condition>", or pup steer <id>
    "..."`, the two ways out the refusal itself prints. Two cases stay unseen. A `--pr` merge that
    throws before the gate writes anything, a missing push target among them, leaves nothing in
    the store, and the conductor reports the error it was handed. The store does not record who
    launched a session, so one the operator launched while the conductor runs is left to the
    conductor too, whose prompt has it gate any awaiting-review session that meets its criteria.
    *Tests.* In `dashboard.test.ts`, with the conductor running, an awaiting-review session is
    absent from `needsYou` and present among the snapshot's sessions, and an open PR still
    leads. With it stopped, the review-then-merge need is unchanged. With it running, a refused
    gate keeps the session in `needsYou` with the accept-debt answer, and a steer or a new
    `session_done` after the refusal hands it back to the conductor. `pup status` with a
    conductor prints the session in its table and not in the inbox; without one it prints the
    need. The terminal tab counts the session only with no conductor, and the web dashboard
    prints the need's command only then.
