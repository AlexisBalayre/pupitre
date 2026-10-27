# 0060. Outside a repo, `pup status` is the fleet: every project, what needs you in each (2026-09-21)

- Status: accepted

60. **Outside a repo, `pup status` is the fleet: every project, what needs you in each
    (2026-09-21).** The multi-project design (a stream is a project with its conductor
    running, one conductor per project) left the operator switching with `--project` and no
    way to see across the projects at once; `pup status` from `$HOME` answered "pass --project"
    on exactly the store it was meant to read. Now, outside any repo, or with `--all` from
    anywhere, it reads every project `listRegisteredProjects` finds and prints one block per
    project: the header `<id>  <repo_path>  conductor running|stopped`, then overdue debt, then
    only the session rows that wait on the operator — blocked, stalled (a dead turn is a stall,
    and reads `TURN DIED` as on the full table), awaiting review — and last one line of counts,
    `N running, N planned, N merged`. The full single-project table is one `--project <id>`
    away, and `--project` wins over `--all`, since naming a project is the narrower ask; inside
    a repo, plain `pup status` is unchanged.
    *Reused, not re-read.* Each block is `buildDashboardSnapshot` on that project's store,
    folded by `fleetSummary` — so the fleet, the full table and `pup ui` cannot disagree about
    what is stalled — and each store is closed before the next is opened. Rows print through
    the one `sessionLine` the full table uses. Awaiting-input is left out of the fold though
    the full table flags it: a permission ask answers itself or becomes a stall within
    minutes, and the fleet is read across projects, not watched. Awaiting review is in,
    because nothing moves there until a person merges. Running and merged are counted by
    state, so a stalled session is both a row and one of the running; planned is the backlog,
    which includes a killed session's task.
    *A missing repo is listed, its store never opened.* `openStore` lays the schema and
    migrations down, which would write to a store nobody can act on; the block is the header
    and `missing: the repo no longer exists`. An empty registry refuses in one line pointing at
    `pup init`, as before, but without "Not inside a git repository", which `--all` from inside
    one would make false. Outside a repo with a single project the fleet is still what prints —
    one block, not the full table — so the output outside a repo does not change shape with the
    number of projects.
    *Every store is foreign, so each is sanitized and isolated.* The fleet opens stores the
    operator never pointed at, and `~/.pupitre` is reachable by a session, so the snapshot now
    passes a session row's `id` and `branch` through `sanitizeReason` like its other stored
    text (decision 29; `pup report` already did), leaving `state`, which is checked on write. A
    store that fails to open, migrate or snapshot — a torn row, an unreadable transcript —
    prints `<id>  <repo_path>  unreadable: <reason>` and the fleet moves on to the next
    project, as `listRegisteredProjects` degrades an unreadable store rather than failing.
    *Operator-only, and status only for now.* The addendum to decision 43 records why only
    the two readers may cross stores: `pup status` now, `pup ui` with the next task, which
    adds `pup ui --all`. The
    attach command is not in the header: it is one `--project` away, on the full table.
    *Dormant projects* are hidden unless `--dormant` is given, per the multi-project design
    the backlog carries as task t-mu6vjmba (dormancy and `pup project`); no project can be
    dormant yet, so the flag lands with that task rather than as a no-op option here.
    *Tests,* on temp stores under a stubbed HOME: two projects print their blocks with the
    need-you rows, debt and counts; `--all` inside a repo prints what outside prints while plain
    `pup status` there prints its own table; a gone repo whose bare store holds only its
    `projects` row is listed missing and still holds only that table afterwards; a session and
    a session that left every repo and the conductor are refused; a control character in a
    branch is stripped from the row; a store whose transcript cannot be read reads unreadable
    while the next project still prints; and `plan` outside a repo with two projects still
    refuses with the listing.
