# Resolved decisions (2026-07-22)

Outcome of the design review. Where this file contradicts 00–08, this file wins; folding the
changes back into those docs is pending.

## Runtime & control plane

1. **Sessions are interactive `claude` in tmux panes**, one per worktree. tmux is transport only
   (launch, steer via `paste-buffer`, kill, human attach). Headless mode is dropped for sessions.
2. **All session state comes from hooks and transcript JSONL**, never from pane contents.
   PostToolUse = activity, Notification = blocked on input, Stop = turn end. Hooks identify their
   session via a `PUP_SESSION_ID` env var injected at launch.
3. **Task completion is an explicit protocol**: the base profile requires the agent to run
   `pup session done "<summary>"` when acceptance criteria are met. The command refuses on a dirty
   worktree. A Stop without the done event means idle-awaiting-input, not done.
4. Steering cannot force-interrupt a mid-turn agent; steer messages queue until the turn ends.
   Accepted limitation.
18. **Context is optimized by handoff-respawn, not in-place compaction (2026-07-23).**
    `pup respawn <session>` steers the session to write a handoff document
    (`~/.pupitre/<project>/sessions/<id>/handoff.md`), waits for the explicit
    `pup session handoff-done` protocol signal, then relaunches `claude` in the same
    worktree/branch/session-id with compiled context + handoff as the kickoff. The session
    row is untouched — same session, fresh window. Rationale over `/compact`: the handoff is
    a Pupitre-owned, human-inspectable artifact that survives crashes, and the agent
    distills what matters rather than a lossy black-box summary. Context size is read from
    transcript JSONL usage fields (decision 2 — never pane scraping); `pup status` shows
    `ctx ~Nk` per running session and suggests a respawn above 120k tokens.

## Safety & enforcement

5. **Sessions run with permissions bypassed; compiled hooks are the enforcement layer.**
   Scope-in globs on Edit/Write; deny-patterns on Bash.
6. **Bash scope checking is best-effort**: a real shell parser denies clear write patterns
   (`>`, `>>`, `tee`, `sed -i`, `rm`/`mv`/`cp`, `git apply`…) whose resolved target is out of scope
   or inside `.claude/`. Unparseable commands pass. The authoritative backstop is the gate:
   diff-vs-scope is a hard fail, and a `.claude/` drift-hash mismatch is a hard fail.
7. **Rejection→re-steer is capped at 2.** A third gate failure parks the session as
   `blocked — needs human`, surfaced at the top of `pup status` with the failure history.
19. **Sessions do not load repo/local settings: `--setting-sources user` (2026-07-23).**
    Repo-committed ask-rules (e.g. `Bash(git rebase *)`) pierce bypass permissions, and
    `ask` outranks `allow` across settings scopes (both verified live on 2.1.218), so no
    compiled allow-rule can neutralize them — the only reliable fix is not loading the
    repo's `.claude/settings.json`/`settings.local.json` in sessions. Consistent with
    decision 5: compiled hooks + the gate are the session enforcement layer; repo
    settings target interactive humans. The compiled `--settings` file and the user's
    `~/.claude` still load; the repo's CLAUDE.md, agents, and skills ride along as
    before (they are not settings sources). Refines decision 10's "rides along
    untouched": the project layer's *settings* are exempt for sessions.

20. **Conflict radar is a tmux-supervised watcher daemon (2026-07-23).** `pup watch`
    scans on a 15s cadence: every live session's branch is merge-base-diffed against the
    target (identical to the gate and review queue), and pairs whose diffs touch the same
    file are stored as the current overlap set, replaced atomically each sweep. Overlap =
    same file actually changed, not scope-glob intersection (globs like `src/**` would
    flag every pair forever). `pup watch --start/--stop` run it detached under tmux —
    tmux is already pup's supervisor and makes the radar log attachable; a heartbeat row
    lets `pup status` mark overlaps `(stale)` and point at `pup watch --start` when the
    radar is off while 2+ sessions are live.

## Merge semantics

