# CLI surface

Binary: `pup`. Every command resolves its project through one rule (decision 43): `--project <id>`
wins from anywhere, even inside another repo; otherwise the repo around the current directory;
outside any repo, the store under `~/.pupitre` decides only when exactly one project is
registered — with several it lists them as `id  repo_path` (a deleted repo is marked `(missing)`)
and refuses until `--project <id>` picks one, with none it says so and points at `pup init`. A
project whose repo no longer exists on disk is reported, never used. Each refusal is one line,
exit 1.

## Global options

- `--project <id>` — control a registered project by id; the ids are the directory names under
  `~/.pupitre`, and `pup status` from outside any repo lists them when more than one exists.
  Operator-only, as is the store's auto-select outside a repo: a session reaches only the
  project around its cwd, whose store is where its guards live (decision 43).

## Lifecycle

- `pup init` — onboard a repo: detect stack, run audit, snapshot baseline, draft conventions, open
  review step (see 07-onboarding.md). Prints one `codegraph: <version>` or `codegraph: not
  installed` line beside the `sandbox:` one: an external binary detected like `gh` and `tmux`,
  never a dependency, and the difference between a fleet whose sessions query a code graph and
  one whose sessions grep (decision 51). Records `remote.origin.url` as the project's push
  target and prints it as `push target: <url>` on the next line — that recorded value is what
  `pup merge --pr` pushes to, and it refuses when the repo's config no longer says the same
  thing. The record is held back, with a finding, rather than written when the configured URL
  carries control characters or when sessions have already run for the project; `--origin-moved`
  is how the operator confirms one. A run from inside a session records nothing: naming the target is the operator's act
  (decision 56).
- `pup init --origin-moved` — record the push target from the repo's current
  `remote.origin.url` when pup will not do it on its own: origin legitimately moved (a rename, a
  fork promoted), or this is a first record on a project whose sessions have already had the
  shared config to write. The only way to move it. Operator-only, like `pup audit`: it is the
  value a session's merge is held to (decision 56).
- `pup plan add "<goal>" --scope <glob>...` — record a task with no session. `pup plan` lists the
  backlog; `pup plan drop <task>` removes one; `pup plan edit <task> [--goal|--scope|--accept]`
  rewrites one. A task is in the backlog until a session claims it (decision 40).
- `pup launch <task>` — compile a profile, create the worktree and branch, and start a session for
  a task already in the backlog. Refuses when the task's scope-in claims tracked files a live
  session's scope already claims, naming the session and the shared files; `--allow-overlap`
  launches anyway and records what it waved through (decision 41). Operator-only: refused when
  run from inside a session, like `pup new`, `pup plan add|drop|edit`, `pup merge` and
  `pup respawn` (decisions 26, 42, 44). The conductor may launch, plan, `new` and kill; only
  the operator merges, respawns, unblocks or reaches another project (decision 47).
- `pup new "<goal>" --scope <glob>...` — plan and launch in one step; the daily path. Takes
  `--allow-overlap` for the same reason `pup launch` does.
- `pup status` — all sessions by state, the backlog under `planned`, pending reviews, live scope
  overlaps between running sessions. A running session whose events file has gone quiet for
  ten minutes reads `STALLED (Nm)` (decision 35); when the radar's turn watchdog found an API
  error on its pane and typed the resume, the row reads
  `TURN DIED (API error) — resumed by watch at hh:mm` instead of the bare age, or
  `… resume refused at hh:mm, needs a human` when the paste could not land.
- `pup watch [--once|--start|--stop] [--interval <seconds>]` — the conflict radar: every fifteen
  seconds, scan the live sessions' diffs for same-file overlaps and print each `STALLED`
  session, then run the turn watchdog over the stalled ones — read each one's launch pane and,
  when the last transcript line is an `API Error` above an empty input box, record a `turn_died`
  event and steer the session back to work with a fixed resume message, once per stall. The
  conductor's window on its own socket gets the same reading and a one-line nudge. Prints one
  `TURN DIED` line per resume, with the refusal when the steer did not land; a line still
  `Retrying` is a live turn and is left alone. `--once` runs a single sweep and exits; `--start`
  runs it in a detached tmux session and `--stop` ends that; `--interval` changes the cadence.
  Operator-only, like `pup audit`: the sweep types into panes and records resumes in the
  watcher's name (addendum to decision 35).
