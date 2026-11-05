# 0061. `pup ui --all` is the fleet on one screen, and every key acts through its row's own project (2026-09-21)

- Status: accepted

61. **`pup ui --all` is the fleet on one screen, and every key acts through its row's own
    project (2026-09-21).** Decision 60 gave the operator a fleet reading they could print but
    not act on: seeing a blocked session in another project meant leaving the dashboard,
    typing `--project`, and opening a second one. Now `pup ui` resolves the way `pup status`
    does. Outside any repo, or with `--all` from anywhere, it reads every project
    `fleetProjects` lists into one table. Inside a repo without the flag, or with
    `--project <id>`, which wins over `--all`, it is the single-project dashboard it always
    was. Piped, it prints what `pup status` prints in the same place, so outside a repo that is
    the fleet view. Reading across stores is the second reader the addendum to decision 43
    allows, behind the same `refuseUnlessOperator` guard as `pup status --all`.
    *A reading is a list of projects, each with the store its rows write through.* `useSnapshot`
    now returns `{ projects: { deps, snapshot }[], unreadable: string[] }`. The single-project
    command builds a list of one, and its read still throws as it did, so nothing about that
    path degrades quietly. The App flattens the projects' live sessions and backlogs into one
    list of rows, and each row carries its `ProjectReading`. `useControls` takes those rows,
    not a snapshot and a deps, and every action is dispatched with `row.project.deps`: steer,
    interrupt, kill, unblock (and the reason it shows first), respawn, merge, launch. `c` and
    `A` use the highlighted row's project's conductor. With no row under the cursor they fall
    back to the only project if there is exactly one, so an empty single-project screen can
    still start its conductor, and on a fleet they refuse (`Whose conductor?`) rather than
    guess. The row, not the cwd and not the first project, is the only answer that cannot
    drive a fleet the operator is not looking at. Decision 52's corollary holds: each key still
    calls the one core function its command calls, only with the row's store.
    *The column is drawn only when it tells rows apart.* With more than one readable project,
    each session and planned row starts with the project id in a 14-character column,
    the header becomes one `<id>  <repo_path>  conductor running|down` line per project (no
    attach command, no baseline, both one `--project` away as in decision 60), and debt and
    radar are drawn once per project with each line led by its id, since ledger numbers and
    overlaps are per store. With one project, including `--all` over a fleet of one, the
    layout is the single-project layout exactly. The column shows the id rather than the
    repo's directory name. Two checkouts can share a basename, and the id is what `--project`
    takes and what the header pairs with each path. Rows stay grouped by project, each group
    in its snapshot's order. A global blocked-first sort would split a project's rows across
    the screen, and the project with the blocked row is already one header line away. Session
    ids are unique per store, not across a fleet, so row keys are `<project>/<id>`.
    *Stores are opened once and isolated per reading.* Each live project's store is opened
    when the dashboard mounts and held open for its lifetime, since the keys need a handle and
    reopening every two seconds would run the migrations each time. A project whose repo is
    gone is listed `missing: the repo no longer exists` and never opened, as in decision 60.
    A store that will not open is listed `unreadable: <reason>` once. A snapshot that throws is
    that reading's `unreadable` line, and the next reading tries again. Either way the other
    projects still render. The lines come from the same `fleetHeader` and `fleetRefusal` the
    fleet `pup status` prints, and the fleet header's repo path goes through `sanitizeReason`,
    since a foreign store's `projects` row is session-writable (decision 29). A project
    registered after the dashboard opened appears at the next `pup ui`.
    *Tests.* ink-testing-library frames: two projects draw the column on every session and
    planned row, the per-project header, and prefixed debt and radar lines. The same session
    id in both projects draws twice. One project, and one project beside an unreadable line,
    draw no column and the single-project header. A control character in a project's path is
    stripped. In controls.test.ts, with the second project's rows under the cursor, steer,
    interrupt, kill, unblock, launch, the conductor stop, merge and respawn are each asserted
    to be dispatched with the second project's deps, and the block reason and conductor attach
    with the second project's. A row of the first project still acts through the first, and
    the conductor keys refuse on an empty fleet. *The discriminating mutation:* replacing every
    `row.project.deps` with `projects[0].deps`, the first project and so the cwd's, and the
    row's project with `projects[0]`, fails ten of the twelve cross-project cases. The two that
    pass are the first-project row and the lone project, the cases where the first project is
    the right answer. In index.test.ts on temp stores: two projects outside a repo mount a
    reading whose deps hold each project's own repo path and open store (the second store
    finds its own session and not the first's). `--all` inside a repo reads both, and plain
    `pup ui` there reads one. `--project` wins over `--all`. A gone repo, a transcript that
    cannot be read, and a store `openStore` refuses (an `events` view that cannot be indexed)
    each become their line while the live project still reads. Piped, it prints the fleet
    block. A session outside every repo and the conductor are refused.
    *A project whose path is not its own is never opened.* The security review of the first
    cut found that the fleet turned a planted store into execution. `listRegisteredProjects`
    pins a store's directory only to the hash of whatever `repo_path` its row holds (decision
    43), and decision 43 gave that scan read rights only. A session can write
    `~/.pupitre/<hash of P>/state.db` where P is the operator's real repo path plus a trailing
    slash. That path exists and hashes differently, and the store holds backlog rows the
    session wrote. `pup ui --all` would list it as a near-twin of the real project, `l` would
    run `launchTask` there on the session's spec, and `c` would start a conductor there. So
    before a fleet reader opens a registered project, `fleetRefusal` in `src/cli/index.ts`
    requires `realpathSync(repo_path) === repo_path`. `pup status`'s `printFleet` and
    `pup ui`'s `fleetReader` both use it, so the piped `pup ui` is covered too. A trailing
    slash, a symlink or a `..` reads `<id>  <path>  not its own path: a variant of a repo
    path, never opened`, beside the gone repo's `missing` line, and the store stays shut. A
    real registration always holds the canonical path `git` resolved, so no honest project
    is turned away, unless it was registered through a path that has since become a symlink.
    That project's fleet line says so, and its own repo still works.
    *Every id the dashboard draws is scrubbed where the snapshot is built.* `pup ui` draws
    two foreign fields the fleet `pup status` never prints — the backlog task id (also
    quoted in the launch prompt) and the radar's two session ids — plus the overdue ledger
    id, which `pup status`'s fleet view prints too and was unsanitized there until now. The
    snapshot now passes all three through `sanitizeReason`, as it does a session row's id,
    state and branch. The ledger id becomes a string: pup's schema makes it an integer, but a
    planted store can create `ledger_entries` with a TEXT id before `openStore` runs, and
    `CREATE TABLE IF NOT EXISTS` keeps that table. The single-project header's repo path is
    sanitized too, since `--project <id>` can name a planted store. Tests: a store keyed to the
    real repo path plus a slash is listed and left holding only its `projects` table, in
    `pup status` outside a repo, in the piped `pup ui --all` and in the dashboard's reading. A
    snapshot over a store with a planted TEXT-id ledger, a task id and overlap ids carrying an
    escape comes out scrubbed; removing each of the three new scrubs fails that test, and
    accepting any path in `fleetRefusal` fails the planted-path test. The header strips an
    escape from its path.
    *Ceilings.* A separate repo that a session can write to, at a canonical path of its own,
    can still be registered and is opened like any other project. The check belongs in
    `listRegisteredProjects`, so that every reader of `~/.pupitre` inherits it. That move is
    out of this task's scope and is a follow-up task the operator will plan. The first
    project's fall-back for `c` and `A` is by count, not by cwd. Inside a
    repo with `--all`, an empty cursor on a fleet refuses even though the cwd names a project,
    because the point is that the keys never read the cwd. Dormant projects (task t-mu6vjmba)
    will be skipped here as in the fleet `pup status` when that task lands.
