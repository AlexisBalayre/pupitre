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

35. **A running session is STALLED by events-file mtime, not a logged timestamp
    (2026-08-02).** Observed live: a transient API network error left a session dead at its
    prompt for an hour while `pup status` still read RUNNING — `classifySessionActivity`
    (decision 2) correctly classified the last hook event, but nothing carried an age, so a
    five-second permission ask and a silent hour-long wedge rendered identically. The
    operator only noticed by reading the tmux pane by hand. Hook events themselves carry no
    timestamp field (verified against a live `~/.pupitre/*/sessions/*/events.jsonl`), so
    staleness is read from the events file's mtime instead of adding one: every hook append
    already touches the file, so its mtime is the last-activity clock for free, with no
    change to the event schema or the hooks that write it. `STALLED_AFTER_MS` (10 minutes,
    `session-activity.constants.ts`) gates a running session whose events file is older than
    that, independent of its classified activity kind — staleness wins over
    awaiting-input/idle/working, since the whole point is that a wedge can present as any of
    them. `pup status` prints `STALLED (Nm)` and sorts stalled sessions to the top alongside
    `blocked` ones; `pup watch` emits one `STALLED` line per sweep for each.

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

36. **Gate children run inside a pup-generated `sandbox-exec` profile, and `PUP_GATE_ENV` is
    replaced by `--gate-env` (2026-08-02).** Closes the containment decision 28 deferred, and the
    ambient-injection door its 2026-07-27 refinement described. Decision 28 removed the
    operator's secrets from the child's *environment* and said plainly that this was not
    containment: `HOME` stayed, so a gate child could still read `~/.aws/credentials`,
    `~/.config/gh/hosts.yml` or `~/.ssh`, and write `~/.zshenv` for the operator's next login.
    Every call site that built a `gateChildEnv()` — gate stages, the TypeScript and Python
    capabilities, the custom adapter's `sh -c` (decision 24), and `pup init`/`pup audit`'s
    baseline stages — now goes through one seam, `runGateChild` (`sandbox.utils.ts`), which pairs
    the env allowlist with a filesystem policy. One seam is the point: "what can a gate child
    touch" has a single answer, and a new call site cannot forget the sandbox without also
    forgetting the environment it has to ask for anyway.
    **The policy.** Default-allow; then `file-write*` denied for everything under `HOME` with no
    carve-outs; then the paths a gate needs — the checkout being measured, the trusted checkout,
    the run's scratch dir, the toolchain cache — allowed back; then `~/.pupitre` and the generated
    profile denied *last*, so pup's own store (the baselines a gate ratchets, the ledger it
    writes) and the profile a later stage would be run under stay unwritable whatever a caller
    passes as writable. Order is load-bearing — SBPL's last matching rule wins, and the worktree
    being measured normally lives under `HOME`, so the blanket deny has to land before the allow.
    `file-read*` is denied for a fixed constant (`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`,
    `~/.npmrc`, `~/.gnupg`, `~/.kube`, `~/.docker/config.json`, `~/Library/Keychains`,
    `~/.pupitre`) with **no extension mechanism**: a per-repo or per-operator list is a channel a
    session can write, which is the hole decision 31 had to close for `python_files`. Read cannot
    be default-deny — the node binary a gate child executes lives under `HOME` on any nvm/asdf
    install, so denying reads there executes nothing at all.
    **Cache redirect, and why it is not per-run.** Denied `HOME` writes break toolchains that
    default their cache to `~/.npm` or `~/Library/Caches`, so `XDG_CACHE_HOME`,
    `npm_config_cache`, `COREPACK_HOME`, `PIP_CACHE_DIR` and `UV_CACHE_DIR` are pointed at a
    pup-owned cache directory and `TMPDIR` at the run's own scratch. The cache directory is
    deliberately *stable across runs* where the scratch is not: pointed at a directory that starts
    empty every time, corepack re-downloads the repo's package manager on every `pup merge`, which
    turns a local gate into a network-dependent one — worse than not redirecting at all.
    **Both fail modes.** On darwin a sandbox that cannot be set up throws instead of running the
    child, so the stage fails and the merge refuses, exactly as decision 31's parse errors do; the
    invariant is that no session-authored code ever runs unconfined on a platform pup claims to
    confine. Everywhere else children run unsandboxed and the gate report, `pup init` and `pup
    audit` each print `sandbox: none (unsupported platform)` — decision 29's honesty rule applied
    to the platform gap, since a silent absence reads exactly like the guarantee.
    **A third mode, found by dogfooding.** macOS refuses a nested `sandbox_apply` unless the inner
    profile is identical to the outer one, and pupitre's own gate is precisely that case: `pnpm
    test` runs as a sandboxed stage and the suite spawns gate children of its own, which failed 52
    tests with `sandbox_apply: Operation not permitted`. Pup probes once per process and reports
    `sandbox: inherited (pup is itself sandboxed)` when it cannot layer its own profile on top.
    That is not a hole — a child cannot escape the sandbox its parent runs under, so it stays
    confined by whatever confines pup — but it is a different guarantee, so it gets a different
    word in the report. Only the nesting refusal degrades this way; any other `sandbox-exec`
    failure still refuses the merge.
    **`PUP_GATE_ENV` is gone**, replaced by `--gate-env <NAME,...>` on `merge`, `init` and
    `audit`. The variable is no longer honoured at all, which is the whole point: direnv's
    `.envrc`, a CI job, a Makefile or any wrapper process supplies an environment variable without
    anyone editing the command the operator typed, while a flag is reachable only by rewriting
    that command.
    Verified against this repo's own gate, which is the acceptance decision 28 used: build, lint,
    test and the instrumented coverage run all pass under the sandbox (82.7% over 71 files).
    **Ceilings, stated rather than implied.** Network stays open, so a gate child can still
    exfiltrate anything it can read — and it can read everything the deny list misses, which means
    a secret in `~/Documents/keys.txt` is not protected; the list closes the credential stores an
    attacker reaches for first, not the general case. The sandbox matches resolved paths, so a
    `~/.npmrc` symlinked out to a dotfiles repo is read through its target. Writes *outside*
    `HOME` remain default-allow, so the shared toolchain cache is poisonable by a gate child — as
    `~/.npm` always was, and as any path outside it is. Whoever launches pup still chooses the
    child's policy in the `inherited` case. And Linux gets nothing here: the same seam wants a
    `bwrap` implementation, deferred rather than faked, because a report that says `none` is
    honest where a half-policy would not be.

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
    deferred.
    **On that flag, refined (2026-07-27):** it is worth doing, but not for the reason
    stated above, and it does not close the hole it is listed against. The primitive is the
    `HOME` write, and a `~/.zshenv` that can export `PUP_GATE_ENV` can equally define a
    shell function or alias wrapping `pup` with the flag already set. What a flag does close
    is *ambient* injection, which is a wider door than the login shell: direnv's `.envrc`
    lives in the repo, and a CI job, a Makefile or any wrapper process supplies an
    environment variable without anyone editing a dotfile. A flag is reachable only by
    rewriting the operator's command. So the ordering is the reverse of the sentence above —
    containment is the fix, the flag is defence in depth against a different vector.
    Note also that the profile YAML is *not* an option for this, idiomatic though operator
    settings there otherwise are: it lives in the repo, so a session could write it, which is
    the same channel decision 31 had to close for `python_files`. Pupitre's own git and gh calls keep the full `scrubbedGitEnv()`: they run
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

31. **A Python file is exempt from coverage only if both checkouts call it a test
    (2026-07-25).** Closes the ceiling decision 30 stated and deferred: `isPythonTestFile`
    followed pytest's *default* `python_files`, which any config file can redefine. Since
    `coverableFiles` is the only input to both of decision 30's flags, a name it exempts is
    invisible to the gate entirely — so a session put production code in `test_payments.py`
    and narrowed `python_files` in its worktree, leaving a module pytest never collects,
    never executes and never covers, which pup waved through on the strength of its name.
    `python_files` now resolves from *both* checkouts and a file is exempt only when both
    classify it as a test. Reading it from the trusted checkout alone was considered and
    rejected: the trusted value *is* the default the attack relies on, so the AND is the
    part that does the work. The failure directions are deliberately asymmetric — an
    unparsed or empty declaration yields no patterns, which leaves more files coverable,
    never fewer. `conftest.py` stays exempt unconditionally, as pytest's own special case.
    **Two holes were in the fix, not the original**, both found by re-running
    `security-reviewer` on the revision and reproduced before being acted on.
    First, reading the pattern list from `configPath` created a channel that did not exist
    when the classification was a hardcoded constant: the trusted side is only trusted one
    merge deep, so a PR touching no `.py` file at all — and therefore passing the coverage
    stage as a skip — can land `python_files = ["*.py"]` and switch decision 30's check off
    permanently, silently, for every later merge. Second, the same change fed
    attacker-authored patterns to `globToRegExp`, whose `*` becomes `[^/]*`: measured
    against a 254-character basename, `*a*a*a*a*b.py` backtracks for 41 seconds and grows
    about 8x per added wildcard. That spin happens inside the merge lock, which is released
    in a `finally` a Ctrl-C'd process never reaches and which has no TTL, so any session
    could wedge every subsequent merge in the repo. Before this change neither was
    reachable: the old predicate was `startsWith`/`endsWith`, no config, no regex.
    Both are answered by one filter, `isDiscoveryConvention`, applied to both sides. A
    pattern is honoured only if it is within a wildcard budget *and* fails to match an
    arbitrary canary basename — a pattern matching `zzpupcanaryzz.py` is a blanket, not a
    convention. The budget is checked first so the canary match cannot itself become the
    payload, and a canary-only filter would not have closed the second hole: the ReDoS
    pattern does not match the canary.
    Two further holes were in the fix itself. **The first was a parser differential**: pytest
    treats `pytest.ini` as its config by *existing*, even empty, and modelling that as
    "carries a `[pytest]` section" let a session commit an empty `pytest.ini` beside the
    shared `pyproject.toml`. pytest then reverts to its defaults while pup keeps reading the
    pyproject, so a `check_payments.py` both checkouts agree is a test is one pytest never
    collects, never runs and never covers — a one-PR bypass of the whole AND, with the two
    checkouts never visibly disagreeing. `pytest.ini` now claims the config by presence; the
    other three still require their section, which is also pytest's rule.
    **The second was the canary itself.** A canary of ordinary letters is a fixed string the
    adversary reads, and the wildcard budget of two is exactly enough to dodge it:
    `zzpupcanaryzz.py` contains no `_`, so `*_*.py` cleared the filter while claiming nearly
    all snake_case Python. Zero-wildcard entries were not screened at all, so a declaration
    could simply enumerate the modules it wanted exempted. The canary now carries every
    character a blanket can key on (`zz_0123456789-abcdefghijklmnopqrstuvwxyz.py`) — a real
    convention anchors at one end and cannot match it, while anything shaped "contains an X"
    must — and at least one wildcard is now required.
    **A third hole was in that filter**, and it is the reason the budget counts wildcards in
    the *compiled* source rather than in the pattern text. `globToRegExpSource` swaps
    globstars for NUL-delimited sentinels before expanding them, and nothing stops those
    sentinel bytes arriving from a config file: `\0g\0m\0g\0e\0g\0t\0g\0s.py` presents zero
    wildcards to a textual count, compiles to `^.*m.*e.*t.*s\.py$`, and — built from letters
    the canary lacks — clears the blanket check too, leaving a targeted exemption for
    `payments.py` specifically. The first attempt at a regression test here was a wall-clock
    bound, and it passed against the broken counter: the payload took 505ms against a 1000ms
    bound. Asserting the *exemption* rather than the elapsed time is what made it discriminate.
    Ceilings, stated rather than implied. The canary stops the blanket, not a *targeted*
    planted pattern: `python_files = ["payments.py"]` merged into the trusted config exempts
    exactly that file, and requiring a wildcard would not help, since `payment?.py` reaches
    the same place. That residual is decision 29's accepted position — main is trusted only
    in the sense that the gate let it in one merge earlier — and it is visible in a PR diff
    in a way the blanket is not. `conftest.py` remains an unconditional name-only exemption
    at any depth, so production code reached through a registry from an already-merged
    caller is exempt there; narrowing it would flag ordinary fixtures. Pattern count is
    capped at 64: nothing else bounds a declaration, which can be one very long line that the
    diff-size stage counts as a single changed line, and 50,000 patterns measured 2.5s of
    regex compilation per merge inside that same untimed lock.
    The blanket rule has a false-positive that is worth naming, because decision 30 warns
    that reflexive `--accept-debt` destroys the ledger: `python_files = ["*.py"]` scoped by
    `testpaths = ["tests"]` is a real if uncommon layout, and it is now rejected wholesale,
    so every changed file under `tests/` becomes coverable and — if the coverage config also
    scopes to `src` — flags on every merge that touches a test. It is deferred rather than
    adopted: it is a judgement about false-flag load, and this repo has no Python to dogfood
    it against.
    **Correction (2026-07-27):** this entry originally proposed falling back to the defaults
    when the *entire* declared list is rejected, and claimed that would restore the old
    behaviour for such a repo. It would not, and the remedy should not be implemented as
    written. The defaults are `test_*.py`/`*_test.py`, and a repo declares
    `python_files = ["*.py"]` precisely because its tests are *not* named that way — if they
    were, the blanket would buy it nothing. So the fallback returns exactly the patterns that
    already fail there, and every non-default-named file under `tests/` keeps flagging. The
    fallback would only help a repo whose blanket was redundant to begin with. It remains
    safe (the AND still anchors on the trusted side), just ineffective for the layout that
    motivated it.
    Actually fixing that layout means honouring `testpaths`, which nothing in `src/` parses
    today: scope a blanket to the declared test directories rather than reject it. That is a
    larger change carrying its own attack surface — `testpaths` is attacker-controlled too, so
    it needs a convention filter of its own, a declaration of `testpaths = ["src"]` being the
    obvious payload — and it is what the deferral should be understood to cover.
    Adding `pytest.ini` and `tox.ini` to the files read widens the uncaught-throw surface
    (`mkdir pytest.ini` gives `EISDIR`), which fails closed: the merge refuses and the lock
    releases. Character classes (`test_[ab].py`) are escaped by `globToRegExp` rather than
    honoured, so they fail to match and land on the coverable side.

32. **A coverage report holds only files coverage is expected for (2026-07-27).** Found by
    turning the stage on for pupitre itself, which is the first time any of the coverage
    decisions ran against this repo. `pup audit` recorded a baseline of **32.8%** where the
    real figure is **68.1%**, and chasing the gap turned up two defects in decision 30's
    `--coverage.include`, both invisible to the unit tests because both are about which files
    the glob reaches.
    The include exists so an unloaded module appears as 0%-covered instead of absent. It also
    **overrides vitest's default excludes**: without it the report has 50 files and no test
    files, with it 103 files including all 35 test files, each instrumented and wholly
    uncovered. Those 1802 lines halve the repo ratio. Worse, `patchCoverage` counts any added
    line the report instruments, so every added test line counted as uncovered — **writing
    tests lowered a PR's patch coverage**, exactly inverting what decision 13's bar is for.
    The PR that landed immediately before this one added 117 test lines and would have been
    flagged for it.
    The second defect only appears in the checkout that sets the baseline. `**/*.ts` from the
    main checkout descends into `.worktrees/`, so every open session's copy of every source
    file joins the report: measuring main with one worktree open gave 136 files against a
    worktree's 68. The repo's ratio moved with how many sessions happened to exist, and the
    baseline is recorded from main while the gate measures in a worktree — so the two sides of
    every comparison had different denominators. This is why the same code reported 68 files
    in one checkout and 103 in another, which is what exposed the whole thing.
    Both are answered in `istanbulToCoverageReport`, which already dropped entries resolving
    outside the repo, by dropping `isCoverageExcluded` files too. That is deliberately the
    *same predicate* `coverableFiles` uses to decide what coverage is expected for, so the
    report and the expectation cannot drift apart: a file the gate would never flag as
    unreported also cannot drag the ratio down. Filtering in pup rather than passing
    `--coverage.exclude` keeps it outside the worktree's reach, consistent with decision 30
    pinning the provider. `.worktrees/` joins the exclusion list not because it is generated
    but because it is another checkout of the same repo; the Python adapter already skips it
    in `COMPILEALL_EXCLUDE` and `VULTURE_EXCLUDE` for the same reason.
    Both checkouts now report 68 files and 0.6814. Ceiling: the excluded files are still
    instrumented by vitest before pup discards them, so the run does more work than it needs
    to — correctness first, and the waste is bounded by the include glob.
    The lesson is decision 26's, sharpened: PR-mode merges never ratchet, so the post-merge
    `pup audit` is the only thing that writes a baseline, and it runs in the one checkout
    where `.worktrees/` exists. A metric can be unit-tested, reviewed, and still wrong in the
    only place it is ever recorded.

33. **Duplication does not count import statements (2026-07-27).** `normalizeLines` now drops
    whole `import` statements, single- and multi-line, before the sliding window runs. An
    import member list is not collapsible: two adapters importing the same seven types from
    `adapter.types.js` are reusing a contract, which is the design docs/06 asks for, yet a
    line-window scan reads the shared list as a clone. Every line of it counted, so adding a
    file that imports an existing type raised the repo-wide count and flagged the stage, and
    the only response available to the author was `--accept-debt` — the reflex decision 30
    names as the thing that destroys the ledger. A metric that cannot be acted on is worse
    than no metric, because it teaches the operator to wave the gate through.
    Measured on this repo, 84 of 266 duplicated lines were inside imports, so the baseline
    moves 266 → 182. Every cross-adapter block disappeared, being import noise end to end;
    what survives is real (`cli/index.ts` repeating its `NoAdapterError` guard, the tmux
    invocation in `session-runtime.service.ts`, and test scaffolding).
    Measured back through main, the noise is a near-constant offset, not the drift: 206 → 230
    → 266 over the last three sessions decomposes into imports 78 → 78 → 84 and real
    duplication 128 → 152 → 182. So the absolute figure was inflated by about a third all
    along, but +54 of the +60 rise the handoff flagged is genuine copy-paste and is **not**
    addressed here. Fixing the metric makes that growth legible instead of explaining it away.
    Detection is line-based like the rest of the scan: a dynamic `import(...)` is excluded by
    hand, and an `import` inside a template literal is skipped as if it were real, which is
    acceptable since that line is still an import. Re-export statements (`export … from`) are
    deliberately left in scope; they are rare here and the same argument has not been tested
    against them.

34. **`pup audit` diffs the debt baseline too, not just stage status (2026-08-02).** Observed
    live: an ungated GitHub merge raised duplicated lines from 182 to 196, and `pup audit`
    printed only `Baseline refreshed.` — `compareBaselines` diffed `stages[].status`
    (build/test/lint) but the debt numbers (`deadExports`, `duplicatedLines`, `coverageRatio`)
    were re-measured and written into the stored baseline without ever being compared against
    what they replaced. A regression of exactly the kind the merge-gate's dead-code/
    duplication/coverage stages exist to catch was invisible the moment it landed outside the
    gate, because `pup audit` is the only thing that can still see it after the fact.
    `auditProject` now also runs `compareDebt`, one `DebtTransition` per metric measured on
    both the old and fresh baseline — a metric missing from either side has nothing to diff
    against, so it is left out rather than guessed at, mirroring how `pup audit`'s existing
    stage diff already treats a stage absent from the old baseline as `skipped`. Direction is
    metric-specific: `deadExports` (compared by count, not by diffing which exports are dead
    — that identity diff is what the merge-gate's dead-code stage already does, at merge time,
    per decision 21) and `duplicatedLines` regress on a rise; `coverageRatio` regresses on a
    fall past decision 23's `COVERAGE_RATIO_EPSILON`, reused here so the same float noise that
    would not flag a merge does not flag an audit either.
    `pup audit`'s output now prints every measured metric as `label  before -> after  MARKER`
    next to the existing stage-transition lines, and a debt regression sets `hasRegression`
    alongside a stage regression — so `pup audit --sweep` now refuses on a debt rise exactly
    as it already refused on a failing stage, instead of launching a deletion-only sweep on
    top of debt nobody was told about.
    Ceiling, deliberately not closed here: a plain `pup audit` (no `--sweep`) still refreshes
    the baseline to the fresh, worse numbers regardless of `hasRegression` — ratchet semantics
    are unchanged, matching how a regressed stage was already handled before this change. The
    command now *says* duplication rose 182 → 196; it does not refuse to store 196 as the new
    floor. Nothing short of a human (or `--sweep`, which does refuse) stands between an
    observed regression and it becoming the baseline the next audit compares against.

## Implementation notes

- Shared SQLite store in WAL mode so concurrent hook writes from multiple worktrees don't contend.
- Node >= 20, TypeScript, commander, better-sqlite3 (per 08-roadmap stack decision).