- `pup ui` — the same reading as `pup status`, held open and redrawn every two seconds: the
  header (project, conductor, baseline figures), overdue debt, the live sessions with their
  activity marker, rejections, gate verdict, context reading and steer, the backlog beneath them,
  and the conflict radar. Merged and killed sessions are a count, not rows — the screen is for
  work someone can still change, and `pup status` is where the whole history is listed.
  Piped or redirected, it prints what `pup status` prints, once, and exits 0. Runs in the
  terminal's alternate screen, so quitting gives the scrollback back untouched (decision 52).

  The cursor moves with `↑`/`↓` over the session rows and the planned rows beneath them — one
  list, so an action always acts on the row it is on. Every key below runs the same core
  function the command of the same name runs, and its result lands in the status line at the
  bottom; the reading refreshes right after, so the row shows what just happened.

  | key | does | prompts |
  | --- | --- | --- |
  | `l` | `pup launch` on the planned row | the model, defaulting to the last one typed |
  | `s` | `pup steer` on the session row | the message; Enter sends, Esc cancels |
  | `i` | `pup interrupt` (Escape to the pane) | — |
  | `k` | `pup kill` | `y`/`n` |
  | `u` | `pup unblock`, on a blocked row only | the recorded block reason, then `y`/`n` |
  | `R` | `pup respawn`, with its wait on screen | — |
  | `a` | `tmux attach` on the row's window | — |
  | `A` | `tmux attach` on the conductor's window, socket included | — |
  | `c` | `pup conductor start`, or `stop` when one is up | both models, on a start |
  | `m` | `pup merge <session> --pr`, on an `awaiting-review` row | `y`/`n` |
  | `Enter` | open the detail pane on the row: goal, scope, acceptance, the last gate's stages, the last five events | — |
  | `Esc` | close the detail pane | — |
  | `r` | re-read now | — |
  | `q` | quit | — |

  `j`/`k` no longer move the cursor: `k` is the kill. `a` and `A` leave the alternate screen for
  as long as tmux holds it and return to the dashboard on detach. `m` runs as a child process
  and streams its stages into a log pane as the gate produces them, so a minutes-long gate is
  watched rather than waited on; `Enter` or `Esc` closes the pane afterwards. While an action is
  in flight the keys are deaf, so a second merge or a kill of the session a respawn is waiting
  on cannot be typed by accident.

  The detail pane takes the table's place while it is open and shows the row under the cursor, so
  `↑`/`↓` move it from row to row and every key above still acts on the row it shows. A planned
  row has a goal, a scope and acceptance criteria but no gate run and no events, and says so. An
  open prompt keeps `Esc` and a finished merge log keeps `Enter`, so neither changes meaning
  because the pane exists.

  Every one of those keys runs a command that is operator-only somewhere (decisions 42, 44, 47),
  so a session or the conductor gets the dashboard read-only: the mutating keys are unbound and
  hidden, the reason is on screen, and the cursor, the detail pane, `r` and `q` still work.
- `pup conductor [start|stop] [--model <m>] [--worker-model <m>]` — open (or close) the
  project's conductor: one Claude Code window in the main checkout that plans, launches,
  steers and kills sessions and hands each finished branch to the operator. It reaches a
  session by its peer name `pup-<id>` over Claude Code's cross-session messaging, edits
  nothing (a hook refuses every Edit and Write), and is refused `pup merge`, `pup respawn`,
  `pup unblock` and `--project`. Tasks it plans are recorded `origin = conductor`.
  `start` cuts a private detached checkout of the merge target under
  `~/.pupitre/<id>/conductor/checkout`, indexes it, and launches with `codegraph_explore` over
  that — so the conductor plans and reviews against tracked content of what has merged, never a
  working tree the sessions it supervises can write into. `start` also brings the conflict radar
  up when none is running, and says so: the radar hosts the turn watchdog, and the conductor's
  own waiting turn is what the watchdog nudges back after a sleep or an outage (addendum to
  decision 35). `stop` leaves the checkout and the radar in place. Operator-only (decision 47).
- `pup steer <session> "<message>"` — inject a correction into a running session. `--sent`
  records a steer already delivered by cross-session message and types nothing (decision 47).
