# 0119. The session cap counts working sessions, not those idle in review (2026-10-28).

- Status: accepted
- Amends: [0096](0096-test-runs-queue-for-a-few-machine-wide.md)

119. **The session cap counts working sessions, not those idle in review (2026-10-28).**
    Decision 96 counted every session in a holding state against the cap. On 2026-10-28
    six sessions awaiting review filled a cap of 6 while no window ran a turn: `pup fix`
    was refused twice, and every planned task waited behind `pup merge`, which runs one at
    a time, about 4 minutes each at a load of 28.
    *The count.* `pup launch`, `pup new` and a `pup fix` round count the project's sessions
    in a holding state other than `awaiting-review`: running, queued, rejected (a gate fix
    round on its way back to running), blocked, and a merged session back in a fix round,
    which is running. A state added later is counted, as `holdingStates` claims it by
    default. A session awaiting review counts too, unless its window is idle. A steer or a
    peer's message wakes an awaiting-review window without moving its state, and a worker
    can run `pup session done` and keep working in the same turn, so the state alone would
    let such windows run uncounted. Idle is read the way `pup status` reads it (decision 2,
    `classifySessionActivity`), from the last 256 KiB of the session's hook log, the line
    the read cuts into dropped. The log is opened without following a link and without
    blocking, and read only if it is a regular file, so a fifo planted there cannot hang a
    launch. A log that is missing, unreadable, not a regular file, or reads as anything but
    idle (working, on a background shell, on a permission ask, unknown) counts the session.
    `--over-cap` and the conductor's refusal of it are unchanged, and so is the 1.5 GB
    memory floor, which applies however many sessions await review.
    *The wording.* `SessionCapReachedError` reads `N sessions are working, at this project's
    cap of C (... sets it; sessions awaiting review do not count once idle)`. The
    conductor's kickoff says `pup launch` is refused once C sessions are working,
    `awaiting-review` ones not counted once idle, and its protocol keeps C sessions live and
    working, idle `awaiting-review` ones not counted, so it fills a place a session leaves
    for review.
    *Ceilings.* Sessions idle in review are bounded by the memory floor alone, and the floor
    sees less of them than it seems: on macOS the available figure counts inactive pages,
    so part of an idle window's memory reads as free and comes back when the window wakes.
    A session that comes back from review is counted from then on but is never refused:
    the gate's rejection (awaiting-review to rejected to running) and a steer both wake it
    whatever the count, so the working count can pass the cap by as many sessions as were
    in review, and launches then wait until it falls below. Refusing a rejection at the cap
    would strand the gate's report with nobody to fix it. A steered window counts only from
    its first hook event after the steer, and a session can write its own log to read idle;
    the store is session-writable, as decision 96 says of the cap file.
    *Tests.* With a cap of 2, two sessions idle in review and one running, a launch goes
    ahead; two running sessions refuse it with the cap error, and so does one running and
    two in review when one's log shows a steered turn, a turn still going past its done, or a
    permission ask. A missing log and a fifo at the log's path count, without blocking. A
    log over 1 MiB ending on a turn end reads idle. Under 1.5 GB a launch is refused with
    sessions in review and none working. The cap error and the conductor's kickoff say that
    sessions awaiting review do not count once idle. Each counting test fails when every
    session in review reads idle.