8. **Fresh-base gating**: the gate refuses branches that are stale vs main. **Pupitre auto-rebases
   mechanically**; only conflicts go back to the session as a re-steer ("rebase onto main and
   resolve"). Merges are serialized under a lock.

15. **Rebase-conflict re-steers count toward the reject cap.** One counter (`reject_count`)
    bounds every automatic re-steer path; after two, the third failure of any kind parks the
    session as `blocked`. Conflicts are not tracked separately.
16. **Merge is `--ff-only` with full cleanup.** After the auto-rebase the branch is a
    descendant of the target, so the merge fast-forwards (linear history). On pass:
    session → `merged`, tmux killed, worktree removed, branch deleted — everything is in main.
17. **Diff-size flag blocks unless `--accept-debt`.** The v1 soft stage follows stage-4
    semantics from 04-gates-and-debt: a flagged oversize diff refuses to merge unless
    `--accept-debt "<reason>" --review-by "<condition>"` is passed, which writes a ledger
    entry. Threshold is a tunable constant; lockfiles are excluded from the count.

## Config & profiles

9. **Sessions inherit the user's `~/.claude` (revised 2026-07-22, supersedes full
   `CLAUDE_CONFIG_DIR` isolation).** Rationale: an isolated config dir has no login state, and
   every workaround (setup-token, keychain replication) is programmatic access that plan policy
   could restrict — inheriting the normal interactive login makes a session indistinguishable
   from the user running `claude` in a terminal. Attributability is preserved by snapshotting
   and hashing the user config at session launch (drift is detected, not prevented); the
   profile hash covers compiled output + user-config snapshot hash.
10. **Compiled profile is delivered per session via `--settings <compiled.json>`** (hooks,
    permissions) **plus worktree-level files** (CLAUDE.md additions, agents, skills) kept out
    of diffs with per-worktree `.git/info/exclude`. A repo's committed `.claude/` rides along
    untouched as the project layer; the compiler reads it to count context budget and flag
    convention conflicts at init. The compiler never modifies tracked files.
11. **Gate-time Claude work runs as one-shot `claude -p` utilities** (reviewer pass, decision-record
    drafting, init audit): fixed prompt in, structured output out, read-only tools. Not
    sessions — no state machine entry, just a logged `utility_call` event.

12. **No programmatic auth.** Sessions and gate utilities use the user's existing interactive
    login (Max subscription); Pupitre never handles tokens, API keys, or credential files.
    Trust for new worktree paths is pre-seeded in `~/.claude.json` at `pup new` (same
    mechanism Claude Code itself uses when the user accepts the dialog). Claude Code keys
    the dialog on the git common-dir ROOT, not the launch cwd (verified on 2.1.218), so
    the worktree's main repo root is seeded alongside the worktree path (2026-07-23).

## Gate metrics

13. **Coverage = patch coverage vs a ratcheting baseline**: only added/modified lines are measured;
    their coverage ratio must meet the repo baseline. Deletions are free by construction.
14. **v1 gate slims to**: build, tests, lint, scope audit, diff-size flag, minimal ledger with
    `--accept-debt`. Patch coverage and the full debt-delta stage (duplication, dead code,
    complexity) move to v1.1 with the ratchet.

21. **Debt delta = three soft stages with a merge-time ratchet (2026-07-24).** `dead-code`
    and `duplication` measure the whole branch worktree and compare against repo-wide
    values stored on the project baseline: the list of unused exports (only findings not
    already in the list flag) and the count of duplicated normalized lines (sliding
    6-line windows, adapter-implemented in lieu of jscpd). `complexity` needs no stored
    baseline: per touched file, decision points at the target (the locked main checkout)
    vs the branch, flagging any rise past a per-file threshold. All three follow
    diff-size semantics (decision 17) — flagged refuses the merge unless `--accept-debt`,
    which writes one ledger entry per flag. On every merged gate the stored debt baseline
    is set to the just-measured values: the docs/04 ratchet on improvement, and movement
    on accepted debt so later sessions aren't re-flagged for debt the ledger already
    owns. A missing capability or missing baseline reports the stage as skipped
    "not measured" (docs/06 degradation), never silently passed. Patch coverage
    (decision 13) is still pending.

