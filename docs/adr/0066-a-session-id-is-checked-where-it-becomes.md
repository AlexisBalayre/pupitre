# 0066. A session id is checked where it becomes a path, and the fleet readers skip a row whose id is not one (2026-09-23)

- Status: accepted

66. **A session id is checked where it becomes a path, and the fleet readers skip a row whose
    id is not one (2026-09-23).** #106's CI review named this pre-existing and widened by the
    fleet views: `projectPaths(repo).sessionDir(id)` joined a store's `sessions.id` straight
    into `<store>/sessions/<id>`, and `compiledDir`, `eventsFile` and `handoffFile` build on it.
    A session writes its own store, and since decisions 60–62 `pup status`, `pup ui` and the
    turn watchdog read *every* registered project's store — so a row with `id = '../../marker'`
    had the operator's own process stat and read a file two levels above that project's sessions
    directory. Nothing sanitized an id as a path fragment; `dossierFileName` had solved the same
    problem for the report's file names with a closed allowlist (decision 51), and the compiled
    bash-recheck hook applies the same class to `tool_use_id` (decision 63).
    *One pattern.* `SESSION_ID_PATTERN` — `/^[A-Za-z0-9_-]{1,64}$/` — is exported from
    `src/core/paths.constants.ts`, the rule the readers, the watchdog and `sessionFragment` all
    share. `dossierFileName` now tests against it instead of its own
    copy of the same regex; its tests are unchanged. A closed allowlist, not a `..` check:
    separators and dots are not in the charset at all, so no combination of them composes into
    an escape.
    *The throw.* `projectPaths`'s `sessionDir` puts the id through `sessionFragment`, which
    throws `Session id "<id>" is not a usable path fragment`, followed by the charset it had to
    be in. The id in that message goes through `sanitizeReason` first: it is store-written text
    on its way to an operator's terminal (decision 29). `compiledDir`,
    `eventsFile` and `handoffFile` all compose `sessionDir`, so one check covers the four, and
    no caller can build a path outside `sessionsDir` without going through it. The check lives
    there and nowhere else — `sessionsDir` is the only place in `src` that joins `'sessions'`.
    *The readers skip instead.* `dashboard.service.ts`'s `eventsFileOf` returns the events file
    for a row whose id passes and nothing for one that fails, and both readers that sweep every
    row of a store take it: `buildDashboardSnapshot` hands it to `dashboardSession`, which
    already handles a session with no events file, and `findStalledSessions` skips the row
    before `existsSync`. So the snapshot touches the filesystem for such a row not at all — no
    activity, never stalled, `needsHuman` false — and the row still renders with its id
    sanitized, as decision 61 leaves it, because dropping a session over the shape of its id
    would hide it from the operator who has to clean it up. `sweepDeadTurns` asks
    `findStalledSessions` which sessions are stalled, so the turn watchdog skips the row with
    no change of its own: it never reads the pane and never types a resume.
    *Every other caller, and why the throw is right there.* `session-lifecycle.service.ts`'s
    `startSession` calls `compiledDir` and `eventsFile` on the id it has just minted with
    `sessionSlug` (`[^a-zA-Z0-9]+` → `-`, capped at 24 characters, plus a counter suffix), so
    the id is pup's own and always passes. The throw is still the right behaviour: a slug that
    failed would mean the minting broke, and the launch would otherwise write a compiled profile
    and point a session's hooks outside the sessions directory. It also closes one real hole —
    a task id that is itself the empty string slugs to the empty string too (a run of
    non-alphanumeric characters instead collapses to a single `-`, which still passes the
    charset) — `sessionFragment` now refuses that case rather than letting `compiledDir` become
    the shared `<store>/sessions/compiled`. `session-handoff.service.ts`'s
    `requestHandoff`, `isHandoffReady`, `markHandoffReady`, `respawnSession` and
    `hardRespawnSession` call `handoffFile` and `compiledDir` on a store-read id: the operator
    typed it into `pup respawn <session>` or the agent's `PUP_SESSION_ID` carries it, and each
    resolves it to a row (`requireRunning`, or `getSession` before that) before any path is
    built. The throw is right there too, and for the opposite reason to the readers': each of
    those names one session and acts on it, so there is nothing to degrade to — a refusal naming
    the id is what the operator needs, and a respawn that silently did nothing would be worse
    than one that says why. Neither file is edited by this task. Nothing else in `src` calls the
    four builders; `profile-compiler.service.ts` receives the events path as a string the
    lifecycle already built.
    *Tests*, on temp stores with a throwaway `HOME`, as the suites around them already run.
    `paths-utils.test.ts` drives all four builders both ways and checks the refusal carries the
    id with its control characters stripped. `dashboard.test.ts` plants a marker events file
    where `'../../marker'` would land — aged an hour past the stall bar, holding a `PostToolUse`
    event that classifies — and asserts the row renders with no activity and no stall age, which
    is only true if nothing opened or stat'ed it. `turn-watchdog.test.ts` sweeps the same store
    with `deadTurnError` returning an API error and asserts nothing was typed and no `turn_died`
    was written.
    *The discriminating mutations*, each run against a backup copy and restored from it.
    Dropping `sessionFragment`'s `throw` fails 10 of the 16 `paths-utils.test.ts` cases.
    Dropping it *and* `eventsFileOf`'s test, so the readers follow the id, fails all three new
    reader tests — the dashboard one on `expected { kind: 'working' } to be undefined`, which is
    the planted marker read through the escaped path.
    *Ceilings.* The pattern bounds an id as a path fragment and nothing more: it does not say
    the id names a session pup launched. A store row whose id is a plausible slug still gets its
    events file read, which is the store's own trust boundary and not this decision's. The one
    store-controlled path these same readers still followed, `sessions.transcript_path`, is
    closed by decision 67.
