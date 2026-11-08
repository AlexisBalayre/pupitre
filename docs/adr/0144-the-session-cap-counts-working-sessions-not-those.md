# 0144. The session cap counts working sessions, not those awaiting review (2026-11-07)

- Status: accepted
- Amends: [0096](0096-test-runs-queue-for-a-few-machine-wide.md)

144. **The session cap counts working sessions, not those awaiting review (2026-11-07).**
    Amends decision 96, which counted every session in a holding state against the cap. A
    session awaiting review has run `pup session done`: its window sits idle while the gate
    and a human look at its branch, and it costs memory, not turns. On 2026-11-07 two
    awaiting-review sessions and an idle one waiting on a re-gate filled a cap of 6 and
    blocked three planned launches.
    *The count.* `pup launch`, `pup new` and a `pup fix` round count the project's sessions in a
    holding state other than `awaiting-review`: running, queued (about to run), rejected (the
    gate's report on its way back to running), blocked (a human sends it back to running), and
    a merged session back in a fix round, which is running. A state added later is counted, as
    `holdingStates` claims it by default. The state is the whole test: no hook log or window
    is read, which keeps the count as cheap and as safe to compute as decision 96's.
    *Unchanged.* The 1.5 GB memory floor applies however many sessions await review: it is what
    an idle window really costs, so it is the limit that bounds them. `--over-cap` still lifts
    the cap for the operator alone, and the conductor passing it is still refused.
    *The wording.* `SessionCapReachedError` reads `N sessions are working, at this project's cap
    of C (... sets it; sessions awaiting review do not count)`. The conductor's kickoff says
    `pup launch` is refused once C sessions are working (running, blocked or in a fix round,
    `awaiting-review` ones not counted), and its protocol keeps C sessions live and working, so it fills
    the place a session leaves when it goes to review. `skills/pup/SKILL.md` says the same.
    *Ceilings.* A steer or a peer's message wakes an awaiting-review window without moving its
    state, and a worker can keep working in the turn that ran `pup session done`; such a window
    runs turns uncounted. Reading the hook log to tell idle from awake was weighed (the closed
    PR #200 did it) and not done: it adds a file read a session can shape to every launch, and
    what it guards against is brief, since a woken session either goes back through the gate or
    is rejected to running, where it is counted again. A rejection or a steer is never refused
    at the cap, so the working count can pass it by as many sessions as were in review, and
    launches then wait until it falls below. Refusing a rejection at the cap would strand the
    gate's report with nobody to fix it.
    *Tests.* With a cap of 2, two sessions awaiting review and one running, a launch goes ahead;
    two running sessions refuse it with the cap error, and so do one running and one blocked
    with two in review. Under 1.5 GB a launch is refused with only sessions in review. The cap
    error and the conductor's kickoff say that sessions awaiting review do not count.