22. **Python adapter ships the v1 gate surface only (2026-07-24).** Detect (any of
    pyproject.toml / setup.py / setup.cfg / requirements.txt) plus build/test/lint
    commands: byte-compile via `compileall` as the build check, pytest and ruff only
    when the repo's own config declares them, all run through `uv run` / `poetry run`
    when the matching lockfile exists. Config probing is raw-text on pyproject — the
    stack has no TOML parser and docs/08 gates new dependencies. depGraph and the
    debt capabilities are deferred; the code map and debt-delta stages degrade to
    "not measured" per docs/06. Adapter selection moves to `adapter.registry.ts`:
    detection order is priority order, TypeScript first, and single-adapter flows
    (merge, map) use the first hit.

23. **Patch coverage lands as the fourth soft stage (2026-07-24), closing decision 13.**
    The adapter `coverage` capability runs the suite instrumented (vitest with a
    declared @vitest/coverage-v8|istanbul provider, JSON reporter into a temp dir) and
    returns per-file covered/instrumented line sets; `undefined` (missing tooling,
    failed run) degrades to skipped "not measured". The gate takes the branch's
    added/modified lines from per-file `-U0` diffs, keeps only lines carrying
    instrumented statements — types, comments, and deletions are free by
    construction — and flags when covered/instrumented falls below the baseline
    repo-wide ratio (minus a float epsilon). Flags follow diff-size semantics
    (decision 17); every merge stores the measured repo ratio (decision 21 ratchet).
    Known trade-off: the instrumented run re-executes the suite after the plain test
    stage; folding coverage into the test capability (the docs/06 shape) is deferred.

24. **Custom adapter escape hatch = `sh -c` commands with a JSON stdout contract
    (2026-07-24).** `.pupitre/adapter.yml` maps `build`/`test`/`lint` (exit-code gated)
    and `depGraph`/`deadCode`/`duplication`/`complexity`/`coverage` (capability JSON on
    stdout; `complexity` gets the file list as JSON on stdin) to shell commands, plus an
    optional `id`. Strict on config: unknown keys and non-string values throw at load —
    a typo'd key silently dropping a stage is worse than a crash. Strict on output too:
    a failing or non-JSON capability command throws a named error rather than skipping;
    only `coverage` uses its existing "unavailable" channel. The config is read from the
    trusted main checkout, but commands execute in whichever checkout is being measured.
    Unlike package.json (which sessions legitimately edit, accepted exposure), the
    escape hatch is pure gate-defining config a session has no reason to author — so
    `.pupitre/**` joins `.claude/**` in the protected-path globs and any session diff
    touching it hard-fails the scope audit. Humans own the file; a human omitting a
    stage is a visible choice (the gate reports it skipped "not measured" every run).
    When present, the custom adapter outranks the built-ins in the registry, since
    overriding them is its purpose.

25. **Python debt capabilities ship as declared-tool shell-outs (2026-07-24).** The Python
    adapter grows `deadCode` (vulture) and `coverage` (pytest-cov). Each runs only when the
    repo's own config declares the tool (the decision-22 raw-text probe, widened to
    pyproject/setup.cfg/requirements.txt), through the lockfile runner prefix, with the
    gate-command budget and the scrubbed git env. Vulture exit 3 is the findings report,
    not a failure; named findings map to `DeadExport` pairs and nameless unreachable-code
    findings are dropped, since the baseline keys on file+name. A `[tool.vulture]` section
    owns paths and excludes; without one the scan gets the compileall skip list.
    coverage.py's JSON report maps executed → covered, executed+missing → instrumented.
    To carry "declared but missing or crashed", `deadCode` adopts coverage's unavailable
    channel (`DeadExport[] | undefined`): the gate reports the stage skipped
    "not measured", and init stores no dead-export baseline rather than a false empty one.
    Trust: config is probed from the checkout being measured — the decision-24 package.json
    class of accepted exposure. A session editing its manifest can silence these stages,
    but only into a visible skipped "not measured". Hardened where cheap: capability
    `uv run` gets `--no-sync` so a worktree-planted lockfile cannot install packages,
    vulture findings are line-anchored and repo-contained before touching the baseline, and
    capability stdout gets an explicit 64 MiB buffer so an induced overflow cannot silently
    degrade a stage. Resolving capability config from the trusted main checkout (the
    `gateCommands` split) needs a two-path capability signature and is deferred.
    `duplication` (normalizeLines is `//`-comment-aware, and generalising at a second use
    contradicts the third-use rule) plus `complexity` and `depGraph` stay deferred.

