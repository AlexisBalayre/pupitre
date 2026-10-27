# 0062. A project can be put to sleep, and only the operator does it, only once nothing in it is live (2026-09-21)

- Status: accepted

62. **A project can be put to sleep, and only the operator does it, only once nothing in it is
    live (2026-09-21).** The multi-project design runs several projects at once, one conductor
    each, and the fleet views (decisions 60, 61) show every project ever registered, so a
    project the operator has parked for weeks is a block in every `pup status` and a group in
    every `pup ui`, and nothing said which projects were parked and which were simply quiet.
    Both decisions deferred `--dormant` to this task, and this closes that deferral. New:
    `pup project list | dormant [<id>] | wake [<id>]`. `list` prints one line per registered
    project, `<id>  <repo_path>  active|dormant since <when>  conductor running|stopped`, with
    `(missing)` when the repo is gone. `dormant` stamps a new nullable `projects.dormant_at`
    with the time; `wake` clears it. Fleet `pup status` and `pup ui` leave a dormant project
    out, and `--dormant` puts it back; the fleet `pup status` says how many it left out on a
    closing line, `N dormant projects not shown; --dormant shows them.` (`1 dormant project not
    shown; --dormant shows it.` for one), and a dormant project
    shown under `--dormant` ends its header with `dormant since <when>`. The radar's turn
    watchdog passes a dormant project over whole: no pane read, no resume, no conductor nudge.
    *Refused while anything is live, and each thing named.* A project put to sleep with work in
    flight would hide that work from every view that would have shown it needing the operator,
    which is the opposite of what the flag is for. So `dormant` refuses while the project's
    conductor window is up or any session is in a holding state — queued, running, awaiting
    review, rejected or blocked, `holdingStates()`, the same set that still holds a task's scope
    (decision 41) — and names the conductor's window and each session id, the way
    `pup brief edit` names what runs on the old brief, since each is something the operator
    stops by name. Once they are stopped (killed, merged, the conductor stopped), it succeeds.
    Merged and killed sessions do not count: nothing more happens to them.
    *One column, additive.* `dormant_at` is in `SCHEMA` and in `MIGRATIONS` as an `add`, like
    `origin_url` (decision 56), so a store created before it gains it on its next `openStore`
    and its project reads active. The registry scan that feeds `list`, decision 43's refusal
    and both fleet readers never migrates a store (decision 43), so it asks
    `table_info(projects)` first and reads a store without the column as active rather than as
    unreadable. That is what keeps a hidden project's store shut: whether a project is dormant
    is known from the read-only scan, before any reader would open it. The one writer in pup is
    `saveProjectDormantAt`, reached only from the operator's `pup project`; it is not the only
    writer on disk, since a session's shell can reach its own store (decision 57), which is why
    the value is coerced below.
    *Whatever type the column holds, it is read as a string.* A session can write a BLOB into
    its own project's row (`UPDATE projects SET dormant_at = X'1b5b324a'`); TEXT affinity keeps
    it, better-sqlite3 returns it as a `Uint8Array`, and `sanitizeReason`, which takes a
    string, threw on it in `pup status --dormant`, `pup project list` and decision 43's
    refusal. The registry scan now builds `dormantAt` with `String()` when it is not null, and
    `pup project dormant`'s `already dormant since` line, which reads through `getProject`,
    does the same, mirroring decision 61's `String()` for a planted TEXT ledger id. Such a
    project reads dormant, as any non-null stamp does, and its stamp prints as the bytes
    decoded as text and scrubbed. Tested with the escape `ESC [2J` as a BLOB: listed dormant
    with the escape stripped in `pup project list`, `pup status --dormant` and
    `pup project dormant`, none of them throwing.
    *Operator-only, `list` included.* A session that could set it could hide its own project
    from the operator's views and switch off the watchdog that resumes it; the conductor could
    put the project it runs to sleep. So all three are refused for a calling session and for
    the conductor, by `PUP_SESSION_ID` or `PUP_CONDUCTOR` alone first and then by the session's
    own store, through `refuseUnlessOperator` itself (decisions 27, 43), with the one
    refusal every other door prints. `list` is refused too: it reads every store under
    `~/.pupitre`, and only the two fleet readers were given that (addendum to decision 43).
    The project is the `<id>` argument, or `--project <id>`, or the repo around the current
    directory, through `resolveProject`, and two different ids refuse rather than pick one.
    `list --project <id>` prints that one project's line.
    *The refusal's listing is `list`'s, less one column.* Decision 43's refusal outside a repo
    with several registered projects whose repos are present printed its own `id  repo_path`
    lines. It now prints `registryLine` for each, the function `list` prints through, so the
    two cannot drift, and the operator choosing a `--project` sees which projects are dormant.
    Whether a conductor is up is `list`'s column alone: `registryLine` lives in a util, which
    cannot call the tmux probe (`docs/conventions/naming.md`), so `list` passes the probe's
    answer in and the refusal, raised inside that util, prints without it — and does not spawn
    one tmux per registered project on the way to saying "pass `--project`". The refusal's
    guard is unchanged. Every field a store wrote — the repo path and the dormant stamp — goes
    through `sanitizeReason` (decision 29), since the store is foreign to whoever reads the
    registry. The dormant flag decides no path: `fleetRefusal`'s realpath check still runs on
    every project a reader would open.
    *Tests,* on temp stores under a stubbed HOME. `dormant` refuses naming the conductor, a
    running session and an awaiting-review one, then names only the awaiting-review one after
    the conductor stops and the running one is killed, and succeeds once it is merged. `wake`
    clears the stamp, and both say so when there is nothing to change. The id argument and
    `--project` both target a project from outside a repo, and two different ones refuse.
    `list` prints each project's state and conductor, and strips an escape from a planted
    stamp. Each of the three subcommands refuses a session in its worktree, a session outside
    every repo that exports `PUP_SESSION_ID`, and the conductor. A store created with the
    projects table as it was before the column opens, migrates, and keeps its row with a null
    stamp, and the registry scan reads a bare pre-column store as active without an error.
    Fleet `pup status` hides a dormant project and counts it, and shows it with `--dormant`;
    `pup ui` leaves it out of the reading and reads it with `--dormant`; the watchdog does
    nothing for a dormant project and resumes the session once it is woken. *The
    discriminating mutations:* showing every project in the fleet regardless of `dormant_at`,
    dropping the watchdog's dormant check, dropping the own-store half of the guard, counting
    only running sessions as live, and selecting `dormant_at` from a store without the column
    each fail at least one test.
    *Ceilings.* Nothing stops `pup launch` or `pup conductor start` in a dormant project: it
    stays dormant with a live session in it, and hidden from the fleet until `wake`. Refusing
    those is a small follow-up if the operator wants it. The radar's overlap scan still runs
    for a dormant project, since it types nothing and a dormant project has no live session to
    overlap unless one was launched after. A registry that is all dormant prints only the
    count line in the fleet `pup status` and an empty fleet in `pup ui`. A project whose repo
    is gone can be neither put to sleep nor woken: `resolveProject` refuses it in
    `openRegistered` before the row is reached, as it does for every command (decision 43).
    Kept as a ceiling rather than a special case here, because a gone repo is already listed
    missing and never opened by the fleet readers, so its dormancy changes nothing they show;
    the place to deal with a gone project's row is the `pup init --forget <id>` decision 43
    already names.
