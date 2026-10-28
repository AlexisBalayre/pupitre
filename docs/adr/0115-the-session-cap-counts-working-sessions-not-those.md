# 0115. The session cap counts working sessions, not those awaiting review (2026-10-28).

- Status: accepted
- Amends: [0096](0096-test-runs-queue-for-a-few-machine-wide.md)

115. **The session cap counts working sessions, not those awaiting review (2026-10-28).**
    Decision 96 counted every session in a holding state against the cap. On 2026-10-28
    six sessions awaiting review filled a cap of 6 while no window ran a turn: `pup fix`
    was refused twice, and every planned task waited behind `pup merge`, which runs one at
    a time, about 4 minutes each at a load of 28.
    *The count.* `pup launch`, `pup new` and a `pup fix` round count the project's sessions
    in a holding state other than `awaiting-review`: running, queued, rejected (a gate fix
    round on its way back to running), blocked, and a merged session back in a fix round,
    which is running. A session awaiting review has finished its turns and waits on a gate
    run or a human; its window is idle, so it takes no CPU, and the memory it holds is what
    the 1.5 GB floor already measures. The floor is unchanged and applies however many
    sessions await review. A state added later is counted, as `holdingStates` claims it by
    default. `--over-cap` and the conductor's refusal of it are unchanged.
    *The wording.* `SessionCapReachedError` reads `N sessions are working, at this project's
    cap of C (... sets it; sessions awaiting review do not count)`. The conductor's kickoff
    says `pup launch` is refused once C sessions are working, `awaiting-review` ones not
    counted, and its protocol keeps C sessions live and working, `awaiting-review` ones
    not counted, so it fills a place a session leaves for review.
    *Ceiling.* Sessions awaiting review are not bounded by the cap, only by the memory
    floor, so a backlog of unmerged branches can grow past it; `pup status` still lists them.
    *Tests.* With a cap of 2, two sessions awaiting review and one running, a launch goes
    ahead; two running sessions refuse it with the cap error. Under 1.5 GB a launch is
    refused with sessions awaiting review and none working. The cap error and the
    conductor's kickoff say that sessions awaiting review do not count.