26. **`pup merge --pr` = same gate, pull request instead of local merge (2026-07-25).**
    Dogfooding pupitre on itself showed the collision: `pup merge` ff-merges local main,
    but PR-only repos land through their hosting platform, and routing around the gate
    silently skips the debt ratchet (observed live: PR #24 added a dead export the gate
    would have flagged). With `--pr`, a passing gate pushes the session branch to
    `origin` and opens a pull request via the operator's `gh` CLI (interactive login,
    decision 12 — never tokens; availability and an `origin` remote are checked before
    the gate runs, not after ten minutes of stages). The destination is pinned: `--repo`
    is derived from the origin URL, so a forked clone can never open the PR against the
    upstream parent and `GH_REPO`/`GH_HOST` cannot retarget it. PR title/body are
    mechanical — goal, acceptance, commit subjects, and the full gate report — for humans
    to edit on GitHub; commit subjects and gate details quote session-authored text, so
    those sections are fenced and render inert (no `Closes #n` auto-closing, no @mention
    pings, no invisible HTML comments aimed at review bots). `--pr` is operator-only: the
    CLI refuses it when `PUP_SESSION_ID` is set, since a session opening outward-facing
    PRs under human attribution is exactly the audit-trail lie the ledger must not tell.
    Everything else keeps decision-16 semantics: session → `merged` (redefined as "passed
    the gate and left pupitre's custody"), task done, decision record drafted, tmux +
    worktree + local branch cleaned (`-D`; the commits live on origin). The debt baseline
    does NOT ratchet — the target branch has not moved, so moving the bar would misjudge
    concurrent sessions; the next `pup audit` after the PR lands ratchets it instead.
    Known gaps, accepted: between PR-open and PR-merge an `--accept-debt` flag is in the
    ledger but not yet in the baseline (a concurrent session gets re-flagged for it); a
    PR closed without merging leaves a `merged` session whose commits never landed — the
    remote branch still holds them; and a gh failure after the push is not idempotent to
    retry (the branch is already on origin, and a second `--accept-debt` run re-inserts
    ledger entries) — probe-before-push idempotency is deferred (resolved by decision 27).

27. **A failed `pup merge --pr` retries cleanly, and the ledger names the real acceptor
    (2026-07-25).** Closes two decision-26 gaps. Idempotent retry, in two pieces: before
    pushing, the gate asks origin for an open PR with the session branch as head
    (`gh pr list`, same pinned `--repo`) and reuses it instead of failing on re-create,
    which also fail-fasts a dead gh before origin is mutated; and an `--accept-debt` flag
    already recorded as an identical open ledger entry is not re-inserted, so a retried
    merge cannot double-count the same accepted debt. Every field is in that dedupe key,
    files and acceptor included — two flags naming different files are different debt.
    **Adoption is a trust decision, not a lookup.** `--head` matches a branch NAME, and a
    session has a shell plus the operator's ambient gh login, so it can open its own PR
    for its own branch and wait for the operator's `pup merge --pr` to bless it — the
    decision-26 operator-only guard stops a session from *calling* `--pr`, not from
    planting what `--pr` finds. So: more than one match, a cross-repository (fork) head,
    or a base that is not the gate's target are refused rather than adopted; and because
    a description pup did not write can carry a forged gate report, adoption overwrites
    title and body with the mechanical ones (`gh pr edit`) and the CLI says the PR was
    reused, not opened. What is NOT claimed: the commits are the same either way (same
    branch, gated by the same run), and a session can always open PRs on its own — pup
    just never lets one masquerade as a gate outcome.
    The adoption checks are settled next to `assertGhAvailable`, before the gate runs, so
    a refusal costs no stages and writes no ledger entry for a merge that cannot happen.
    Truthful attribution: `acceptedBy` stops being hardcoded `'human'`. The acceptor is
    the session whose worktree the command runs in, falling back to `PUP_SESSION_ID` when
    it names a session that exists, then `'human'` — worktree first because it survives
    `env -u PUP_SESSION_ID`, and validated because an env var must not be able to write
    arbitrary text into an audit column. The `--pr` guard uses the same lookup. This
    raises the bar over the env var alone; it is not a boundary. A session can `cd` to
    the repo root before running `pup merge`, and it can write the SQLite store directly
    — the ledger is honest about honest mistakes, not proof against a hostile agent, and
    plain `pup merge` has never had a caller check at all.
    The push uses `--force-with-lease` once a remote-tracking ref exists: a retry has
    usually been auto-rebased onto a moved target, and a plain push would be rejected
    non-fast-forward on that retry and every one after it. The lease still refuses if
    origin moved past what pup itself last pushed.
    Still accepted: a PR closed without merging leaves a `merged` session whose commits
    live only on the remote branch; the between-open-and-merge baseline gap stands until
    the post-merge `pup audit`; adoption inherits everything about the PR except title and
    body (labels, reviewers, comments) — only armed auto-merge is refused, since that one
    would land the commits without the operator click the CLI tells them to make; and the
    adoption checks are a probe, so a base flipped on GitHub afterwards is not re-checked.

28. **Gate and capability children get an env allowlist, and pup's git calls stop running
    repo hooks (2026-07-25).** Gate stage commands and adapter debt capabilities run code
    a session wrote — `package.json` scripts, `[tool.vulture]` config, the test suite
    itself — and they were inheriting pup's whole environment, which for a developer
    running `pup merge` in their own terminal means API keys, `GH_TOKEN`, cloud
    credentials, and `SSH_AUTH_SOCK`. `gateChildEnv()` replaces `scrubbedGitEnv()` at
    every such call site — gate stages, the TypeScript and Python capabilities, the
    custom adapter's `sh -c` (decision 24), and `pup init`/`pup audit`'s baseline stages,
    since main is "trusted" only in the sense that the gate let it in one merge earlier —
    keeping a fixed list (HOME, PATH, SHELL, USER/LOGNAME, TMPDIR, TZ, the LANG/LC_* and
    XDG_*_HOME families) and dropping everything else, GIT_DIR family included, so it
    subsumes decision-22's scrub instead of layering on it. `NODE_OPTIONS` is excluded
    deliberately: it can `--require` a module into every node the stage runs. Verified
    against this repo's own gate: build, test, and lint all pass under the allowlist.
    Escape hatch: `PUP_GATE_ENV=DATABASE_URL,CI` adds those names.
    **Hooks are the other half.** Worktrees share `$GIT_COMMON_DIR/hooks` with the main
    checkout, hooks are untracked so the scope audit never sees one appear, and the
    gate's own `git rebase` runs before any stage — so a planted `pre-rebase` executed
    with pup's full environment ahead of the sandbox meant to confine it. Every git call
    in the gate and in session creation now passes `-c core.hooksPath=/dev/null`, which
    outranks a session-written `.git/config`.
    **What this is not.** It removes env-borne secrets from the child; it is not
    containment. `HOME` stays (dropping it breaks every toolchain), so a gate child can
    still read `~/.config/gh/hosts.yml`, `~/.aws/credentials`, `~/.npmrc`, `~/.ssh`, and
    write `~/.zshenv` — including setting `PUP_GATE_ENV` there for the operator's next
    run. Real containment needs `sandbox-exec`/bwrap/a container, and making the
    passthrough an operator-supplied flag rather than an inherited variable; both
    deferred. Pupitre's own git and gh calls keep the full `scrubbedGitEnv()`: they run
    pup's code, and pushing needs the operator's credential helpers.
    **Process-group kill stays deferred, now with a reason.** Reaping a timed-out
    stage's grandchildren (vitest workers, pytest-xdist) needs the child in its own
    process group (`detached: true`), and that costs Ctrl-C: today the terminal's SIGINT
    reaches the whole group, so an operator can abort a ten-minute stage; detached, it
    would kill only pup and orphan the stage. Doing both needs a JS signal handler,
    which cannot run while `execFileSync` blocks the event loop — so it waits for an
    async gate pipeline, not for this PR.

29. **Capabilities take a two-path context and say why they measured nothing
    (2026-07-25).** Closes the two adapter-interface items decisions 25 and 26 deferred, in
    one migration rather than two passes over the same signature. Every capability now
    takes a `CapabilityContext { measurePath, configPath }` instead of a bare path. The
    split exists because the two checkouts are not equally trusted: measurement has to
    happen in the session's worktree, but *which tools are declared* now resolves from the
    main checkout the merge lock holds at the target branch. That closes the exposure
    decision 25 accepted — a session could drop `vulture` from its `requirements.txt`, or
    `@vitest/coverage-v8` from its `package.json`, and turn a debt stage into a skipped
    "not measured". TypeScript's dead-export entry points come from the trusted manifest
    for the same reason. Outside the gate (`pup init`, the code map) both paths are the
    same checkout, via `localContext()`.
    Second half: the `undefined` that meant "no measurement" becomes
    `{ unavailable: reason }`, and the gate prints the reason. "not measured — dead-code
    tooling unavailable or the run failed" told an operator nothing; "not measured —
    vulture failed: vulture: command not found" tells them what to fix. Failure text is
    collapsed to one line and capped, stderr preferred, so one broken tool cannot swamp
    the report. `undefined` on the *capability itself* still means the adapter has no such
    capability — one channel per question, rather than two nullish ones.
    Note the invariant this preserves: an empty array is a measurement, not an absence.
    `pup init` keys "did any adapter measure?" on the per-adapter result list, so an
    adapter that measured and found nothing still stores a real `[]` baseline instead of
    leaving the bar unset.
    **The split covers tool *declaration*, not tool *configuration*, and that distinction
    matters.** A capability still runs with the worktree as its working directory, because
    that is the code being measured, so per-tool config there still applies: vulture reads
    `[tool.vulture]` from its CWD, coverage reads `vitest.config.ts` / `[tool.coverage.run]`
    from the session's. Left alone, that is worse than what decision 25 accepted — a
    worktree `[tool.vulture]` aiming the scan at an empty path yields a PASS on a fake
    empty measurement and ratchets the baseline to nothing, where the old exposure only
    produced a visible skip. So vulture declines to measure at all when the worktree's
    section differs from the trusted one (text compare; fully honouring the trusted config
    needs a TOML parser, which docs/08 gates). The equivalent for coverage config is NOT
    closed: a session can still fail its instrumented run into a skip, or `coverage.exclude`
    its changed files into "no instrumentable changed lines", which the gate passes for
    free. Flagging changed-but-uninstrumented files is the fix and is deferred. Capability
    tool *binaries* also still resolve from the worktree (`.venv/bin`, `node_modules/.bin`,
    both normally gitignored, so neither the clean check nor the scope audit sees a planted
    one) — code execution there is already accepted by decisions 24 and 28, but it means
    measurement integrity rests on the worktree, and no claim here should suggest otherwise.
    Reasons are sanitized where they are consumed, not where they are produced: a custom
    adapter's reason is parsed JSON that never passed through `failureSummary`, and it
    reaches the operator's terminal and the fenced PR body. Control characters go (ANSI
    cursor moves could repaint a FLAGGED row as PASS on the screen the operator decides
    from), whitespace collapses so a closing fence cannot break out, and the cap counts
    code points. For the same reason `isUnavailable` is a shape check hardened against
    `null` and primitives rather than an `in` test, and custom-adapter JSON is shape-checked
    per capability — otherwise a script measuring session code could print
    `{"unavailable": …}` and convert its own measurement into a skipped stage.
    Behavioural note: TypeScript dead-export entry points now come from the trusted
    manifest, so a PR that legitimately adds a new `bin`/`exports` entry has that file's
    exports counted as dead in its own merge. `--accept-debt` covers it; the next `pup
    audit` after the merge clears it.