- `pup interrupt <session> ["<message>"]` — abort the in-flight tool call (Escape to the pane), optionally steering a message after; the hung-tool escape hatch steer cannot reach (decision 37).
- `pup kill <session> [--respawn]` — stop; `--respawn` relaunches on a fresh context window. A
  killed session's task returns to the backlog, so `pup launch` can retry it. Operator-only for
  the same reason `pup launch` is: killing releases the holder's scope (decision 42).
- `pup unblock <session> [--reason <text>]` — return a session decision 7 parked as `blocked` to
  `running`, once the human it asked for has dealt with the block. Prints the reason the gate
  recorded for the block first, so unblocking is a claim that *that* was addressed. Allowed only
  from `blocked`; it resets nothing else — the reject count stays, so a session parked by the cap
  is parked again by its next gate failure — and it leaves the window alone: steer it with
  `pup steer`, and if the window is gone use `pup kill --respawn`, which takes it now that it is
  running again. Operator-only, and refused to the conductor too: the parking exists to ask a
  human, and the conductor is what the blocked session was working for (decisions 7, 42, 47).
- `pup respawn <session> [--wait <seconds>]` — ask the session for a handoff, wait for its
  `handoff-done`, then relaunch it on a fresh context window with the handoff as kickoff
  (decision 18). A handoff nobody requested does not count as ready. Operator-only: the kickoff
  quotes the handoff file, context a session could author for another (decision 44).

## Review and merge

- `pup review` — the queue: pending branches ordered by risk score, each with generated diff summary, gate results, debt delta.
- `pup review <session>` — full detail for one branch.
- `pup merge <session>` — run the gate pipeline; on pass, merge and write knowledge layer in the same transaction; on fail, move to rejected and inject the report. Operator-only, `--pr` included: the verdict moves another session's branch (decisions 26, 44).
  `--pr` pushes to the URL `pup init` recorded, from a git dir that reads no shared config
  (decision 54), and refuses before running a single stage — naming both values, having pushed
  nothing — when the repo's `remote.origin.url` no longer matches the record, or when no push
  target was ever recorded (decision 56).
- `pup merge <session> --accept-debt "<reason>" --review-by "<condition>"` — merge despite a flagged shortcut, creating a ledger entry.

## Session protocol

Run by the agent, never by the operator. Each takes its session from `PUP_SESSION_ID` and is
refused unless cwd is inside that session's own worktree — the repo root and another session's
worktree both refuse — so a session reports only its own state (decision 44).

- `pup session done "<summary>"` — acceptance criteria met and all work committed; moves the
  session to `awaiting-review` (decision 3).
- `pup session handoff-done` — the handoff `pup respawn` asked for is written (decision 18).

## Knowledge

- `pup map [module]` — code map: text tree by default, `--open` renders the interactive mind-map view.
- `pup report [--open]` — render the project report into the project dir: `report.html` (the backlog of planned tasks, sessions newest first with the goal that launched them, baseline drift from capture history, open debt, decision records) plus one `session-<id>.html` dossier per session — the full intent with acceptance criteria, the complete event timeline with every gate run, what merged (files and PR), and the session's decision records. The index links each session to its dossier. `--open` also launches the index in the browser (best-effort).
- `pup debt` — open ledger entries, oldest first, with review-by conditions.
- `pup log [module]` — decision records, filterable by module or file.

## Configuration

- `pup profile list | show <name> | edit <name>` — manage base and role layers.
- `pup profile stale` — running sessions whose profile version is behind current.
- `pup audit` — re-run the baseline stages and report drift against the stored baseline,
  refreshing it. Prints the same `codegraph:` and `push target:` lines `pup init` does, so both
  are reported on the repeat path too and not only the first run. Operator-only: outside a merge this is the only thing that re-stamps the
  debt baseline, and on a `--pr` repo it is the only thing at all, so a session running it
  from its worktree would choose when its own bar moves (decisions 26, 39, 48).
- `pup audit --sweep` — spawn a deletion-only session (dead code, unused deps) from the latest audit findings. Operator-only for the same reason `pup launch` is, on top of the baseline one (decision 42).

## Risk score (used by `pup review`)

Weighted sum of: diff size vs task size, scope violations logged, debt delta, hot-path or architectural-boundary files touched, overlap with another live session, coverage delta. High risk means deep human review; low risk means skim. A random sample of low-risk merges is periodically flagged for deep review to keep the gate honest.
