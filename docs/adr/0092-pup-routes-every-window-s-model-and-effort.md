# 0092. pup routes every window's model and effort by its task's tier, climbs an explicit ladder one rung per failure, and never chooses Fable (2026-10-17)

- Status: accepted
- Amended by: [0090](0090-pup-fix-session-hands-the-ci-review-s.md)

92. **pup routes every window's model and effort by its task's tier, climbs an explicit ladder one
    rung per failure, and never chooses Fable (2026-10-17).**
    Every worker ran on whatever model the launch named and on the operator's own effort setting,
    so a docs task cost what a gate change cost, and a task that kept failing ran again on the same
    model at the same effort. Each task now has a tier. One pure rule in `routing.utils.ts` makes a
    task critical when any scope-in glob can name a file in the gate, git, tmux, the store, the
    sandbox, hooks or profile compilation: `src/core/merge-gate*`, `src/core/land*`,
    `src/core/regate*`, `src/core/sandbox*`, `src/core/profile-compiler*`,
    `src/core/*.repository.ts`, `src/core/db.client.ts`, `src/core/migrations/**`,
    `src/claude/**`, `src/core/git*`, `.claude/hooks/**` and `.github/**`. Anything else is
    standard. "Can name" is decided on the globs, not on paths the task means to touch: two globs
    intersect when one path can match both, so `src/**` and `src/core/*.ts` are critical, since
    the scope hook lets the session edit anything its glob matches. `pup plan add|edit --tier
    critical|standard` overrides the rule and is stored on the task (`tasks.tier`), and `pup plan`
    lists each task's tier, marking with `*` the ones `--tier` set.
    Each tier has a ladder, written once in `src/claude/model-ladder.constants.ts`. Standard runs
    `claude-sonnet-5-5 medium` → `claude-sonnet-5-5 high` → `claude-opus-5-5 high` →
    `claude-opus-5-5 xhigh`, and critical runs `claude-opus-5-5 high` → `claude-opus-5-5 xhigh`.
    The Sonnet rungs add `--fallback-model claude-opus-5-5`. Every window's argv carries both
    `--model` and `--effort`, so the operator's settings never decide a worker's effort.
    A window climbs exactly one rung on a relaunch of its task, or a respawn of its session
    (`pup respawn`, `pup kill --respawn`), after the window it replaces ran into a gate
    rejection, a CI fix round (a re-gate from `merged` to `merged`, decision 86), a dead turn
    (`turn_died`), or a stall. A stall is measured as the stall bar measures one (decision 35): on
    a respawn, the events file has been quiet ten minutes now; on a relaunch, it had been quiet
    ten minutes when a kill from `running` was recorded. A kill from any other state, or of a busy
    window, is no failure. A window's failures count only from its newest `respawn` event, so one
    rejection climbs one rung once. A block wins over every failure: a task the gate parked as
    blocked goes to the operator, and a relaunch or respawn after it stays on its rung. Today a
    merged task is claimed, so nothing relaunches after a CI fix round; the rule counts it for
    when `pup fix` launches a worker for the round (decision 90).
    The session row records where its window stands: `tier`, `rung`, `model`, `effort`,
    `rung_reason` (why the rung last climbed, carried up while it does not climb again) and
    `route_override`. These are additive columns, so a session launched before routing reads as
    no route, and the window that replaces it starts on the bottom rung of its task's tier, as a
    task re-tiered since its last window does. The respawn event's payload is unchanged.
    `pup status`, `pup ui` (row and detail pane) and the web dashboard (decision 91) all read the
    route off the snapshot, scrubbed like the rest of the row, as `claude-opus-5-5 high, rung 3/4
    after gate-rejection`, with `(override)` when the operator chose.
    A failure on the top rung climbs nowhere. The next launch or respawn is refused with
    `TopRungReachedError`, before any window is touched: a respawn leaves the old window running
    and its handoff on disk. A killed session that is the newest of its task, and hit a failure on
    its top rung, is listed under Needs you as `top-rung`, between `blocked` and `stalled`, its
    answer `re-plan <task>, or pup launch <task> --model <model> --effort <effort>`. A refused
    respawn of a live session prints to the operator who ran it. An explicit `--model` or
    `--effort` on `pup new`, `pup launch`, `pup respawn` or `pup kill --respawn` (refused on a
    plain kill, which opens no window) is honoured over the rung's, is recorded as an override,
    and lifts the top-rung refusal, since the operator has decided. A session launched with an
    override keeps its recorded model and effort on later respawns while its rung still climbs
    underneath, unless new ones are named. The row records the pair, not which half was named.
    The conductor starts on `claude-opus-5-5` at `high`; `pup conductor start --model` and the
    new `--effort` override it, and `--worker-model` overrides every session's model, which each
    launch records as an override. Its kickoff gains a Models section. It names the tier rule
    with every area, `--tier`, both ladders, the climb triggers and that a blocked task never
    climbs, says to launch with plain `pup launch <task>`, and hands a top-rung refusal to the
    operator, never to a retry. It also orders a security review before `pup merge --pr` on any
    session whose diff touches the gate, git, tmux or the store: a subagent spawned with the Agent
    tool at `effort: "xhigh"` over the worktree's `main...HEAD` diff, run with lazy fetch off, every
    transport pinned off by name, no pager, no diff driver, no replace refs, `--text`, `--no-relative` and every submodule shown,
    between `refs/heads/<target>` and `refs/heads/pup/<session-id>` (decision 80), since the
    session writes the shared git config, attributes and tags and can move its worktree HEAD. `runUtility`
    runs `claude-haiku-5-5` at `low`. pup never chooses a Fable model or `--effort max`. Neither
    is on a ladder, the conductor's route or the utility's, and an operator who names one gets it
    as a recorded override.
    Tests: the tier rule makes every critical area critical, including through `src/**` and
    `**/*.ts`, and leaves UI, docs and CLI-wording scopes standard. The glob intersection never
    misses an overlap a sample path witnesses. `plan add` hands `--tier` to the planner, `plan
    edit` stores it, and both refuse any other word; `pup plan` lists the tier with its marker.
    Each rung's argv is exactly its model, effort and fallback, and no rung, the conductor or the
    utility carries a Fable model or `max`. A relaunch after a rejection, a dead turn and a stall
    at the kill each climb once and record the reason. A busy kill, a kill from awaiting-review
    and a block do not climb. A respawn climbs after a rejection, once only after a dead turn, and
    after a stall on a hard respawn. A top-rung respawn is refused with the window untouched, and
    an override named now passes the top; a kept one, or the conductor's `--worker-model`, never
    does, because only the operator decides a top-rung case. A pre-routing session respawns on
    the first standard rung. The inbox orders `top-rung` after `blocked` and builds no command
    around a task id outside the minted shape. The three surfaces show model, effort, rung and
    reason. The conductor defaults to Opus 5.5 at high and takes `--effort`. The kickoff names the
    areas, the ladders and the xhigh security-review subagent, and `runUtility`'s argv carries
    Haiku at low.
