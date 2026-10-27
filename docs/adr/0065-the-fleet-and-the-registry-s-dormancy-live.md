# 0065. The fleet and the registry's dormancy live in `src/core`, and the canonical-path refusal is the registry's (2026-09-22)

- Status: accepted

65. **The fleet and the registry's dormancy live in `src/core`, and the canonical-path refusal
    is the registry's (2026-09-22).** Decisions 60–62 left their logic in `src/cli/index.ts`,
    and the gate flagged it: +16 decision points on #107 and +28 on #108, accepted as ledger
    #32–#35 against this lift. AGENTS.md says `src/cli` stays thin.
    *What moved.* `src/core/fleet.service.ts` owns the registry-to-snapshot pipeline:
    `readFleet` is `pup status`'s fleet and `fleetReading` is `pup ui --all`'s reading. Both
    drop dormant projects unless `--dormant` asks for them, refuse a gone or variant project
    without opening its store, and turn a store that will not open or snapshot into that
    project's line. `readFleet` closes each store before opening the next; `fleetReading` holds
    them open for the dashboard's life. `src/core/project.service.ts` owns `pup project`:
    `listProjects`, `putProjectToSleep` (the refusal naming the conductor and every holding
    session, and the dormant stamp) and `wakeProject`. Each returns the line to print or the
    refusal. The action in `index.ts` now only parses: the operator guard, the action name, an
    id given to `list`, and two different projects named. Core never imports `src/cli`, so the
    services take the registry rows as a parameter and `index.ts` passes `fleetProjects()` or
    `listRegisteredProjects()`. The fleet text needs the ui's session labels, so `sessionLine`
    and the new `fleetLines` sit in `src/cli/ui/dashboard-text.utils.ts`, next to the labels
    they print. `pup status` prints `fleetLines(readFleet(...))`. `fleetRefusal`,
    `fleetHeader`, `awakeFleet`, `fleetReader`, `printFleet`'s body and `sessionLine` are gone
    from `index.ts`. `openRegistered` is no longer exported, because `index.ts` was its only
    importer outside `project.utils.ts`.
    *The canonical-path check moved into `listRegisteredProjects`.* The scan resolves each row's
    `repo_path` once with `realpathSync`. `repoExists` means it resolved, and the new
    `isOwnPath` means it resolved to itself. `openRegistered` refuses a row that is not its own
    path with a `ProjectResolutionError`: `` Project <id> is registered at <path>, which is not
    its own path: a variant of a repo path, never opened. `` So `--project <planted-id>` gets
    the refusal the fleet readers have had since decision 61, and so does the auto-select of the
    only registered project. The check sits in `project.utils.ts` and not in the service because
    that file already reads the filesystem (`existsSync`, `readdirSync`) and opens stores.
    `realpathSync` adds no service, client or repository import. The row type,
    `RegisteredProject`, is owned by core and exported from `src/core/types/fleet.types.ts`
    beside the other fleet types, as the conventions place exported types; `fleet.service.ts`
    is the reader that consumes it. `listRegisteredProjects` in `src/cli` produces it and
    imports the type.
    `pup project list` marks such a row `(not its own path)`, next to `(missing)`, so a planted
    near-twin is no longer printed as a plain `active` line beside the real project. The path is now resolved once
    per scan, not a second time just before the read. A repo deleted in the milliseconds between
    the two inside one command has its store read as it was, since the store lives under
    `~/.pupitre` and not in the repo. The next scan marks it missing.
    *Ceilings.* The check proves that a path is canonical. It does not prove that the
    operator registered it. A wholly separate repo at its own canonical path, with a store under
    `~/.pupitre` keyed to that path, is still registerable and is listed and opened like any
    project. It is not a near-twin of the operator's repo, which is the case decision 61 closed.
    *Complexity*, measured by driving the TypeScript adapter's `complexity` capability (the
    function the gate's complexity stage calls) directly from a script, not through the gate:
    `src/cli/index.ts` has **317** decision points on main at c31fb7e and **288** on this branch
    (290 before the gate review asked for `printBaselineTail`, which `pup init` and `pup audit`
    now share for their report tail).
    The new `fleet.service.ts` and `project.service.ts` have 10 each.
    `dashboard-text.utils.ts` went from 19 to 28 and `project.utils.ts` from 19 to 23.
    *Tests.* `fleet.test.ts` and `project.test.ts` run on temp stores. `project-utils.test.ts`
    checks that the scan flags a variant and that `resolveProject` by id refuses it and leaves
    the planted store with its one `projects` table. `index.test.ts` gains
    `--project <planted-id> status`: refused in one line, nothing printed, and the store not
    migrated. No existing test in `index.test.ts`, `dashboard-components.test.ts` or
    `controls.test.ts` changed. The one existing assertion edited is the exact row shape in
    `project-utils.test.ts`, which gains `isOwnPath: true`.
    *The discriminating mutations*, each run against a backup copy and restored from it.
    Dropping `openRegistered`'s `isOwnPath` guard fails the new `--project` test and the
    `resolveProject` test. Dropping `fleetRefusal`'s `isOwnPath` line fails decision 61's
    existing `never opens a project whose path is a variant of a repo path` test in
    `index.test.ts` and two in `fleet.test.ts`. Passing `true` for `shouldShowDormant` in
    `index.ts`'s `readFleet` call fails decision 62's two existing fleet-view dormancy tests.
    Ledger #32, #33, #34 and #35 are closed by this task.
