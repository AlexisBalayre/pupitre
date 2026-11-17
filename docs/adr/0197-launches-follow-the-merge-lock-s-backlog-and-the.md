# 0197. Launches follow the merge lock's backlog and the machine's load, not a fixed session cap (2026-11-17)

- Status: accepted
- Amends: [0096](0096-test-runs-queue-for-a-few-machine-wide.md), [0144](0144-the-session-cap-counts-working-sessions-not-those.md)

197. **Launches follow the merge lock's backlog and the machine's load, not a fixed session cap (2026-11-17).**
    Amends decision 96, whose cap was a fixed count of sessions (`pup conductor start
    --max-sessions`, default 4), and decision 144, which narrowed that count to working sessions.
    *What was measured.* Over the 7 days to 2026-11-16, 73 sessions took the merge lock for 126
    pinned gates and 135 lands, plus refused attempts, each holding it about 6 to 7 minutes of
    tests. The lock, not the number of windows, is what sessions queue on. On an 8-core machine a
    land's timing test failed at a load average of 37. A count of sessions sees neither: four
    sessions can each be a round away from the lock or all queued on it, and the operator kept a
    rule by hand beside the cap (under 5 open PRs, 2 workers running).
    *The decision.* `pup launch` and `pup new` refuse, before anything is written, while either of
    two signals is past its limit. A value equal to its limit is allowed.
    1. *The merge lock's backlog, in minutes.* Every session of the project is counted for the
       lock uses it still needs. A live session (a holding state: queued, running, awaiting review,
       rejected, blocked, or a merged one back in a fix round) needs 2, its gate and its land. A
       merged session whose newest `merge`, `landed`, `retired` or `pr_closed` event is a `merge`
       with a PR URL needs 1, its land. Any other needs none: a merge with no PR moved the target
       under the gate's own lock use, and a killed session needs nothing. The uses are multiplied by
       the median gate run, taken over the newest 30 `gate_result` reports in the store that carry
       a time. A run's time is its longest stage, since the stages run alongside one another; a
       stage time that is not a finite, non-negative number is passed over, as the payload is
       session-writable. While no run is timed, a use counts as 8 minutes (`UNTIMED_GATE_MS`): the
       measured 6 to 7 rounded up. A launch reads the backlog without its own session, so with 3
       live sessions it reads 48 minutes and goes ahead, and with 4 it reads 64 and is refused: the
       default budget stops at 4 fresh sessions, as decision 96's default cap did. At 7 minutes, 4
       would read 56 and let a fifth through. The budget is `lockBacklogBudgetMinutes` in `.pupitre/project.yml`, a
       number of minutes above 0, default 60. Any other value throws, naming the key, rather than
       leave the default in force.
    2. *The machine's load.* The 1-minute load average (`os.loadavg()[0]`, 0 on a platform with
       none) against `os.availableParallelism()`, the figure the gate's own wait for load uses,
       rather than `os.cpus().length`, which can count cores the process may not run on. No
       dependency was added.
    *The refusals.* Each names its signal, its value and its limit, the backlog first when both
    are past: `The merge lock's backlog is 80 minutes, over the project's budget of 60 (10 gates
    and lands to go at 8 minutes each, no gate timed yet); nothing was launched.` followed by where
    the budget is set, and `The machine's 1-minute load average is 9.5, above its 8 cores; nothing
    was launched.` The CLI prints a refusal clipped at 300 characters (`sanitizeReason`), so the
    wording stays under it at any figure, which a test holds it to.
    *Unchanged.* `--over-cap` lifts both signals for the operator alone; the conductor passing it is
    refused at the CLI, and a launch made through the conductor ignores it, as in decision 96. The
    1.5 GB memory floor is never lifted. The plan's usage hold (decision 156) and `--over-limit`
    are untouched.
    *A fix round.* A `pup fix` round's recompile meets the memory floor only, neither signal,
    where decision 96 held it to the cap. The round finishes a PR already in the backlog as its
    land: it drains the lock and adds no PR, so holding it back would only delay the drain and
    leave a failing PR with nobody to fix it, as decision 144 said of a rejection. A first version
    held the round to the load too; on this machine, whose load sat at 20 to 25 on 8 cores while
    it was tested, that refused every fix round the test suite starts, which shows how often a
    finished PR would have waited.
    *`pup status`.* For a single project it prints, after the dashboard, `Launch: allowed` or
    `Launch: refused (merge-lock backlog over budget, load above the cores); only the operator's
    --over-cap goes beyond`, then `merge-lock backlog: X of Y minutes (<uses> gates and lands to go
    at <gate> minutes, …)` and `load: L of C cores`. A budget that cannot be read prints `Launch:
    unknown,` and why. The fleet view prints none.
    *The conductor.* `--max-sessions` is removed, and no cap file is written. The kickoff says a
    launch is refused while the backlog is over the project's budget or the load above the cores,
    and its protocol launches one planned task whenever `pup status` says a launch would be
    allowed, then reads `pup status` again before the next. The start line says launches follow
    both signals. `skills/pup/SKILL.md` says the same.
    *Ceilings.*
    1. A local-mode merge is counted as a gate and a land until it merges, though it takes the lock
       once; the backlog overstates such a project by one use per live session.
    2. A blocked or awaiting-review session is counted as if its gate and land were next, though a
       human may hold it for long; the budget then refuses launches the lock could take.
    3. Gate reports are written by code a session can reach (decisions 46 and 47 on the store), so
       a session can skew the median. The stage times are bounded only to finite, non-negative
       numbers.
    4. Lands are timed as gates: the store records no land's time, and a land runs the same tests.
    5. The load average lags: a burst of launches is read a minute late, and a launch reads it
       before it adds its own load.
    6. A `~/.pupitre/<project>/conductor/max-sessions` file left by an earlier start is no longer
       read, and harmless.
    *Tests.* The backlog is read on an empty store at the untimed gate and the default budget;
    queued, running, awaiting-review, rejected and blocked sessions count 2; a merged session with
    an open PR counts 1, a local merge 0, and one landed, retired or closed unmerged 0, while a
    re-gate after a land counts 1 again; killed sessions and a merged one with no merge count 0.
    A run is timed by its longest stage, the median is taken over the newest 30, malformed
    payloads are passed over, and the project's budget is read. The refusals' texts are pinned,
    and kept under 300 characters at extreme figures. In the lifecycle, a launch at the budget
    goes ahead and one over it is refused for the operator and the conductor; a fifth fresh session
    on an untimed store is refused; the budget is read from `project.yml`; a load above the cores
    is refused and one at the cores is not; the operator's `--over-cap` passes both signals and the
    conductor's never does; `pup new` is refused before its task is written; the memory floor
    holds; and a fix round goes ahead over the budget without reading the load, and is refused on
    low memory.
    The project config reads the budget with its default and refuses a string, 0, a negative,
    infinity, NaN, a boolean and a list. The CLI prints both signals and the verdict in
    `pup status`, prints `Launch: unknown` on a malformed budget, refuses a launch with each error,
    and no longer takes `--max-sessions`.
