# 0197. Launches follow the merge lock's backlog and the machine's load, not a fixed session cap (2026-11-17)

- Status: accepted
- Amends: [0096](0096-test-runs-queue-for-a-few-machine-wide.md), [0144](0144-the-session-cap-counts-working-sessions-not-those.md)

197. **Launches follow the merge lock's backlog and the machine's load, not a fixed session cap (2026-11-17).**
    Amends decision 96, whose cap was a fixed count of sessions (`pup conductor start
    --max-sessions`, default 4), and decision 144, which narrowed that count to working sessions;
    its rule that a session awaiting review is not counted is kept.
    *What was measured.* Over the 7 days to 2026-11-16, 73 sessions took the merge lock for 126
    pinned gates and 135 lands, plus refused attempts, each holding it about 6 to 7 minutes of
    tests. The lock, not the number of windows, is what sessions queue on. On an 8-core machine a
    land's timing test failed at a load average of 37. A count of sessions sees neither: four
    sessions can each be a round away from the lock or all queued on it, and the operator kept a
    rule by hand beside the cap (under 5 open PRs, 2 workers running).
    *The decision.* `pup launch` and `pup new` refuse, before anything is written, while either of
    two signals is past its limit. A value equal to its limit is allowed.
    1. *The merge lock's backlog, in minutes.* Every session of the project is counted for the
       lock uses it still needs. A working session (a holding state other than awaiting review:
       queued, running, rejected, blocked, or a merged one back in a fix round) needs 2, its gate
       and its land. A session awaiting review needs none, as decision 144 counts it: it has run
       `pup session done`, costs memory, not turns, and its gate is under way or queued. A
       merged session whose newest `merge`, `landed`, `retired` or `pr_closed` event is a `merge`
       with a PR URL, recorded in the last 2 days (`LAND_WINDOW_MS`), needs 1, its land. Any other
       needs none: a merge with no PR moved the target under the gate's own lock use, a killed
       session needs nothing, and a merge older than 2 days with no land recorded is taken as a PR
       merged in GitHub's UI or a land `pup land` never recorded. Without the window such a session
       counted forever: the live store held 247 merged sessions and 227 lands, about 20 stale merges
       and 160 minutes of backlog no lock use would ever drain. `pup status` names the sessions
       counted for a land, up to 8 and the rest counted, so the operator can land or close a stale
       one inside the window. The uses are multiplied by the median gate run, taken over the newest
       30 `gate_result` reports in the store that carry a time and are shaped like the gate's
       verdict, a move from awaiting review to merged or rejected, and held to 4 minutes
       (`GATE_FLOOR_MS`, half the untimed figure) at least and 60 (`GATE_CEILING_MS`) at most. A
       run's time is its longest stage, since the stages run alongside one another; at most the
       first 64 stages of a report are read, and a stage time that is not a finite, non-negative
       number is passed over, as the payload is session-writable. While no run is timed, a use
       counts as 8 minutes (`UNTIMED_GATE_MS`): the measured 6 to 7 rounded up. A launch
       reads the backlog without its own session, so with 3 working sessions it reads 48 minutes
       and goes ahead, and with 4 it reads 64 and is refused: the default budget stops at 4 fresh
       sessions, as decision 96's default cap did. At 7 minutes, 4 would read 56 and let a fifth
       through. The budget is `lockBacklogBudgetMinutes` in `.pupitre/project.yml`, a
       number of minutes above 0 and at most 1440, a day, default 60. Any other value throws,
       naming the key, rather than leave the default in force; a budget past a day would turn the
       signal off as surely as a forged report.
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
    *A fix round.* A `pup fix` round's recompile meets the memory floor and the load, not the
    backlog, where decision 96 held it to the cap. The round finishes a PR already in the backlog
    as its land: it drains the lock and adds no PR, so holding it back on the backlog would only
    delay the drain and leave a failing PR with nobody to fix it, as decision 144 said of a
    rejection. Its window and its gate add to the load as a launch's do, so it waits for the load
    as a launch does. The fix-round tests replace the load reading, as the launch tests do, so they
    do not depend on how busy the machine running them is.
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
    2. A blocked session is counted as if its gate and land were next, though a human may hold it
       for long; the budget then refuses launches the lock could take. A session awaiting review
       is not counted, though its gate and land are ahead: the backlog understates by 2 uses per
       session in review, which the gate's queue absorbs, as decision 144 accepted for the cap.
    3. Gate reports are written by code a session can reach (decisions 46 and 47 on the store): a
       sandboxed worker may write the store's database, and an unsandboxed one may run anything.
       The median is the 15th of the newest 30 timed runs, so 15 reports forged at 0 would have
       made it 0 and turned the backlog off, and 16 forged at 10^12 would have refused every
       launch. The median is held to 4 to 60 minutes (a median that is not finite reads as the
       untimed 8), so forged reports move the backlog within that range only: with 4 working
       sessions, 32 to 480 minutes, never 0, and at the floor the default budget still refuses a
       ninth fresh session. At the ceiling one working session reads 120 minutes, over the default
       budget, so every conductor launch is refused until real runs push the forged ones out of
       the newest 30 or the operator passes `--over-cap`; `pup status` shows the 60-minute gate
       that explains it. Only a report shaped like the gate's verdict is read, so a bare
       transition or a refusal is not timed, but the shape is as forgeable as the times. The
       reports are not sealed: a seal needs a key the gate can read and a session cannot, and a
       sandboxed worker reads all of `~/.pupitre` and an unsandboxed one whatever the gate's
       process can, so the signal stays a setting the conductor follows, not a boundary, as
       decision 96 says of the cap. A store writer can lower the uses themselves too: by moving
       sessions out of the counted states, which decision 96's and 144's counts were as open to,
       or by forging a `landed`, `retired` or `pr_closed` event, which drops a merged session's
       land, 1 use, for at most the 2 days it would have counted. What fails safe is kept so: a
       merge whose time does not parse is counted for its land, and a session id that is not
       plain letters, digits, `.`, `_` and `-` is counted in `pup status` as unnamed, never
       printed, so no escape sequence written to the store reaches the operator's terminal.
    4. Lands are timed as gates: the store records no land's time, and a land runs the same tests.
    5. The load average lags: a burst of launches is read a minute late, and a launch reads it
       before it adds its own load.
    6. A `~/.pupitre/<project>/conductor/max-sessions` file left by an earlier start is no longer
       read, and harmless.
    *Tests.* The backlog is read on an empty store at the untimed gate and the default budget;
    queued, running, rejected and blocked sessions count 2 and one awaiting review 0; a merged
    session with an open PR counts 1 and is named, a local merge 0, and one landed, retired or
    closed unmerged 0, while a re-gate after a land counts 1 again; a merge older than 2 days
    with no land counts 0; killed sessions and a merged one with no merge count 0. A run is timed by its longest
    stage, of at most 64 read, the median is taken over the newest 30, malformed payloads are
    passed over, only a report on a move from review to merged or rejected is timed, a median
    forged at 0, under the floor or at 10^12 is held to 4 or 60 minutes, and the project's budget
    is read; a merge whose time does not parse counts 1. `pup status` names up to 8 unlanded
    sessions, counts the rest, and counts an id carrying an escape as unnamed. The refusals' texts
    are pinned, and kept under 300 characters at extreme figures. In the lifecycle, a launch at
    the budget goes ahead and one over it is refused for the operator and the conductor; a fifth
    fresh session on an untimed store is refused; sessions awaiting review do not count; the
    budget is read from `project.yml`; a load above the cores is refused and one at the cores is
    not; the operator's `--over-cap` passes both signals and the conductor's never does; `pup new`
    is refused before its task is written; the memory floor holds; and a fix round goes ahead over
    the budget and is refused above the cores, worded as a round to run again, and on low
    memory.
    The project config reads the budget with its default and up to 1440, and refuses a string, 0,
    a negative, past 1440, infinity, NaN, a boolean and a list. The CLI prints both signals and
    the verdict in `pup status`, prints `Launch: unknown` on a malformed budget, refuses a launch
    with each error, and no longer takes `--max-sessions`.