30. **Changed code absent from the coverage report is flagged, not free (2026-07-25).**
    Closes the loophole decision 29 recorded and deferred. Patch coverage only ever looked
    at changed lines the report mentions, so anything the report omitted counted as zero
    instrumentable changed lines — a PASS. Two ways to reach it, one hostile and one
    ordinary: `coverage.exclude` (or `[tool.coverage.run] omit`) the changed files, or
    simply ship a module no test ever loads. Either way the stage read as green on code
    with no tests at all, which is exactly what decision 13's patch-coverage gate exists
    to prevent.
    The gate cannot judge this alone: "absent from the report" means nothing without
    knowing whether the file is code. So adapters gain `coverableFiles(ctx, files)` — the
    subset of a changed-file list the toolchain would expect coverage for. Both
    implementations drop files that no longer exist, so a deletion stays free by
    construction as decision 13 requires. The exclusion list is deliberately *narrow* and
    matched to what the tools actually exclude: `config` is a valid role suffix in this
    repo, so a blanket `*.config.*` rule would make `src/payments.config.ts` an
    exempt-by-naming hiding place for production code. Named build configs and
    root-anchored artifact directories are excluded; `src/build/`, `src/test/` and
    `packages/tests/` are not.
    Two things this needed to be more than theatre. The stage's own guards were the
    bigger hole: "coverage unavailable" and "report has no instrumentable lines" both
    short-circuited to `skipped` *before* any check ran, and both are session-reachable
    from the worktree's coverage config — so excluding *everything* was free while
    excluding *the changed files* was caught. Changed source plus no measurement is now a
    flag, not a skip. And the TypeScript run pins `--coverage.provider` from the trusted
    manifest, because vitest's `provider: 'custom'` with a session-authored provider
    module hands the gate a forged report — every file present, 100% covered — which then
    ratchets the stored baseline to the forged number.
    It also passes an explicit `--coverage.include`, because vitest 3+ reports only files
    a test loaded. Without it an untested module is *absent* rather than 0%-covered, which
    both weakens the signal (a file-presence flag instead of a precise patch-coverage one)
    and makes every type-only module look hidden — 15 of this repo's 68 source files are
    `*.types.ts`, which no test can ever load because the transform elides type imports.
    Flagging those every merge would train operators to reflexively `--accept-debt`,
    destroying the ledger's meaning along with this gate's.
    Ceilings, stated rather than implied. The flag fires on a file missing from the
    report, not on lines excluded *within* a reported one (`/* istanbul ignore */`,
    `# pragma: no cover`), so a file present with zero instrumented lines still passes.
    Tightening to "present and instrumented" was tried and rejected: with
    `--coverage.include` a type-only module appears with no statements, so that rule
    flags ordinary TypeScript. Python has no equivalent of the provider pin — a worktree
    `conftest.py` can rewrite the JSON report after pytest-cov writes it — and no
    `--coverage.include` equivalent is passed there, so its untested modules surface as
    unreported files rather than 0%-covered ones. `isPythonTestFile` follows pytest's
    *default* `python_files`, which a worktree config can redefine. The custom adapter
    gets no `coverableFiles`, so `.pupitre/adapter.yml` repos keep the old behaviour
    rather than the YAML contract growing a sixth key. In short: this closes the ordinary
    and the narrow-hostile cases and raises the cost of the rest; it is not a proof
    against a determined session, which decisions 28 and 29 already established needs a
    real sandbox.
    Both coverage problems are evaluated rather than short-circuited, so a merge that
    hides files *and* drops the ratio records both in one ledger entry naming every file
    involved. Repo paths reaching a stage detail go through the decision-29 sanitizer
    now too: paths come from `git diff -z` as raw bytes precisely so they are not mangled,
    and a detail is printed to the operator's terminal, fenced into the PR body, and fed
    back to the session as a re-steer prompt.

## Implementation notes

- Shared SQLite store in WAL mode so concurrent hook writes from multiple worktrees don't contend.
- Node >= 20, TypeScript, commander, better-sqlite3 (per 08-roadmap stack decision).
