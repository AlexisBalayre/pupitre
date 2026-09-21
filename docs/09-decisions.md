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
   Accepted limitation for `pup steer` itself; decision 37 adds the explicit escape hatch.
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

    *Addendum, 2026-09-13: one reader of session activity, and it is not the CLI.* The stall
    rule and `classifySessionActivity` both lived in `src/cli/index.ts`, which was fine while
    the terminal list was the only surface that asked. The terminal UI is a second one, and
    two surfaces each reading the events files their own way is how a session ends up STALLED
    on one and working on the other — the exact failure this decision was written against,
    one layer up. So `buildDashboardSnapshot` (`core/dashboard.service.ts`) is now the single
    reader: it opens each running session's events file once, classifies it, ages it by mtime,
    and hands both out on the session row. `findStalledSessions` moved there beside it, since
    `pup watch` asks the same question on a sweep where there is no snapshot to build. The CLI
    keeps only the printing — `activityMarker` now reads the row, never the file.
    Two rules survive the move as written, and are worth naming because a reader of the
    snapshot could reasonably assume otherwise. Activity is read **only** for a running
    session with an events file: a finished session's last hook event is history, not
    activity, so the field is absent rather than `unknown`, and the marker is empty for the
    same reason it always was. And `needsHuman` is deliberately wider than what sorts first —
    it counts awaiting-input, which the sort does not, because a five-second permission ask
    flagged at the top would bury the blocked session the operator actually has to act on.

    *Addendum, 2026-09-14: the radar resumes a turn that died on an API error, and the pane
    is evidence, not state.* Observed twice on 2026-09-13: a machine asleep at 01:16 and a DNS
    outage at 13:00 each ended a running session's turn with `API Error: Connection lost while
    your computer was asleep` / `Can't reach the API server (ENOTFOUND)`. That is not a turn
    end — no Stop hook fires, so the events file stops dead, `pup status` read STALLED for
    hours, and the session sat at an empty prompt with its edits in the worktree. Both times
    the conductor's own waiting turn died the same way, so nobody resumed the worker until the
    operator typed into its window by hand. The stall rule had found the session; what was
    missing was the one further question the operator was answering by eye: is this pane
    showing a dead turn?
    So `pup watch`'s sweep now runs a turn watchdog (`core/turn-watchdog.service.ts`) over the
    sessions `findStalledSessions` flags: it captures each one's launch pane (by the pane id
    recorded at launch, decision 46) and, when the last transcript line above an *empty* input
    box matches `^⏺ API Error:`, appends a `turn_died` event with the error line (sanitized,
    decision 29) and steers the session with a fixed resume message, recorded as a `steer
    {kind: 'resume', by: 'watch'}`. A refused steer — the paste never landed, or the pane is
    gone — is recorded on the same `turn_died` event as its `refusal` and left for a human;
    `pup status` prints `TURN DIED (API error) — resumed by watch at hh:mm` (or `resume
    refused …, needs a human`) on that row instead of the bare age, and `pup watch --once`
    prints one line per resume. Four things were chosen deliberately:
    - **Decision 2 holds: the pane is read for recovery only.** The store keeps the event and
      the steer; nothing about the session's state is derived from the capture, and the
      capture is not kept. The alternative — a `deadTurn` field on the dashboard snapshot —
      would have made the pane a second reader of session activity, the exact split the
      previous addendum closed.
    - **Idempotence is a stall stamp AND an age, not "the newest event".** The spec's rule
      (skip when the newest event since the last steer is already `turn_died`) re-fires every
      sweep, because after a resume the newest event *is* the resume steer. The `turn_died`
      event instead carries `stalledAt`, the events file's mtime — the very clock this decision
      ages a stall by, which stands still for exactly as long as the session does — and a
      recorded dead turn blocks a new resume only while it is younger than `STALLED_AFTER_MS`.
      Both halves are needed. The stamp is what keeps one dead turn from being resumed every
      sweep, and gives a session that recovers, works and dies again a new stamp and its own
      resume. The age is the DNS-outage case the watchdog was written for: the resumed turn
      dies again at once, no hook fires, the stamp never moves, and a stamp alone would have
      left that session dead after the network came back. Past the window, the same error
      over the same empty box is the next dead turn of the same stall — a new `turn_died` with
      the same `stalledAt`, and `pup status` reads the newest. The cost is one resume message
      every ten minutes for as long as an outage lasts, into a box that is empty each time.
    - **One event carries the outcome.** The event is written after the steer attempt so a
      refusal sits beside its cause rather than in a second event. The window that leaves — a
      watcher killed between the steer and the write — costs one duplicate resume message,
      which lands in an empty box behind the first and reads as a follow-up. The other order
      would leave a refusal unrecorded and steer every fifteen seconds for the length of the
      outage.
    - **The conductor is nudged on its own socket, with a null-session event as its
      cooldown.** Its window lives on `conductorSocket` (decision 47) and records no pane id,
      so the watchdog resolves the pane with `list-panes` there — the lowest id, since the
      launch kills the server first and tmux never reissues an id within one — and types a
      one-line nudge (`Operator watchdog: your turn died with an API error; read pup status and
      resume any session that needs it`), last in the sweep so the sessions it will be asked
      about are already resumed. The nudge itself moves the pane past the error line; for an
      outage long enough to kill the nudged turn too, the nudge is recorded as a `turn_died`
      event with `session_id = NULL` (the conductor has no row; every other `events` query is
      keyed on a session id, so the row is inert for them) and not repeated inside
      `STALLED_AFTER_MS`.
    The radar is the watchdog's host, so `pup conductor start` brings it up when none is
    running — the store's watcher beat missing or stale, not a window name a session could
    mint — and says so: a conductor without a radar is the fleet that needed the operator
    twice. `pup watch` itself is operator-only, like `pup audit`: it types into panes and
    records resumes in the watcher's name, so a session or the conductor running it could forge
    a resume against another session; the detached radar passes because `launchWatcher` runs
    it from the main checkout with both tier variables stripped. Two more readings of the pane
    are refused on purpose: a line that carries `Retrying` is a turn still alive and backing
    off, not a dead one, however long the series outlasts the stall window; and a sweep that
    throws is printed to the radar's stderr and skipped, never allowed to kill a process whose
    beat the overlap scan has already recorded. Rejected: a Stop hook that would fire on an API
    error (Claude Code fires none), a retry inside the session (the turn is over; only a new
    prompt starts one), and a watchdog on the conductor's `pup status` reading (its turn is the
    one that dies).
    Accepted, not fixed in code: a forged `turn_died` row in the store — decision 46 takes store
    access as the root of trust — now turns a wrong STALLED age into a reassuring `resumed by
    watch` sentence on the row and, for one stall window, suppresses the real resume. A session
    with write access to the store could always mark itself done; this adds one more sentence
    it can make the operator read, and the age bound above puts a ten-minute ceiling on what
    the forgery suppresses.

    *Addendum, 2026-09-14: the line is on the snapshot, and the `deadTurn` field the addendum
    above rejected is now the right one.* The addendum shipped the line in `pup status` only:
    `deadTurnLabel` lived in `src/cli/index.ts` and called `lastDeadTurn` itself, so `pup ui`,
    which draws every column off `DashboardSnapshot`, still showed the bare STALLED age for a
    session the watchdog had already resumed. Two surfaces telling the operator different
    things about the same always-visible row is exactly the split decision 52 exists to
    prevent, so the sub-decision above — *no `deadTurn` field on the snapshot* — is reversed.
    Its reasoning does not survive the second surface: it read the field as making the pane a
    second reader of session activity, but nothing on the snapshot reads a pane. The watchdog
    captures the pane, keeps nothing of it, and writes a `turn_died` event; the snapshot
    matches that **stored** event against the stall stamp, which it takes from the same
    events-file mtime this decision ages every stall by. That is the store answering, like
    every other field on a row — the reading moved, not its source. Decision 2 is untouched:
    the pane is still read for recovery only, still by the watchdog, still once per sweep.
    Three details follow from where the code now sits. `findStalledSessions` returns
    `stalledAt` beside the age — it stats the events file already, and the stall's name and
    the stall's age are one reading — which also deletes the watchdog's private copy of that
    stat and, with `lastDeadTurn` now unused, the function itself. The direction of the
    import is why the match is written out again in `dashboard.service.ts` rather than called
    from the watchdog: `turn-watchdog.service.ts` imports `findStalledSessions` from the
    snapshot service, so the snapshot service reaching back for `lastDeadTurn` would be a
    cycle. And the sentence itself is one helper, folded into `activityLabel`
    (`cli/ui/dashboard-text.utils.ts`) rather than set beside it — which sentence that column
    carries is one decision, and a surface that had to remember to ask for the dead turn *and*
    the age would be the same drift one layer down. The `reason` — the pane's own error line —
    rides on the field but stays off both rows: it is the same sentence every time, `pup watch`
    prints it, and the row is already at the width where the `needs a human` tail truncates on
    an eighty-column terminal.

37. **Force-interrupt is its own command, and every tmux lookup is pinned to exact match
    (2026-08-03).** `pup interrupt <session> ["<message>"]` sends Escape to the session's
    pane, aborting the in-flight tool call, then optionally steers — the recovery decision 35
    left manual (a wedged tool call is unreachable by `pup steer`, whose messages queue until
    the turn ends; the alternatives were killing a paid-for context or hand-typed
    `tmux send-keys`). Decision 4 stands for `pup steer`: steers still queue; interrupting is
    a deliberate, separate act because Escape mid-turn discards the tool call's result.
    Landing it surfaced a transport bug the security review verified live on tmux 3.7b: tmux
    resolves a bare `-t` name exact → fnmatch → *prefix*, and session slugs mint prefix pairs
    (`t-abc`, `t-abc-1`), so once `pup-t-abc` died its steers, captures and kills would land
    in the living `pup-t-abc-1`. Every lookup now goes through one `pinned()` helper
    (`=pup-<id>:`; the `=` forces exact match, the trailing `:` is required for pane
    resolution), while `new-session -s` keeps the bare name — `=` and `:` are legal *in*
    session names, so a pinned name at spawn would create an orphan pane no pinned lookup
    could ever find again. `steer` and `interrupt` also refuse terminal sessions outright;
    their panes are gone, and a dead name is exactly what prefix matching would have
    mis-delivered. Deferred, found the same way: task scope is fixed at `pup new`, so a
    mid-session discovery that the correct fix lives one file outside scope (here:
    `EventType` gaining `'interrupt'`) forces either a cast past the type or a follow-up PR —
    a `pup scope add <session> <glob>` needs designing before the next scoped session hits it.

## Safety & enforcement

5. **Sessions run with permissions bypassed; compiled hooks are the enforcement layer.**
   Scope-in globs on Edit/Write; deny-patterns on Bash.
6. **Bash scope checking is best-effort**: a real shell parser denies clear write patterns
   (`>`, `>>`, `tee`, `sed -i`, `rm`/`mv`/`cp`, `git apply`…) whose resolved target is out of scope
   or inside `.claude/`. Unparseable commands pass. The authoritative backstop is the gate:
   diff-vs-scope is a hard fail, and a `.claude/` drift-hash mismatch is a hard fail.
7. **Rejection→re-steer is capped at 2.** A third gate failure parks the session as
   `blocked — needs human`, surfaced at the top of `pup status` with the failure history.

   *Addendum, 2026-09-12: the human it asks for now has a command.* This decision said a
   blocked session needs a human and gave the human nothing to run. `pup kill --respawn` and
   `pup respawn` both refuse anything that is not already running, `pup merge` wants
   `awaiting-review`, and `pup session done` from `blocked` is an illegal transition — so the
   only move was `pup kill`, which throws away a context window and returns the task to the
   backlog (decision 40). Observed live the same day, session `t-mtycrep1`: the gate's re-steer
   was refused on an ANSI-laden report (decision 45's addendum), the session sat blocked with
   its window alive and its work committed, the operator steered the fix in by hand, and the
   way back was a `node` one-liner calling `transitionSession(db, id, 'running', ...)`.
   `pup unblock <session> [--reason <text>]` is that one-liner as a command: allowed only from
   `blocked`, refused by name from every other state — `canTransition` would wave `queued`
   through, and there is no block there to lift.
   *It reads the reason back before it lifts it.* Decision 45's addendum closed on "nothing
   reads the reason back": the gate writes why it parked a session into the `gate_result`
   payload and no surface printed it. `pup unblock` prints it first, from the newest
   `gate_result` that moved the session to `blocked` — sanitized, because the reason quotes a
   steer refusal over the session's own output (decision 29). Unblocking is a claim that the
   block was addressed, and the operator cannot make that claim about a reason they were never
   shown. `pup status` and the merge's blocked line now name the command, which is the other
   half of the same gap: the parking was visible and its exit was not.
   *It resets nothing, steers nothing, and touches no window.* The reject count stays, so a
   session parked by the cap is parked again by its next gate failure — a count rolled back
   silently would let one failure loop through the gate for ever, which is the thing this
   decision's cap exists to stop; the command says so when it lifts a capped block. Decision
   45's addendum imagined an `unblock` that re-steers, and the live case is why it does not:
   what there would be to re-steer is the report whose paste was refused, so a re-steer
   rebuilds the refusal. The operator has already typed what they wanted typed, or will with
   `pup steer`; a dead window is `pup kill --respawn`'s job, which takes the session now that
   it is running again.
   *Operator-only, and the conductor is refused too.* The parking exists to ask a human, and
   the conductor is what the blocked session was working for — it would be marking its own
   work unblocked, which is the line decision 47 draws at the merge. A session unblocking
   itself is the parking undone by the thing it was parked for (decisions 26, 42).

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
    **The policy.** Reads default-allow; writes default-**deny**, allowed back only for the paths
    a gate needs — the checkout being measured, the trusted checkout, the run's scratch dir, the
    toolchain cache, and `/dev` — and then `~/.pupitre`, the generated profile and each granted
    checkout's `.git` denied *last*, so they stay unwritable whatever a caller passes as writable.
    Order is load-bearing: SBPL's last matching rule wins, and the worktree being measured normally
    lives under `HOME`, so a blanket deny has to land before the allow.
    Denying only `HOME` was the first attempt and it was not enough. `/opt/homebrew/bin` is
    group-writable on a standard install, so a gate child could overwrite the `gh`, `git` or `tmux`
    binary pup itself runs *afterwards* — unsandboxed, with the operator's full environment. The
    writable set is enumerated at every call site anyway, so inverting the default costs nothing
    and closes every path nobody thought to name. A checkout's `.git` is denied for the same class
    of reason: `core.fsmonitor`, `core.sshCommand`, `core.pager` and aliases in `.git/config` are
    executed by pup's own later git calls, and `core.hooksPath=/dev/null` does not close that
    (verified against Apple Git-154). Denying the directory whole covers `config.worktree`, that
    checkout's own `.git` pointer file, `hooks/`, `info/` and refs — measurement must not mutate
    the repository it measures, which is the rule the Python adapter's `uv --no-sync` already
    follows. The `.git` denies are derived inside the seam rather than passed per call site: a
    call site that forgets to protect the checkout it just made writable reopens the hole.
    **The trusted checkout is not writable during a merge**, and getting that wrong cost two
    rounds. It was granted for one stated reason — a worktree shares its git object store, so a
    stage running git needs the index lock — and denying `.git` outright nullified that reason
    while the grant survived it. What the grant still bought an attacker was everything: the deny
    reaches `<repo>/.git`, but a *sibling* worktree's pointer file at
    `<repo>/.worktrees/<other>/.git` is a level below it, and rewriting that to a `gitdir:` whose
    `commondir` supplies a `core.fsmonitor` executes under the next `pup merge`'s unsandboxed git
    (reproduced; the simpler gitdir-only redirect does not work, since git resolves config through
    `commondir`). Worse and quieter, `<repo>/package.json` was rewritable, so a build stage could
    drop `@vitest/coverage-v8` from the manifest the coverage capability reads and turn the
    coverage stage into a skip — measurement forgery aimed straight at decision 29, invisible to
    both the worktree cleanliness check and the branch-diff scope audit, and persistent, since the
    same file chooses the *next* run's `gateCommands`. So `repoPath` now only keys the toolchain
    cache. `pup init`/`pup audit` are unaffected: they pass the same path as `cwd`, where the
    write grant is legitimate.
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
    turns a local gate into a network-dependent one — worse than not redirecting at all. It is
    equally deliberately scoped **per repo**, keyed by `projectId`: these caches carry executable
    code (corepack runs the package-manager tarballs in its home, uv hardlinks cached wheels into
    the venv), so one shared directory would let a gate child in repo A supply the `pnpm` that
    measures repo B. The directory is checked before reuse — a real directory, owned by this user,
    not group- or world-writable — because its name is guessable and `TMPDIR` is a variable, so a
    `TMPDIR` aimed at a shared `/tmp` must refuse rather than silently share.
    **Both fail modes.** On darwin a sandbox that cannot be set up throws instead of running the
    child, so the stage fails and the merge refuses, exactly as decision 31's parse errors do. The
    invariant is about gate *children* and only them: no child pup spawns to measure a session's
    code runs unconfined on a platform pup claims to confine. It says nothing about the session
    process, which runs with permissions bypassed by design (decision 5) and is not sandboxed at
    all — the hooks and the gate are its enforcement layer, not this. Everywhere else children run
    unsandboxed and the gate report, `pup init` and `pup audit` each print `sandbox: none
    (unsupported platform)` — decision 29's honesty rule applied to the platform gap, since a
    silent absence reads exactly like the guarantee.
    **A third mode, found by dogfooding.** macOS refuses a nested `sandbox_apply` unless the inner
    profile is identical to the outer one, and pupitre's own gate is precisely that case: `pnpm
    test` runs as a sandboxed stage and the suite spawns gate children of its own, which failed 52
    tests with `sandbox_apply: Operation not permitted`. Pup probes once per process and reports
    `sandbox: inherited (pup is itself sandboxed)` when it cannot layer its own profile on top.
    That is not a hole — a child cannot escape the sandbox its parent runs under, so it stays
    confined by whatever confines pup — but it is a different guarantee, so it gets a different
    word in the report. Only the nesting refusal degrades this way; any other `sandbox-exec`
    failure still refuses the merge.
    **That probe is security-critical, and its first version was forgeable.** It ran a
    PATH-resolved `true` and matched the refusal against the child's own stderr buffer, so a
    planted `true` printing `sandbox_apply: Operation not permitted` forced `inherited` — every
    gate child then ran unwrapped while the report claimed containment. It now runs `/usr/bin/true`
    by absolute path, a SIP-protected binary that writes nothing, with an empty environment, and
    matches the refusal anchored to `sandbox-exec:` at the start of a line. The rule the fix
    encodes: the probe must observe nothing the child can write.
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
    `~/.npmrc` symlinked out to a dotfiles repo is read through its target. `/dev` is write-granted,
    so a child can reach `/dev/tty` and the terminal behind it — unchanged from the default-allow
    policy this replaced, but worth naming now that everything else is enumerated. A repo's own
    cache stays poisonable by that repo's gate children — the cross-repo path is closed, the
    same-repo one is not, and it buys an attacker nothing there, since a gate child already runs
    that repo's code. The session process itself is unconfined by design (decision 5), so this
    bounds what the *gate* executes, not what a session does inside its worktree. Whoever launches
    pup still chooses the child's policy in the `inherited` case. And Linux gets nothing here: the
    same seam wants a `bwrap` implementation, deferred rather than faked, because a report that
    says `none` is honest where a half-policy would not be.

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
    outranks a session-written `.git/config` (decision 41 adds `core.fsmonitor=` beside it,
    a second command git runs on index reads that `hooksPath` does not cover).
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

38. **Baseline drift is a new append-only `baseline_history` table, not a reuse of
    `projects.baseline` (2026-08-03).** `pup report --open`'s drift section (docs/08) needs a
    trend, and the store could not produce one: only one baseline ever exists —
    `projects.baseline`, overwritten in place on every capture — and `AuditReport.previous`
    lives in memory only during a mutating ~36s audit, so rendering drift from the existing
    schema meant either showing a single point or re-running the audit at render time, both
    of which break the report's rendering-only constraint. `baseline_history` (`project_id`,
    `captured_at`, `stages` JSON, `debt` JSON nullable, indexed on `(project_id,
    captured_at)`) is appended in `initProject` — the one choke point both `pup init` and
    `pup audit` capture through — so history starts with the project's very first baseline,
    not one audit late. Three sub-decisions:
    *Every capture appends, not only on change* — an unchanged measurement is a data point (a
    flat trend segment is information), and content-diffing to suppress it buys nothing:
    captures happen once per init/audit (pupitre's own 11 days produced far fewer audits than
    its 24 gate reports), each row is a few KB of JSON, so even years of daily audits stay in
    the hundreds of rows. Nothing prunes; if a future caller wires captures into a loop, that
    caller adds pruning.
    *Backfill* — the first capture on an upgraded store seeds a row from the outgoing
    pre-table baseline before `saveProjectBaseline` discards it, so the numbers already
    ratcheted over 11 days of dogfooding are the trend's first point rather than lost. The
    seed is guarded by a `(project_id, captured_at)` existence check, so re-running captures
    seeds it exactly once.
    *Duplicate `captured_at`* — possible only for two captures in the same millisecond
    (realistic in tests, not in a ~36s audit); both rows are kept and `listBaselineHistory`
    orders by `(captured_at, id)` so insertion order breaks the tie. The index is
    deliberately not UNIQUE: a capture path must record, never throw.
    Ceiling, stated plainly: the merge-gate debt ratchet (decisions 21, 26) mutates
    `projects.baseline`'s debt in place *keeping the old `capturedAt`*, and those bar moves
    get no history row — the backfill guard sees the timestamp already recorded and skips.
    Between audits the trend is audit-to-audit only; a ratchet move surfaces in the next
    audit's row. Recording ratchets would mean duplicate-timestamp rows dated to the wrong
    moment or changing what `capturedAt` means, so it waits until the rendered report proves
    the audit-to-audit trend too sparse.

39. **Duplication does not count test-fixture duplication (2026-09-03).** `findDuplication`
    now skips any block whose *every* location is a test file, tallying it as
    `excludedTestBlocks` instead. Decision 33's sibling, reached the same way: a metric the
    author cannot act on teaches the operator to wave the gate through.
    Measured over the 11 days of dogfooding, four of the six duplication flags the gate ever
    raised were pure test-setup repetition — `python-adapter.test.ts` against itself,
    `index.test.ts` against itself, `session-runtime.test.ts` against `git-diff-client.test.ts`,
    and `audit.test.ts` against `init.test.ts`. Each cost a session a rework cycle to get back
    under the bar, and t-msc3oe6k's own note records it as "duplicated debt-test scaffolding
    the merge gate flagged (184->210)". The most-flagged block is the `GIT_ENV` scrub, which
    `docs/conventions/testing.md` **publishes verbatim** as the thing every git-touching test
    must write, and which is itself exactly six lines against a six-line window. The gate was
    failing merges for obeying the repo's own written convention, and that convention is
    deliberate: testing.md prescribes a real store and repo *per test* over shared setup,
    because shared setup couples suites and hides what each one depends on.
    On this repo the rule moves duplication 220 → 62 and blocks 23 → 6; 17 of the 23 were
    test↔test. The 6 that survive are production and all genuine (the `NoAdapterError` guard
    in `cli/index.ts`, the `gh` exec options in `github.client.ts`, two windows in
    `session-handoff.service.ts`, and `report.service.ts` against `session-dossier.service.ts`).
    Four sub-decisions, three of them sharpened by the security review this change went
    through — the first cut of the predicate opened two holes that did not exist before it.
    *Every location, not any* — a block mixing test and production files still counts in full,
    so a clone cannot be hidden by relocating one copy out of the metric's sight. Closed by a
    discriminating test: flipping `every` to `some` fails exactly that test and nothing else.
    *`isTestFile` is the `*.test.ts` suffix and nothing else* — in
    `typescript-source.utils.ts`. Two earlier cuts of this predicate were wider and both were
    wrong, which is the useful part of the record. An exemption is only safe when something
    forces the file to actually hold tests: `vitest.config.ts` here collects `src/**/*.test.ts`,
    so parking production code under that name hard-fails the test stage with "No test suite
    found in file" — which is why the pre-existing inline `file.includes('.test.')` was harmless.
    A `*.spec.ts`, a nested `src/core/__tests__/`, and a rooted `tests/` are collected by
    *nothing*, so each would have bought exemption from duplication, dead exports and coverage
    for free on ordinary importable code: `git mv` two flagged files in (no `PreToolUse` hook
    sees a Bash rename) and the stage passes naming no file. A genuine test under any of those
    layouts is still `foo.test.ts`, already covered by the suffix, so a directory arm only ever
    added the unsuffixed files — the attack and nothing else. The cost is a repo that names or
    places its tests differently: its fixture repetition gets counted rather than hidden, the
    safe direction. Widening this means corroborating against the trusted checkout's runner
    config, decision 31's pattern, not a longer regex. `findDeadExports` now uses the shared
    predicate instead of its own inline check — a no-op here, and a tightening in general, since
    `.includes('.test.')` also matched mid-name.
    Deliberately **not** `isCoverageExcluded`, which answers "should a coverage report mention
    this?" and so also swallows `dist/`, `build/` and named tool configs — duplication between
    two `tailwind.config.ts` files is still duplication.
    *The gate says what it left out* — the stage detail appends `; N test-fixture block(s) not
    counted`, per decision 29's rule that a capability explains what it did not measure. The
    field is optional, so a custom adapter that omits it makes the gate fall silent rather than
    claim it counted none. Being optional made it a new injection sink: `matchesShape` probed
    only for `duplicatedLines`' presence, so a custom adapter's `sh -c` stdout could return a
    string carrying newlines and backticks that lands in the terminal, the fenced PR body and
    the re-steer prompt — on the *passing* path, where `duplicatedLines` at least coerces to
    `NaN` and gets flagged. Both numbers are now type-checked at that boundary and re-checked
    finite at the sink, per decision 29's "sanitized where they are consumed".
    *A stored count carries the rule that produced it* — `DebtBaseline.duplicationRule`, stamped
    by `initProject` and every merge, and `knownLines` resolves only when it matches
    `DUPLICATION_RULE_ID`. This closes what was first written here as a temporary ceiling and is
    not: 62 measured against a stored 220 does not merely pass on 158 lines of slack until an
    audit, it lets the *next* merge ratchet `62 + smuggled` in as the new floor, and `pup audit`
    then blesses it, because by then the smuggled duplication is main. No flag, no
    `--accept-debt`, no ledger entry — a silent permanent write-off through the artifact that
    exists to record accepted debt. A mismatch now routes to the existing `skipped` path saying
    the baseline counts duplication a different way — and, the correction that matters, it does
    not move the bar either. Stamping the fresh number on the mismatch path was the first
    attempt and was worse than the problem it fixed: the merge that skipped the compare would
    have written its own unvalidated measurement in as the permanent floor, so a session merging
    in that one window could store *any* number — 5 000 duplicated lines the old rule would have
    flagged and refused — with every later merge gating against it and `pup audit` confirming
    it. Decision 30's lesson applies directly: a baseline is re-stamped from the trusted
    checkout by `pup audit`, never from the worktree under judgement. So a mismatched baseline
    stays mismatched and the stage stays `skipped` until an operator audits; in `--pr` mode —
    this repo's actual workflow, where the merge-time ratchet never runs — that was the only
    path anyway. Decision 33 (206 → 182) had the identical mechanic and went unnoticed, which is
    what a version stamp is for. `pup audit` also stops diffing `duplicatedLines` across rules,
    since reporting the rule change as an improvement would mask a real rise underneath it —
    decision 34's rule, applied to a metric present on both sides but not comparable.
    Three ceilings, stated plainly. **Unenforceable for custom adapters:** decision 24 has them
    self-reporting `duplicatedLines` over `sh -c`, so docs/06 states the rule as contract and
    trusts it exactly as far as it already trusts those numbers — the stamp constrains only
    pup's own captures. **A gate-measurement change cannot be validated by the gate:** `pup
    merge` runs the adapter from the main checkout while measuring the worktree's files, so a
    branch that changes the measurement is judged by the old one — the same trap as validating a
    sandbox-policy change with the test suite. This change therefore lands as a plain PR, with
    `pup audit` on main afterwards to capture 62 under the new rule.
    **Fixture duplication is now invisible beyond a count:** a 400-line copy-pasted test helper
    would not be flagged, only tallied.

40. **A task can exist before a session; the backlog is derived, not stored (2026-09-04).**
    `insertTask` had exactly one caller — `createSession` — which had already created a git
    worktree two lines earlier and launched tmux four lines later, so planned work could not
    exist. `docs/01` has documented `queued -> running` as the first transition since the
    beginning and it was unreachable: `createSession` transitions straight to `running`, which
    is why `pup report`'s live/queued section is permanently blank. This is the "what will be
    built" artefact the vision asks for, at its smallest honest size: intent you can write,
    read and revise before anything runs.
    `planTask` (`pup plan add`) writes a row and does no git or filesystem work. `launchTask`
    (`pup launch`) does everything else. `createSession`
    (`pup new`) is now their composition, unchanged from the operator's side — the one-liner
    that launches a session in a single keystroke is the daily path and stays.
    Three sub-decisions:
    *Membership is derived* — the backlog is tasks no session in `queued`, `running`,
    `awaiting-review`, `rejected`, `blocked` or `merged` has claimed. `tasks.status` used to
    hold this and is **dropped**: it was written on every insert and on merge, read by nothing,
    and a second copy of session state can only drift from the sessions table that owns it. The
    drop needed a new migration kind — `MIGRATIONS` entries were add-if-absent, now they carry
    `kind: 'add' | 'drop'` and the guard reads `present === (kind === 'drop')`.
    *`killed` is deliberately absent from that list* — abandoned work returns to the backlog and
    `pup launch` can retry it. Today a killed session leaves its task `status='open'` with
    nothing able to relaunch it, so the intent silently evaporates. `sessionSlug` already counts
    a task's sessions, so the second one gets its own slug without change.
    *A claimed task's spec is frozen* — `deleteTask` and `updateTaskSpec` both refuse once a
    session exists, because the spec is compiled into that session's `context.md` at launch and
    editing it afterwards would leave the store disagreeing with what the agent was told. This
    is also the first `UPDATE tasks SET spec` in the codebase; the spec was previously
    write-once.
    Two things moved while the seam was open. The **knowledge slice is now built at launch, not
    at plan time** — the code map moves on between planning a task and launching it, so a slice
    captured with the intent would describe a repo that no longer exists; it also moves that
    logic out of the CLI, where `pup new` had been assembling it. And **`pup new --role` is
    removed**: it was declared "informational for now", `opts.role` was read nowhere, and
    `tasks.role` is written from it but never read. Deleting the flag is honest about that
    rather than leaving an option that does nothing.
    Five guards the security review put on this, four of them closing holes the split itself
    opened. They are the useful part of the record, because each one is a consequence of intent
    outliving the command that wrote it.
    *A spec is validated where it is written* — the split had left all validation in
    `compileProfile`, which runs after `git worktree add`. A backlog row with an empty or
    malformed scope therefore compiled fine at plan time and threw at launch, after the worktree
    and branch existed, leaving orphans and a task that could never be launched again because
    the branch name was taken. `planTask` now runs the launchable subset of that validation, and
    `startSession` compiles *before* it touches the filesystem. `pup new` had the same ordering
    and it did not matter, because the operator had typed the failing input a second earlier.
    *A scope glob may not carry a control character* — `scope-in.pat` is line-oriented and read
    by `grep -qE -f`, where a blank line is a pattern that matches everything, so a single
    newline inside a glob silently turned the Edit/Write hook into allow-all. Verified against
    the system grep the hook actually runs. Rejected in `assertPlannableSpec`
    (`task-spec.utils.ts`, run by `pup plan add` and `pup plan edit`) and again in
    `validateInput`, so every compile path is covered. `globsToGrepFile` drops a glob carrying
    one outright rather than splitting it: the first attempt filtered blank *elements*, which is
    inert because a converted glob is always `^…$` and never blank, and splitting on the newline
    instead would emit the tail as an **unanchored** fragment matching more than the glob ever
    named. Dropping the whole malformed glob is the only fail-closed option.
    *`pup launch` refuses a claimed task* — without it, a session parked `blocked` by decision
    7's reject cap could relaunch its own task and get a fresh session with `reject_count = 0`,
    stepping over the parking that needs a human. Decision 40's stated "no admission control"
    ceiling was about scope overlap between *different* tasks and never covered this.
    *Writing a spec is operator-only* — `pup plan add|drop|edit` **and `pup new`** refuse when a
    session is calling, by decision 26's rule and detection. Guarding only the new commands was
    the first attempt and was worthless: `pup new` is `plan add` plus a launch, so it is the same
    capability under an older name, and it additionally hands a session parked `blocked` a fresh
    session past decision 7's reject cap. The lookup itself moved into one `callingSession`
    helper, because `merge --pr` had been carrying its own copy of the same trust-boundary check
    and two copies of it would drift. A session could otherwise author a task whose
    `goal` becomes a later session's kickoff prompt verbatim and whose `scopeIn` becomes the hook
    allowlist the gate audits against, recorded as `origin='human'`: prompt injection carrying
    the operator's attribution. `pup plan` (list) stays open, since reading is not authoring.
    Listed goals and globs go through decision 29's sanitizer, and `pup launch` prints the goal
    and scope it is about to compile, so the operator's review is bound to the spec that actually
    runs.
    *The row key owns identity* — `launchTask` takes the task id from the trusted primary key and
    the spec blob only for intent. A spec whose `id` had drifted would compile one task's hooks
    under another task's session row, so the hooks would enforce one scope while the gate audited
    another.
    Two smaller corrections. `deleteTask` refuses **any** task a session ever ran for, not merely
    a claimed one: `sessions.task_id` is a NOT NULL foreign key, so deleting a task whose killed
    session returned it to the backlog aborted on the constraint and surfaced a raw SQLite error
    instead of refusing. And the `drop` migration is *tolerated* rather than fatal — a table
    rewrite can fail on a concurrent lock or a user-added index over the column, and nothing
    reads a dropped column, so leaving it costs nothing where a throwing `openStore` would take
    every `pup` command with it.
    Ceilings, stated plainly. **No ordering, dependencies or decomposition:** the backlog is a
    flat list ordered by creation. Those were the other readings of "what will be built" and
    each needs this primitive first. **No admission control yet:** `pup launch` does not check
    the task's scope against live sessions, so two sessions can still hold identical scope and
    only the post-hoc 15s diff sweep notices — the next change closes that. **`pup status` and
    the report still show the backlog nowhere**, so a planned task is only visible to
    `pup plan`; same next change. **Claude still never authors a spec** — every task is
    operator argv or `buildSweepTask`'s hardcoded template, so `docs/07`'s promise that each
    audit finding becomes a pre-scoped task remains unkept, though it is now buildable for the
    first time. **A task with history can never be dropped**, per the foreign key above, so a
    killed session's task returns to the backlog and stays there until it is launched again.
    **`pup kill` leaves the worktree, branch and commits behind** while returning the task; a
    relaunch is safe because `sessionSlug` mints a new slug, but each cycle accumulates an orphan
    branch holding commits no `pup merge` will take (the gate refuses a non-`awaiting-review`
    session). **A `--pr` session whose pull request is closed unmerged stays `merged`**, so its
    task is claimed forever and can no longer be launched, dropped or edited — decisions 26 and
    27 accepted the stranded session; the stranded task is new, and is the price of deriving
    backlog membership from session state.

41. **A launch is refused when its scope collides with a live session; the backlog is
    visible where work is chosen (2026-09-04).** Decision 40 left three ceilings and this
    closes them: no admission control, `pup status` showing the backlog nowhere, and the
    report's live/queued section having nothing to hold. All three are the same gap — intent
    existed in the store and nothing consulted it.
    *The radar was the wrong instrument for the question.* `scanOverlaps` diffs live branches
    every 15 seconds and reports two sessions in one file, which is a fact about work already
    done: by the time it fires both agents have edited the file and one of them is going to
    lose. `pup launch` now asks the same question of two *scopes* before either has written
    anything, and refuses. `--allow-overlap` overrides, the considered-override shape
    `--accept-debt` established. The refusal names the session and the shared files, because
    "narrow the scope" is only actionable if the operator knows which files to drop.
    *A scope resolves to files through the gate's own precedence.* `scopedPaths`
    (`scope-audit.utils.ts`) is the complement of `auditScope`: the paths a task is allowed to
    edit are the ones the gate would not flag. So scope-out subtracts, protected paths never
    collide, and the check cannot drift into a second, laxer reading of what a scope means —
    a file a session could never commit is not a file it can conflict over. Both sides go
    through it against one `git ls-files -z` listing, then into `intersectSessionFiles`, which
    already computed pairwise same-file overlap for the radar and had only ever seen diff
    lists. Second use of that function, not a new abstraction.
    *`holdingStates` is `claimedStates` minus the terminal pair.* Derived the same way and for
    the same reason: a state added later holds its scope by default. `merged` and `killed`
    release it — a merged session's work is in the target and a killed one's is abandoned, so
    holding on would refuse every later launch over files the repo has ever touched. `queued`,
    `rejected` and `blocked` all still hold, because each transitions back to `running`.
    *The measurement reads the trusted checkout.* `repoRoot()` resolves `--git-common-dir`, so
    `git ls-files` lists the main checkout's index even when `pup launch` is run from inside a
    session's worktree — a session cannot aim the check at its own index to make it report
    nothing. Decision 30's rule, and the property the whole check rests on.
    *`--allow-overlap` is operator-only, and that is a record, not a control.* A considered
    override that waves off a collision with *another* session belongs to whoever answers for
    the collision, by decision 26's rule and detection, so the flag refuses a calling session.
    But the security review is blunt about what that buys: `pup launch` is not operator-only,
    and neither is `pup kill` — a session that wants a conflicting task launched does not need
    the flag, it kills the holder (`killed` releases the scope and returns the task to the
    backlog, decision 40) and launches plainly. The guard keeps the audit trail honest, the way
    decision 26's `--pr` guard does; it stops nothing. Extending operator-only to `launch` and
    `kill` is the natural close and is its own change (decision 42).
    *An override that leaves no record is not an override.* `--accept-debt` writes a ledger
    entry; this writes a `scope_overlap` event naming the sessions and files waved through.
    The conflicts are therefore computed on every launch, not only when the flag is absent:
    skipping the question when the answer would be ignored is how a defence ends up documented
    and inert.
    *`pup new` asks before it writes.* `createSession` is `planTask` then `launchTask`, and a
    refusal inside the second would have left the spec the operator just abandoned in the
    backlog — unclaimed, attributed to them as `origin='human'`, and launchable by any session
    through the open `pup launch`. Exactly the operator-attributed spec decision 40 stopped a
    session from authoring, handed over by accident; each retry with a narrower scope would
    have added another. The check now runs before the row exists, and the decision is made
    once: `createSession` hands `launchTask` an allowed overlap, so `launchTask` still
    measures — for its own `pup launch` path and for the `scope_overlap` record — but cannot
    refuse after the row is written. The second review found the version that re-decided: a
    holder appearing in the window between the two reads refused after `planTask`, recreating
    exactly the orphan the reordering was for. A holder that appears in that window is now
    recorded instead, the trade `--allow-overlap` already makes — and recorded as
    `via: 'raced'`, not as something the operator accepted, because they accepted nothing;
    the ledger's `acceptedBy` rule, applied to this record.
    *The audit sweep always overlaps, and says so.* `buildSweepTask` is scoped to `**/*`, so
    it collides with every live session there is; refusing it would have made
    `pup audit --sweep` unrunnable whenever anything else runs, with no flag on `pup audit` to
    say otherwise, and the refusal would have surfaced as a stack trace. It launches with the
    overlap allowed and the `scope_overlap` event naming every session it stepped on — the
    record was the point of the refusal, and a sweep keeps it.
    *A stored spec is validated before its globs are read.* The check is now the first thing
    to consume a spec read back from the store, ahead of `compileProfile`. A row written
    before decision 40's validation could be missing `scopeIn` altogether and would have died
    in `scopedPaths` with a bare TypeError; `launchTask` runs `assertPlannableSpec` first, and
    that predicate now treats a missing `scopeIn` as the empty scope it already refused.
    *Decision 28 closed hooks; the config keys git consults on pup's own commands were a
    class, and most of it is closed now.* `git ls-files` is a new call site, and looking at
    it showed that a session can write the shared, untracked `$GIT_COMMON_DIR/config` from
    its worktree with a plain `git config` — `.git/**` is seen by neither the scope hooks nor
    the gate — and name a command git then runs with the operator's environment. Each of
    these was verified against Apple Git 2.39.5, and each of the first attempts at the fix
    was reviewed again, which is how the second and third were found. **`core.fsmonitor`**
    runs on any index read (`ls-files`, `status`); `-c core.hooksPath=/dev/null` does not
    stop it, only `-c core.fsmonitor=` does, and the `=` is load-bearing since the bare key
    means `true`. **`gpg.program`** runs once per commit the gate's `git rebase` recreates
    whenever `commit.gpgsign` is set; clearing the sign flags is the lever, because
    `gpg.program` has no safe empty value. **`diff.external` and `diff.<driver>.textconv`**
    are the worst of the three, because they do not merely run: an armed external diff emits
    no hunks, `gitDiffAddedLines` returns nothing, and the coverage stage reads "no
    instrumentable changed lines" as a **pass** — decision 29's invariant inverted from a
    file the session writes. They are disarmed per call with `--no-ext-diff --no-textconv`
    (diff-subcommand flags, not top-level ones), not through `GIT_SAFE_CONFIG`, because an
    empty `diff.external` makes every diff die. The third pass showed those two flags were
    not the class either: **`color.ui=always`** forces ANSI through the pipe so no line
    starts with `@@`, and a **`* -diff` attribute** or `diff.<driver>.binary` turns every
    file into "Binary files differ" — both blank the patch the same way, both reproduced
    against the shipped function, both now covered by `--no-color --text` with a
    discriminating test each. `--text` is safe on a real binary because `patchCoverage`
    only counts files the coverage report instruments. Clearing the sign flag has a
    functional cost worth saying: an operator who signs every commit gets the gate's rebase
    rewriting theirs unsigned, and a branch rule requiring signatures then rejects the push
    — loud, and the right trade. `GIT_SAFE_CONFIG` (`git-diff.client.ts`)
    carries `hooksPath`, `fsmonitor` and both `gpgsign` keys, and every pup git call now
    spreads it — including `pushBranch`'s two, which the first version of this text claimed
    were converted and were not, and the three read-only calls (`log`, two `rev-parse`)
    that consult none of these keys today but cost nothing to cover. This was a
    pre-existing class; the change that happened to add a sixth instance is where it got
    closed. **What is not closed:** a smudge filter armed through the untracked
    `info/attributes` runs on `git worktree add` and on the gate's rebase, and has no `-c`
    disarm because its driver name is chosen by whoever wrote it. The honest fix is a loud
    refusal when that surface is armed, decision 6's shape, and it is its own change; until
    then it is a stated ceiling, verified reachable, not an accepted one (closed by
    decision 50). Two more, same status. **`gitDiffNumstat` is forgeable by the same `* -diff` line**, and `--text` does
    not restore `--numstat` the way it restores `-U0`: git emits `-\t-`, `countChangedLines`
    treats a null count as a real binary and skips it, so a 5 000-line diff reports zero
    changed lines, the `diff-size` stage passes and the review-queue risk score floors. The
    null skip is correct for a real binary; nothing anticipated the session choosing which
    files count as one. The fix is a measurement, not a flag — cross-check a null numstat
    against `gitDiffAddedLines`, which `--text` does restore, and flag the disagreement
    (closed by decision 53, which found the patch cannot be the discriminator).
    **The push target is session-controlled:** `url.<base>.insteadOf` or a rewritten
    `remote.origin.url` in the shared config sends `pushBranch` and `gh pr create` wherever
    the session says, verified under the full `GIT_SAFE_CONFIG`; the fix is to resolve
    `origin` once from the trusted checkout and push to the literal URL (the rewrite half
    closed by decision 54, the rewritten `remote.origin.url` by decision 56). A merge driver
    named through the same `info/attributes` runs on a conflicting rebase and is unlisted
    for the same reason as the smudge filter (closed by decision 50).
    *Unreachable is loud.* Two branches in `scopeConflicts` cannot fire while the store is
    pup's own — a session id containing `:`, and a session whose task row is missing under a
    NOT NULL foreign key. Both throw rather than skip: a scope the check cannot read is a scope
    it cannot clear, and comparing against nothing is the fail-open direction (decision 29).
    The candidate is also matched on either side of a pair rather than by insertion order, so
    a refactor that files it first cannot leave the check silently reporting no conflict.
    *The backlog renders where work is chosen.* `pup status` lists planned tasks under
    `planned` — the state `docs/01` has always given a task with no session row — in the
    session table's own columns, so what will be built sits beside what is being built rather
    than behind a second command. Its empty copy changed from "No sessions." to "Nothing
    running and nothing planned.", and the early return that produced it had to go: a project
    whose only content is a plan was reporting itself empty. `pup report` gains a Backlog
    section above Sessions, on the reasoning that a report opened to decide what to do next is
    answered there; the scope chips both sections draw are now one function.
    Ceilings, stated plainly. **Only the main checkout's tracked files can collide:** scopes
    resolve through `git ls-files`, so two tasks scoped to the same not-yet-created file both
    launch, and a holder whose real activity is in files it added on its own branch is
    invisible the same way; the radar catches both 15 seconds later like before. Widening this
    means comparing glob strings themselves, where `src/**` and `src/core/**` overlap without
    being equal — a real design question, deliberately not answered here. **A holder with an
    empty scope claims nothing:** a row written before decision 40's validation and never
    launched since is invisible to the check. **`merged` releases the scope** even for a
    `--pr` session whose pull request is still open (decision 26) — its worktree is gone and
    no agent is writing, so defensible, but unstated until now. **So does `killed`,** whose
    worktree, branch and commits survive by decision 40's ceiling, so a second task can be
    launched over files a killed session still holds commits for. **Protected paths never
    collide,** on either side, by construction. **A live session's own scope is trusted as
    stored:** a corrupt `tasks.spec` row throws on every launch rather than degrading, which is
    loud on purpose — and, because every `JSON.parse(row.spec)` in the CLI is raw, it surfaces
    as a stack trace rather than a named refusal. **A session-armed smudge filter still runs
    with the operator's environment** on `worktree add` and the gate's rebase, per the
    paragraph above (closed by decision 50). **Nothing re-checks after launch:** editing is
    refused at admission only, so the radar remains the only after-the-fact check. **A session
    can still deny launches:** `pup launch` is open, so a session can launch the broadest
    backlog task and every later operator launch overlapping it refuses; it is loud (a tmux
    window, a `pup status` row) and `--allow-overlap` is the operator's answer, so friction
    rather than denial (closed by decision 42). **The backlog is still flat** — ordering,
    dependencies and decomposition are untouched, and each still needs its own design
    conversation.

42. **`pup launch` and `pup kill` are operator-only, so admission control is a control
    (2026-09-05).** Decision 41 said plainly what its `--allow-overlap` guard bought: a record,
    not a control, because the two commands beside it were open. A session that wanted a
    conflicting task launched did not need the flag. `pup kill <holder>` moves the holder to
    `killed`, which releases its scope and returns its task to the backlog (decision 40), and a
    plain `pup launch` then admits the conflicting task with nothing left to refuse it — two
    commands, no override, no `scope_overlap` event, and a `killed` row that reads as the
    operator's doing. The same open `kill` also let a session end any other session's work,
    including one parked `blocked` by decision 7's reject cap and waiting for a human; and
    `--respawn` is the same authority over another session's window, so it is refused with it.
    *Same rule, same detection, same shape.* Both commands refuse when `callingSession` finds a
    session — `PUP_SESSION_ID` naming a live session, or a cwd inside one's worktree — by
    decision 26's rule and the one helper decision 40 pulled the check into, so a fourth and
    fifth copy of the trust boundary cannot drift from the first three. The message keeps the
    shape `pup new`, `pup plan` and `--pr` established: the command, `is operator-only`, and
    what a session cannot do. The `--allow-overlap` guard is gone, not kept beside the new one:
    with the command closed it was a check on a flag of a command the session can no longer
    reach, and a second guard that can never fire is the shim the conventions forbid. The
    `scope_overlap` record stays, because the operator's override still deserves one.
    *What this closes in 41.* Its "a session can still deny launches" ceiling — launching the
    broadest backlog task so every later operator launch refuses — needed `pup launch`, and the
    kill-then-launch path needed both. Admission control now says no to the caller it was
    always meant to answer.
    *What it does not close.* The detection is still decision 27's best effort: a session that
    leaves its worktree and unsets `PUP_SESSION_ID` passes as an operator, and nothing here
    changes that — the guard refuses the plain path and keeps the audit trail honest; a sandbox
    is a different instrument. An operator who runs `pup kill` from inside a session's worktree
    is refused too, as `pup new` already refuses them there, and runs it from the main checkout.
    **A session can still end a *running* session's work by a chain of open commands**: `pup
    session done` takes its identity from `PUP_SESSION_ID` alone, with no cwd cross-check, so a
    session that sets the variable to a running victim's id moves that victim to
    `awaiting-review` mid-turn; the open `pup merge` (only `--pr` is guarded) then merges or
    rejects it, and decision 7's reject cap parks it `blocked`. So "a session can end another
    session's work" is closed for a `blocked` victim — the transition table forbids
    `awaiting-review` from `blocked`, and only `kill` reached it — but not for a running one.
    The close is a cwd cross-check in `session done`, decision 26's detection applied to the
    session protocol itself, and is its own change (closed by decision 44).
    **`pup audit --sweep` still launches from inside a session**: it reaches `createSession`
    directly, scoped `**/*` with the overlap allowed by decision 41, so a session can still
    spawn a session — one with the loudest possible `scope_overlap` record, but a session.
    **`pup steer`, `pup interrupt`, `pup respawn` and `pup merge` without `--pr` are open to
    sessions**, and each is a session reaching into another session's window or branch; steer
    in particular is a prompt written into another agent's context. Each is the same close as
    this one and its own change, kept separate so the record of why stays legible (`respawn`
    and `merge` closed by decision 44; `steer` and `interrupt` stay open).
43. **`pup` resolves its project through one rule, and the store decides only when it cannot be
    wrong (2026-09-05).** Every command opened with `resolveProject()`, which shelled out to
    `git rev-parse --git-common-dir` from cwd and, outside any repo, died with the raw
    `execFileSync` stack (exit 128) — `pup status` from `$HOME` was a crash, and the
    `--project <id>` docs/02 had promised since the beginning had no implementation. The rule,
    the operator's: inside a git repo the repo wins, unchanged. `--project <id>` wins over that,
    from anywhere, including inside a different repo, and an unknown id refuses in one line that
    names the registered ids. Outside any repo the store under `~/.pupitre` — one directory per
    project id, each with its own `state.db` and `projects` row — is consulted, and only
    projects whose repo still exists on disk count: exactly one live project is used silently,
    even with stale ones beside it; several live ones are printed as `id  repo_path`, one per
    line with the stale ones marked `(missing)`, and refused with one line asking for
    `--project <id>`, because a guess would run a command against a repo the operator did not
    name; none live refuses with one line — naming the stale ids as missing when there are any,
    pointing at `pup init` either way.
    *One seam, not per-command branches.* `resolveProject(cwd, projectId?)` is still the only
    function that turns a place into a project; `--project` is a global option on the program
    that a single closure in `buildProgram` hands to it, so the twenty call sites changed one
    name and gained no branch. `pup profile`, which reached `repoRoot()` directly for its
    profiles dir, goes through the same closure now, so `--project` reaches it too. The
    refusals are a `ProjectResolutionError` the entry point maps to its message and exit 1 —
    the operator's to resolve, not a bug — while anything else that escapes `parse` still
    crashes with its stack. Git's own "fatal: not a git repository" is captured instead of
    echoed, since outside a repo it is the expected answer and pup speaks for it.
    *A project whose repo is gone is reported, never used.* Projects are keyed by the hash of
    their `repo_path`, so a repo deleted or moved leaves a registered project with no repo
    behind it — three of the four in the first real store were temp dirs from smoke tests, and
    counting them made "exactly one" never match, so `pup status` from `$HOME` refused with a
    listing on the very store the rule was written for. A project with no repo could never
    have been the answer, so it does not count toward the choice; it is still shown in the
    listing marked `(missing)`, and an explicit `--project` on it refuses with the id and the
    path that is gone, because most commands shell into that path and would fail worse.
    *Reaching another project is operator-only.* Every operator-only guard (decisions 26, 40,
    42) asks `callingSession` of the store it was handed — the session's worktree and its
    `PUP_SESSION_ID` are rows there — and a session handed another project's store is unknown
    in it, so `pup --project <other> new|plan|launch|kill` from inside a session would have
    passed every guard at once; and the store's auto-select outside any repo is the same door
    without the flag, since a session that cd's out of every repo is handed the only live
    project's store just the same. The repo around cwd is therefore the one project the shared
    resolver hands over unguarded; every other path — `--project`, or the store choosing —
    refuses on `PUP_SESSION_ID` alone first, because outside every repo there is no own store
    to be found in and decision 42's ceiling must still need both the move and the unset, and
    then when the session's own store, the repo around cwd, reports a calling session; same
    detection, same ceiling as decision 27, and the target store is never opened for the check
    because it is exactly the store that cannot know.
    *The scan trusts nothing under `~/.pupitre`.* Every store there is read, including ones a
    session wrote through the shared base or a stray file dropped in: read-only, without the
    schema and migrations `openStore` runs, and a store that cannot be read is no project rather
    than every command's crash — said once on stderr, naming the store, because a project that
    vanishes from the listing when its store loses its permissions is otherwise a mystery; an
    empty `projects` table, which `pup status` in a never-initialised repo creates, is silent.
    When the store makes the choice it says so too, `Using project <id> at <path>` on stderr,
    since the command's output otherwise reads as if the operator had named the project, and
    the path is the store's to write. A row counts only when its id is the directory's name and the
    hash of its own `repo_path` — ids derive from paths, so a row that fails to derive is a
    store planted or renamed to answer for a repo it is not keyed to, and is skipped. The
    `repo_path` a store reports and the id argv passes are sanitized before they reach the
    terminal, the listing included, by decision 29's rule.
    *What this leaves open.* An explicit `--project` on a gone repo could still serve the
    read-only commands (`report`, `log`, `debt`) from history alone; it refuses today for the
    simpler rule, and reading history for a deleted repo is its own change if it is wanted. A
    store directory holding a `state.db` with no `projects` row — `pup status` in a repo that
    never ran `pup init` creates one — is not a project and is skipped. Nothing prunes stale
    projects; a `pup init --forget <id>` would be the place.
    *Addendum, 2026-09-21: `pup status` reads across stores, and `pup ui` will with its next
    task; nothing else may.*
    Outside any repo, `pup status` no longer picks the one live project or refuses with the
    listing: it prints the fleet view, one block per registered project, and `pup status --all`
    prints the same from anywhere (decision 60). Reading every store is a third door to
    another project's store beside `--project` and the auto-select, so it carries the same
    guard — refused on `PUP_SESSION_ID` or a calling conductor alone, then on the session's own
    store — and a project whose repo is gone is still reported, never used: listed as missing,
    its store never opened. The exemption is for the two readers only; `pup ui --all` is the
    next change and is recorded there. Every other command keeps this decision's rule
    unchanged — outside a repo with several live projects it lists them and asks for
    `--project <id>`, because a command that writes must be pointed at one project by name.
44. **A session reports only its own state, and `merge` and `respawn` are operator-only
    (2026-09-06).** Decision 42 closed `launch` and `kill` and named what it left open: a chain
    of commands by which a session could still end a *running* session's work, and two more
    commands that reach into another session's window or branch. Each link is closed here by
    the detection decisions 26 and 27 established, so that none of them is a new rule.
    *`pup session done` and `handoff-done` require cwd inside the declared session's worktree.*
    Both took their identity from `PUP_SESSION_ID` alone, so a session that exported a running
    victim's id moved that victim to `awaiting-review` mid-turn, or marked its handoff ready.
    The variable is still the session's word, but `findSessionByWorktree(cwd)` must name the
    same session, and anything else refuses: another session's worktree, naming both, and no
    worktree at all — the repo root, where the first cut of this change still passed on the
    variable alone, because it refused only a contradiction and the security review walked a
    session `cd ../..` straight past it. Requiring the match costs no legitimate caller: only
    sessions run these commands, and the protocol launches them with cwd in their worktree.
    *What the check is, plainly.* It closes the plain path and the accident — a forged or stale
    variable run from wherever the session happens to be. It does not stop an impersonator who
    also changes directory: a session that `cd`s into the victim's worktree with the victim's
    id exported passes either form of the check, since from inside that worktree it is
    indistinguishable from the victim. That is decision 27's ceiling, and a sandbox that keeps
    a session out of other worktrees is the instrument for it, not a fourth read of cwd.
    *`pup merge` is operator-only, not only `--pr`.* The gate's verdict moves another session's
    branch — merged, or rejected and parked `blocked` by decision 7's cap — so the guard
    decision 26 put on `--pr` now fronts the whole command, one `callingSession` check where
    there were two paths. Decision 27's "the ledger names the real acceptor" collapses into
    it: the acceptor is `human` because only an operator reaches the ledger, and a session
    that evades the guard evades the attribution too, which was already true of the dynamic
    value. The `--pr` test became a pair over the plain and `--pr` paths; the test that a
    session's `--accept-debt` was attributed to it is gone, since that path no longer exists.
    *`pup respawn` is operator-only, and readiness needs a request.* `respawn` was unguarded,
    and its precondition was self-satisfiable: `isHandoffReady` floored the last request steer
    to `0` with `COALESCE`, so a `handoff_ready` event nobody asked for made a session ready.
    A session could write another session's `handoff.md`, run `pup session handoff-done` with
    the victim's id, and `pup respawn` it — kicking the victim off on attacker-authored
    context without a single steer on record. The command refuses a calling session, and
    readiness now requires a real `handoff-request` steer: with none the subquery is NULL and
    the comparison is never true. `pup kill --respawn` is unaffected; it never needed one.
    *Proof by removal.* Each guard has one test that fails when the guard is deleted — the
    worktree cross-check (both protocol commands), the `merge` guard on the plain and `--pr`
    paths, the `respawn` guard, and the `COALESCE` floor put back — run against the mutated
    source before this landed.
    *`callingSession` counts any declared id.* It counted `PUP_SESSION_ID` only when the id
    named a session that exists, so the ledger's acceptor could not be written to arbitrary
    text; with the acceptor the constant `human`, that reason is gone, and the rule it left
    behind was a hole — `PUP_SESSION_ID=does-not-exist` from the repo root ran `pup merge` and
    `pup respawn` as an operator. A variable naming no session is a session that changed it,
    and refuses. The protocol commands still check the id exists, so a bogus one is refused
    with a message rather than the store's raw throw.
    *What this leaves open.* `pup steer` and `pup interrupt` are still session-callable, each a
    prompt or an Escape into another agent's window, and `pup audit --sweep` still reaches
    `createSession` from inside a session; each is the same close as this one and its own
    change. **Handoff file integrity** is open too: a session's `handoff.md` under the store's
    sessions dir is writable by any session, and nothing records or verifies who wrote it, so
    an operator's `pup respawn <victim>` still delivers attacker-authored context if the file
    is overwritten between the victim's `handoff-done` and the `respawnSession` read —
    `awaitHandoffReady` polls every 5 s, which is the window. Its own change, planned in the
    backlog. The detection stays decision 27's best effort: a session that leaves its worktree
    and unsets `PUP_SESSION_ID` passes the operator-only commands as an operator, and one that
    enters the victim's worktree with the victim's id passes the protocol commands as the
    victim; a sandbox is a different instrument.

45. **A steer is submitted only once the pane shows it whole, and never in part (2026-09-06).**
    `steerSession` pasted through `tmux paste-buffer`, slept 700 ms, and pressed Enter. Twice
    on 2026-09-05 a 1.5–1.7 KB operator steer reached the agent as its tail alone — one as the
    four characters `ath.`, one starting mid-word — while steers under ~900 chars arrived
    whole; and on 2026-09-06 a session opened saying its prompt carried only the session
    protocol, which is the last section of the compiled context. That is the same failure on
    the first prompt of every session: `kickoff` delivers the context through the same call.
    Reproduced against a scratch Claude Code 2.1.263 pane with a 1.8 KB message: the agent
    received `19 tok120 … LASTWORD`, the head gone.
    *Two causes, two fixes.* First, the paste was not bracketed. The pty hands the text to the
    UI in ~1 KB reads, and without bracket marks the UI takes each read as its own paste —
    three placeholders for 3000 chars, `[Pasted text #1][Pasted text #2][Pasted text #3]`
    — and an Enter timed between them submits whatever had folded. `paste-buffer -p`
    wraps the whole buffer in the bracket marks, and the UI then folds it as one paste:
    fifteen of fifteen trials, 3 KB single-line and 19 KB over 150 lines, one placeholder
    each within 100 ms. Second, a fixed settle is a guess about ingestion time, and the guess
    was wrong at 1.5 KB. Enter now waits for `capturePane` to show the message whole, one
    settle per KB of message and never fewer than five — the first cut gave a one-line steer
    two settles, 1.4 s on a machine an audit pushes past a load of 60, which the security
    review named as a refusal mode of its own — and is never sent otherwise.
    *What "whole" can mean through a pane.* The UI folds any paste over ~800 chars, or over
    a couple of lines, into `[Pasted text #N]`, with `+L lines` where L is the newline count,
    so the words are unreadable and the count is the one thing to check; a shorter paste
    renders inline, and must begin with the message's first word and end with its last, in
    the box's last column-0 `❯` block — a submitted prompt is echoed above the box under the
    same glyph. `pasteLanded` in `pane.utils.ts` is that rule, pure over the capture, with the
    live panes as fixtures: the tail-only box of the reproduction, and `row one[Pasted text
    #33]`, a paste appended to a draft the box already held, which the first cut of this
    change met in the wild and rightly refused. The box is cleared before pasting for that
    reason, and cleared again on refusal: Ctrl-U takes one row per press, so clearing is a
    bounded loop of presses, each checked against the pane, and a box the budget cannot
    empty is its own refusal — the error says the box held text Ctrl-U could not clear and
    nothing was pasted, rather than the never-landed text, which would send the operator
    looking at the paste instead of at the box.
    *Refusal is an exit, not an event.* A paste that never shows whole raises
    `SteerNotDeliveredError`, named and carrying the session and the length; `pup steer`,
    `pup interrupt`, `pup launch`, `pup new`, `pup respawn` and `pup audit --sweep` print it
    and exit 1, and no `steer` event is written, since nothing was steered. `pup interrupt`
    still records its interrupt, because Escape had landed; `pup respawn` adds the re-run
    line. A launch whose kickoff is refused is rolled back, not left: `startSession` throws
    after the task is claimed, the row is `running` and the window is open, so the first cut
    left a claimed task (a re-launch raised `TaskAlreadyClaimedError`), an empty window and no
    kickoff or `scope_overlap` event behind a message that read as benign — the security
    review's finding 2. `session-lifecycle` is outside this change's scope, so `pup launch`,
    `pup new` and `pup audit --sweep` catch the error, which carries the session id, and call
    `killSession` on it: the window goes, the row is `killed`, the task returns to the backlog
    (decision 40), and the two lines printed say the launch was rolled back and which command
    to re-run. The operator sees a failed launch rather than an agent working from the tail
    of its task — the alternative, a `delivered:false` event and a "Launched" line, is what
    let the truncated kickoffs pass as started. `merge-gate` already treated a throwing
    re-steer as a blocked session, and now does so for this one too, under its existing
    reason `session unreachable`, which is now the wrong reason for a refused paste; the
    gate is outside this change's scope, and its own reason is a small later change.
    *Verified in vivo, then by removal.* The fixed path delivered the 1.8 KB reproduction whole
    (`FIRST=FIRSTWORD LAST=LASTWORD TOKENS=230` from the agent). The runtime suite drives the
    real `execFileSync` at a `tmux` script on PATH that logs its argv and plays the input box
    (the testing convention for `gh`): a 3000-char steer's log shows two settles ending in a
    tail, one ending in the placeholder, and only then Enter; a never-landing one shows the
    scaled settle count, Ctrl-U, and no Enter; the kickoff cases show the `+802 lines`
    placeholder before Enter and the throw. The fake clears one row per Ctrl-U, as the UI
    does, so the press loop is exercised, and it can be pinned stuck for the box-not-cleared
    case. Deleting the verification, the `-p`, the pre-paste clear, the settle floor, the
    clear's return check, or any one command's rollback fails a named test each.
    *What this leaves open.* **The guarantee holds for the pane the target resolves to.**
    `tmuxTarget` builds `=pup-<id>:`, a session target, which tmux resolves to the session's
    *active* pane, and the agent has `$TMUX`: the security review verified that one
    `tmux split-window` from inside the session moved `capture-pane`, `paste-buffer` and
    `send-keys` to the new pane, and `pasteLanded` returned true for the capture there. An
    agent that splits its window can therefore receive an operator's steer in a shell of its
    own and have Enter run it — a finding that predates this change and is not fixed by it.
    The fix is to pin the pane, not the session: capture the pane id at launch
    (`new-session -P -F '#{pane_id}'`), store it as `tmux_target`, and address every later
    command to it; its own change, planned in the backlog. **Denial of steering.** The clear
    is fail-safe, so an agent that keeps one character in its box makes every steer, handoff
    request and respawn refuse; the refusal is loud and names the box, and the pane pin above
    does not close it. A sandbox that keeps the agent's hands off its own window is the
    instrument, as decision 44 said of cwd. The check also inherits the pane's rendering
    rules: a word wider than the pane wraps mid-way and an inline paste of it is refused, and
    a future UI that changes the placeholder text refuses every folded paste until
    `pane.utils.ts` learns the new form — loud, on the first steer, which is the right side to
    fail on. A steer refused mid-turn leaves the session running untouched; the operator
    re-runs it.

    *Addendum, 2026-09-12: what the box suggests is not what the user typed.* The first
    operator steer after this decision merged was refused with box-not-cleared, and so was
    every steer, handoff request and gate re-steer to a session that had finished a turn:
    the driving loop was blocked on it. Nothing was in the box. Claude Code 2.1.263 offers a
    prompt of its own there once a turn ends — the capture read `❯ run the security review on
    this branch` — and the offer is not text: Escape does not dismiss it and Ctrl-U does not
    clear it, so `hasUnsubmittedInput` read a draft and `steerPane` spent all 64 presses on an
    empty box. The `Try "…"` hint was already known and matched by its prefix; a suggestion
    has no prefix to match, and matching its words would be matching the operator's own steers.
    *Dim is the discriminator, and only `-e` shows it.* Both are one thing: the box's ghost
    text, which Claude Code renders dim (SGR 2) where typed and pasted text carry no dim at
    all. Verified live on 2.1.269 by capturing the same box in each state: the hint is
    `\u001b[39m❯\u00a0\u001b[2mTry "how does <filepath> work?"\u001b[0m`, a typed draft is
    `\u001b[39m❯\u00a0draft text`, and a folded paste's `[Pasted text #1]` is undimmed too —
    which matters, since blanking it would have made every landed paste read as empty. So the
    four looks at the input box now take `capture-pane -e`, `pane.utils.ts` blanks every dim
    run before reading the box, and a box left with nothing else is empty. `waitUntilReady`
    keeps the plain capture: its marker carries no styling and escapes would only hide it.
    Two things the parser has to get right, both shapes the real capture produces: tmux emits
    only the attribute *changes*, so dim carries from one row to the next and the whole
    capture is scanned in order, not from the prompt down; and a 256-colour parameter has to
    be skipped whole, or `38;5;2` reads as dim and `38;5;22` as a reset. Ghost-completion
    falls out of the same rule — a typed head stands, the suggested tail is blanked. The
    hint's prefix stays as the fallback for a capture with no styling to read, and the fake
    tmux now renders a suggestion dim under `-e` and bare without it: the test that drops the
    flag on its way to the fake spends the 64 presses again, which is what makes `-e`
    load-bearing rather than incidental.
    *What this leaves open.* **The suggestion could not be reproduced on demand.** Neither
    2.1.263 nor 2.1.269 offered one across five probe turns on 2026-09-12, so the fixture's
    styling and non-breaking space are a verbatim live capture of the hint that shares the
    slot, and only its text is the one captured on 2026-09-06. A paste does replace a
    suggestion — the 2026-09-06 sighting recorded that typing replaces it and Ctrl-U brings
    it back, which is the hint's behaviour and the reason the pre-clear was the only thing in
    the way. Had it appended instead, the box would not begin with the message's first word
    and `pasteLanded` would refuse it as never-landed rather than submit it in part, so the
    steer fails loudly either way. **A suggestion is still a way to deny steering**, as a
    held character was: one the agent cannot choose, and the refusal names the box either
    way. **The socket is unaffected** — decision 47's peer messages never touch the input
    box, and whether a suggestion affects a message-started turn is still open there.

    *Addendum, 2026-09-12: the gate's own report, and the reason a refused one leaves behind.*
    The merge gate steers its report at a rejected session, and this decision gave it a second
    way to fail that its one reason did not describe. Live on 2026-09-12, session
    `t-mtycrep1`: the test stage failed, vitest had coloured its output, and the detail reached
    `formatGateReport` as 2000 characters of raw SGR. A pane shows an escape as what it does,
    never as the bytes that were sent, so `pasteLanded` could not match the paste, the steer
    was refused, and `runMergeGate`'s bare `catch` parked the session as
    `re-steer failed — session unreachable` — while its pane sat there alive with an empty box.
    Both halves were wrong: the report should not have carried escapes, and the reason sent
    the human to look for a window that was never gone.
    *Plain at the producer, not over the finished report.* `plainDetail` drops CSI sequences
    and sweeps the remaining control characters to spaces, keeping newlines — the scope audit
    puts a path on each — and the full `GATE_OUTPUT_TAIL_CHARS`, which is what makes it a
    sibling of decision 29's `sanitizeReason` rather than that function itself. It is applied
    in `commandFailureDetail`, where a gate command's output is captured, and the tail is cut
    after the strip so the cut cannot land mid-escape and leave its parameters as text. That
    site rather than `formatGateReport` because it covers every reader — the stored stages,
    the PR body, and the operator's own `printGateReport`, which prints details raw and lives
    in the CLI, outside this change's scope — and because it is the only route an escape
    takes into a stage that steers: git C-quotes a control byte in a pathname whatever
    `core.quotePath` says (checked, not assumed), `quotePath` already sanitizes the scope
    audit's, and an adapter's own text reaches flagged stages only, which are refused and
    never steered. A guard over the formatter would have been a branch no test could reach.
    *The refusal is its own reason.* `SteerNotDeliveredError` is caught apart from everything
    else and its message — the session, the character count, and which of the two refusals it
    was — is recorded as the blocked reason; every other throw keeps `session unreachable`.
    The two ask for different hands: a refused paste leaves a reachable session with an empty
    box and an agent still working from its last turn, a gone window leaves nothing to type
    into at all.
    *Verified by removal.* Three mutations, one named test each: dropping the strip leaves the
    steer carrying `\u001b`, collapsing the two arms into the message blocks an unreachable
    session with `no tmux session` as its reason, and collapsing them into the old string
    blocks a refused paste as `unreachable`.
    *What this leaves open.* **Nothing reads the reason back.** It is written to the
    `gate_result` event payload, which is where the old one went too, and no surface prints
    it: `pup status` shows `needs a human (N rejections)`, the review detail and the session
    dossier show neither. So the better reason is only reachable through the store until a CLI
    change surfaces it, and that is outside this change's scope. **`blocked` is a one-way
    door.** Nothing transitions a session back to `running` — `pup respawn` and
    `pup kill --respawn` both refuse anything that is not already running — so the operator's
    only move on a blocked session is `pup kill`, which returns its task to the backlog and
    throws away a context window that may be one steer from done. That was tolerable while
    blocked meant the reject cap or a dead window; a refused paste now parks a live session
    whose box is empty, which is exactly the case where typing the report in by hand and
    letting it run is the right answer. An `unblock` that re-steers and transitions
    `blocked -> running` — the state machine already allows the edge — deserves its own change.
    *Both are closed by decision 7's addendum (2026-09-12): `pup unblock` prints the reason it
    was parked for and lifts the parking. It steers nothing, for the reason recorded there.*

46. **Every command that types into or reads a session goes to the pane recorded at launch,
    never to the session (2026-09-06).** `tmuxTarget` built `=pup-<id>:`, a session target,
    which tmux resolves to the session's *active* pane, and the agent holds `$TMUX`: decision
    45's security review verified that one `tmux split-window` from inside the session moved
    `capture-pane`, `paste-buffer` and `send-keys` to the new pane — a shell of the agent's own
    — where `pasteLanded` read the operator's steer as landed and Enter ran it, while `pup`
    printed `Steered` and wrote a `steer` event. Re-verified here on tmux 3.7b before the fix:
    a split moves the active pane; a pane id (`%N`) addressed after a `swap-pane` still reaches
    the same process; `kill-session -t %N` kills the session holding that pane after a
    `rename-session` that the pinned name no longer finds.
    *Pin the pane, mint it once.* `new-session -d -P -F '#{pane_id}'` prints the id of the
    pane it opened, and `launchSession` returns it as a `SessionPane` (`sessionId`,
    `paneId`); the id is checked where it is minted, so a launch whose tmux printed anything
    else fails there rather than late. `startSession` and the respawn paths store it in
    `sessions.tmux_target` — the column existed and held the session name — before the
    kickoff types into it. `steerPane`, `interruptPane`, `kickoff` and `capturePane` take the
    pane, and `paneTarget` is the single place a `-t` is formed for anything that types or
    reads: a value that is not `%N` is refused there, never passed to tmux, where a bare name
    would resolve to the active pane. A pane id is server-unique and never reissued, so a
    split, a swap or a rename cannot move it, and there is no fallback from a pane to a name
    anywhere. `pinned()` remains for the two commands that address a session by name and
    nothing else: the stale-name kill before `new-session`, and `killSession`, which now
    kills by pane first (so a renamed window does not run on under a name the kill cannot
    find) and by pinned name second (for a row whose pane was never recorded, and for the
    panes a split left in the session).
    *A missing pane is a refusal, not a redirect.* `SessionPaneMissingError` names the session
    and the pane, and nothing is sent: a row with no pane recorded (a launch that failed before
    its update) refuses in `sessionPane`; a row whose `tmux_target` is not a pane id — every
    session launched before this change holds its name there — refuses in `paneTarget` and
    says to respawn it, which mints a pane; a pane tmux reports gone, or a dead server, is
    tmux's own can't-find-pane or error-connecting line turned into the same error by `tmuxAt`,
    which pipes stderr so the operator reads the refusal and not tmux's. The session half of
    the runtime moved into `session-lifecycle`: `sessionPane(row)`, `steerSession(db, id,
    message)` and `interruptSession(db, id)` resolve the row and hand its pane to the runtime,
    the shape `killSession(db, id)` already had; `requestHandoff` and the respawns use the row
    they hold.
    *Verified by the fake, and by reverting.* The runtime suite's `tmux` script now models
    panes the way tmux resolves `-t`: a pane id names that pane and must exist, anything else
    resolves to whichever pane is active, and each pane keeps what was pasted or keyed into
    it. The discriminating case splits from inside — pane 9 becomes active — and asserts the
    steer and its Enter reached pane 3 and nothing reached pane 9; with `paneTarget` reverted
    to the session form the paste and Enter land in pane 9 and the test fails, which is the
    finding reproduced. A killed launch pane refuses with the named error after one capture,
    and a dead server refuses the same way; a legacy name refuses before any tmux call. The
    lifecycle and handoff suites assert the stored pane, the kickoff's pane, the kill's pane
    and the refusals through the mocked runtime.
    *Every caller goes through the store.* `pup steer` and `pup interrupt` call
    `steerSession(db, id, message)` and `interruptSession(db, id)` from `session-lifecycle`,
    as does the merge gate's rejection re-steer, and the merge's kill passes the row's pane
    beside the name; the runtime no longer exports a session-addressed steer, so there is no
    name-addressed path left for a caller to fall back on. Where a refusal is printed,
    `SessionPaneMissingError` is caught beside `SteerNotDeliveredError` and nothing is
    recorded: a steer refused for a gone pane writes no `steer` event, an interrupt refused
    before Escape writes no `interrupt` event, a launch whose window died under its kickoff
    is rolled back the way a refused kickoff is, and `pup respawn` points a gone pane at
    `pup kill --respawn` rather than a re-run that has no pane to ask. The gate parks a
    session with no pane recorded as blocked, as it does any re-steer it cannot deliver.
    *What this leaves open.* **The store is the root of trust.** The pane pin closes the tmux
    path; an agent that edits `sessions.tmux_target` in the store, which its shell can reach,
    points a steer wherever it likes, as it could already write any row. The sandbox that
    keeps the agent's hands off its own window and store is the instrument, as decisions 44
    and 45 said. **A move across sessions.** `swap-pane`, `join-pane`, `break-pane -t` and
    `move-pane` between two pup sessions each carry the launch pane into a sibling's window;
    steers still reach it, and a kill by pane then kills the sibling's session around it.
    With `join-pane` the source session is emptied and tmux destroys it itself, so the
    name-kill that follows finds nothing and only the sibling dies (verified on tmux 3.7b:
    `join-pane -s %0 -t =pupB:` then `kill-session -t %0` killed B). Nothing in the
    split-only threat model does this, and the pane-first kill is still the right order:
    without it a rename leaves the window running. **Denial of steering** stands as
    decision 45 left it.

47. **A conductor session is the operator's delegate for everything but the merge, and every
    session is addressable by its peer name (2026-09-12).** The loop the operator runs by hand
    — `pup status`, launch a task, wait for the session to go idle, steer it with evidence,
    read the branch, hand it to review — is one a model can run, and on a larger model than the
    sessions it drives (Fable conducting Opus sessions). Subagents inside one session were the
    alternative and lose what a session has: its own worktree, branch, scope hook, events and
    gate. So `pup conductor [--model <m>] [--worker-model <m>]` opens one Claude Code window
    per project, the conductor, and `pup conductor stop` closes it.
    *Every session launches with `--name pup-<id>`.* Claude Code's cross-session messaging
    (ListAgents, SendMessage; on by default since 2.1.224) lists a session under its display
    name, so the name is the tmux name: the id `pup status` prints and the operator attaches
    to is the one a peer addresses. The peer socket is the better steer transport — a message
    lands whole and queues until the current tool call ends, where the input box has decision
    45's paste cliff and the dim suggested prompt that refuses every post-turn steer — and
    `notify_when_idle` is a one-shot "finished its turn" where the operator polled
    `events.jsonl`. pupitre never speaks the socket protocol, which is undocumented; the
    conductor does, with its own tools. Decision 1 stands: tmux is pupitre's transport, and
    `pup steer` still types.
    *What the conductor is.* Not a session: no task, worktree, branch or row. An interactive
    `claude` in tmux named `pup-conductor-<project id>`, cwd the main checkout, bypass
    permissions and user setting sources like a session, and a compiled profile under
    `~/.pupitre/<id>/conductor/compiled` whose PreToolUse hooks refuse every Edit and Write
    and guard `.claude/` in shell — no scope files, no event hook, since it has no scope to
    enforce and no row for events to land on. `PUP_CONDUCTOR=<project id>` is exported in
    place of `PUP_SESSION_ID`; the guards tell the two apart by which variable is set, and
    tmux's `-e` sets the window's environment, not the server's, so the variable does not
    reach the sessions it launches. Its kickoff is a compiled context: the commands it may
    run, the peer protocol, the refusals, and the protocol — one session per backlog task,
    subscribe for idle, steer with the exact unmet criterion, report and stop.
    *The tier.* A session is refused `plan add|drop|edit`, `new`, `launch`, `kill`, `merge`,
    `respawn` and `--project` (decisions 40, 42, 43, 44). The conductor is allowed the first
    four and `steer`, `interrupt`, `status`, `review`, `debt`, `log`; it is refused `merge`,
    `respawn`, `kill --respawn`, `debt close`, `--project` and `pup conductor` itself. The
    operator has everything. The merge stays with the operator because the verdict moves a
    branch onto main and the human is the reviewer — the product is the operator's
    understanding, not throughput, and a conductor that merged would be a session merging
    sessions under another name. The respawn stays because its kickoff quotes a handoff any
    window with a shell in the store can write (decision 44) — and so does `kill --respawn`,
    whose kickoff is the `context.md` under the store's compiled dir, the same directory; the
    security review found the plain `kill` guard covering it and the conductor walking through.
    `debt close` was guarded for nobody; a session or a conductor retiring an entry erases the
    operator's own overdue-debt reminder, so it is operator-only now for both. A session or a
    conductor minting a conductor is refused for the same reason a session cannot launch: it
    would hold every launch and kill under a name that is not its own.
    *Attribution, not prohibition.* Decision 40 refused a session-authored spec because it
    would carry `origin='human'` — the operator's attribution on a prompt the operator never
    wrote. A conductor-authored task carries `origin='conductor'`: the CHECK on `tasks.origin`
    gains the value, and a store from before it is rebuilt once on open — `tasks_rebuilt`
    with the current constraint, rows and ids copied, the swap done with foreign keys off
    because `sessions.task_id` names the table by a name that is gone between the drop and
    the rename, and `foreign_key_check` empty after (verified on better-sqlite3 13 before the
    migration was written). The rebuild is tolerated like the drop migration: a lock fails it
    and the next open retries. An overlap the conductor waves through is recorded
    `via: 'conductor'`, so `scope_overlap` names who answered for it. A steer delivered by
    message never touches `pup`, so `pup steer <session> --sent "<message>"` records it —
    `{kind: 'message', by}`, nothing typed, where `by` is `session:<id>` for a session pup can
    identify before it is the conductor's or the operator's word (decision 44's order: a
    session that exports `PUP_CONDUCTOR` is still the session) — because without it the
    dossier's timeline showed a session corrected by nobody, and `isHandoffReady`'s last-steer
    query would not see a request that went by message; the dossier prints the sender. The
    origin is shown where the operator decides, not only in the report: `pup plan` and the
    `planned` rows of `pup status` carry `(from conductor)`, since the loop the operator runs
    is status, review, merge, and the report is none of those.
    *Verified.* The runtime spawns the conductor's window with the name, `PUP_CONDUCTOR`, no
    `PUP_SESSION_ID`, and the checkout as cwd; the compiled hooks are executed under `sh` and
    the edit block refuses every path; the CLI suite drives each tier through every guard — a
    session and a conductor are refused `pup conductor`, the conductor launches with
    `overlapVia`, plans with `origin`, kills, and is refused the merge, the respawn and
    `--project` with a message that says who merges; the migration runs against a store
    rebuilt to the old CHECK with a session referencing its task, and the row, the foreign
    key and idempotence are asserted.
    *What this leaves open.* **The conductor is the highest-privilege agent in the system.**
    Bypass permissions in the main checkout: the edit hook stops Edit and Write, the bash
    guard stops shell writes into `.claude/`, and nothing stops `git commit` or `git push`
    from the root — one Bash call. Remote branch protection and a sandbox are the
    instruments, not another grep. **Any session can reach the conductor, by two channels.**
    The peer socket namespace is per OS user, so a session's SendMessage into the conductor
    is one injection path; the tier bounds what it can be talked into — a plan, a launch, a
    kill, each recorded as the conductor's own, never a merge — and the context says a
    session's message is a report. Claude Code's `crossSessionInbound: hold` on the
    conductor's settings would put the operator on every such message, at the cost of the
    automation; not set, and worth a flag if the injection is ever seen live. The stronger
    channel is tmux itself: the conductor's window is on the default server every session
    holds `$TMUX` for, under a name any session can compute from the repo path, so one
    `tmux send-keys -t =pup-conductor-<id>:` from a session lands in the conductor's input box
    as if the operator had typed it — no "report, not instruction" rule applies to a keystroke
    — and `capture-pane` reads its whole transcript. The close is a separate tmux socket for
    the conductor (`-L`), which has to be threaded through spawn, kill, probe and the kickoff's
    paste path, and `pup launch` run from inside it must then put sessions back on the default
    socket, since `$TMUX` in the conductor's pane would select its own. Its own change,
    planned in the backlog; until it lands, the conductor is as reachable by a session as a
    sibling session is (decision 46's cross-session moves), with more to lose. **`--sent` is
    the caller's word past what pup can see.** A shell that unsets both variables writes the
    event as the operator; the record is honest when the caller is, decision 27's best
    effort. **Conductor-authored scope is unconstrained.** `assertPlannableSpec` refuses an
    empty scope and control characters, nothing else, so a conductor talked into `--scope
    '**/*'` launches a session whose hook allows every path but `.claude/`; the origin marker
    is what the operator has, and a scope floor for agent-authored specs is a design question
    left open. **Killed by name.** No pane is pinned
    for the conductor (nothing types into it after its kickoff), so `pup conductor stop` is
    the name-only kill decision 46 describes, and a rename from inside survives it. **Open as
    before:** `pup audit` and `--sweep` are reachable by the conductor as by a session
    (backlog t-mtnhzcng). **Unverified live:** whether a message that starts a new turn fires
    the Stop and PostToolUse hooks the way a typed prompt does — decision 2's activity
    classification may lag a message-driven turn — and whether the dim suggested prompt
    affects a message-started turn at all. The first live conductor run answers both.
    *Addendum, 2026-09-12: the conductor's own duplication, folded.* Three merges landing the
    conductor and the pane pin took duplication 74 -> 88 -> 106 -> 124, each increase accepted
    as debt or merged outside the gate (ledger #10, #12). The clones were the shapes this
    decision multiplied, not accidents: every tier guard is the same
    `console.error` + `process.exitCode = 1` + `return`, every launch path the same
    roll-back-a-refused-kickoff-then-print-the-window tail, and the conductor's window the same
    trust-resolve-spawn as a session's. So each is one place now — `refuse(message)` for every
    refusal, `launchOrRefuse` + `reportLaunched` for `new`, `launch` and `--sweep`, and
    `spawnClaudeWindow` for both windows, whose only difference is the cwd and the one variable
    that names the caller. `rollBackRefusedLaunch` keeps the order both rollbacks need — the
    refusal first, so an `undo` that throws cannot hide why the launch failed — and takes the
    undo and its sentence from the caller, because a session's rollback kills a session and the
    conductor's kills a window. Every message is unchanged, so no test moved with them.
    *What did not get folded, and why.* `startConductor` and `startSession` share a
    compile-write-launch-kickoff shape, but `startSession` interleaves the worktree, the branch
    and three store writes between those steps in an order it needs (decision 40), and lives
    outside this task's scope; a helper spanning them would be a shape, not a behaviour. The
    measured clone the gate had actually flagged there was between the production
    `new-session` argv and the three test sites spelling it out, which is now one `spawnPrefix`
    helper in the test. *Verified.* The duplication capability the merge gate runs, pointed at
    the branch, reports 62 duplicated lines in 6 blocks against main's 124 in 11; every block
    left is outside this change. The full suite passes unchanged but for that argv expectation
    and one stub: `PUP_CONDUCTOR` now joins `PUP_SESSION_ID` at `''` in the CLI suite's
    `beforeEach`, because a suite run from inside the conductor's own tmux inherits the
    variable and 37 project-resolution tests then fail on a guard that is working correctly.
    *Addendum, 2026-09-12: the conductor's own tmux socket.* The stronger of the two channels
    above is closed: the conductor's window opens on `-L pup-conductor-<project id>`, a server
    of its own, and the flag is threaded through the launch, the stale-name kill before it,
    `pup conductor stop`, the running probe, and the kickoff — the pane the launch returns
    carries its socket, so every `load-buffer`, `paste-buffer`, `send-keys` and `capture-pane`
    of the paste path names the same server. A socket is not a name to guess past: a client
    asks one server and is told nothing about any other, so the `send-keys` and `capture-pane`
    a session could aim at a computable window name now answer `can't find session` (verified
    on tmux 3.7b against a throwaway socket). The window also leaves the server a session's
    own `kill-server` or decision 46's cross-session pane moves can reach.
    *The other half is `$TMUX`.* tmux takes its socket from `-L`, and only then from `$TMUX`,
    and only then from the label `default` — so `pup launch` run in the conductor's pane, which
    is where the conductor runs it, would have opened the session on the conductor's own server,
    back inside `send-keys` reach. Every tmux call in the runtime now drops `$TMUX` from the
    environment it hands the client, which leaves it at `default`: the conductor names its
    server with `-L`, everything else means the operator's, and no call inherits which one.
    `PUP_CONDUCTOR` and `PUP_SESSION_ID` are dropped with it, because tmux copies the
    environment of the client that STARTS a server into that server's GLOBAL environment, and
    every window opened on it afterwards inherits that — verified: a server first started by a
    client carrying `PUP_CONDUCTOR=probe-value` handed the variable to a second window that was
    launched with no `-e` and from an environment without it. A default server first started by
    a launch from the conductor's pane would have minted sessions that read as the conductor to
    every guard. What a window is, its own `-e` says, and nothing else.
    *And the security review found the rest of that environment worse than the two variables.*
    `pup launch` from the conductor's Bash starts the default server whenever the operator has
    no tmux up, and a tool shell carries `CLAUDE_CODE_MESSAGING_SOCKET` and
    `CLAUDE_CODE_MESSAGING_TOKEN` — the peer channel's credentials — along with
    `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE` and `CLAUDE_CODE_EXECPATH`. A server's global
    environment is readable by ANY client of that server (`show-environment -g`), so a session
    could have read the conductor's peer credentials off the server it was launched on and
    spoken the channel AS the conductor, past the tier entirely. The scrub is patterns now, not
    three names: `TMUX`, `PUP_CONDUCTOR`, `PUP_SESSION_ID`, `^CLAUDE`, `^ANTHROPIC_` and
    `NODE_OPTIONS` — the last because `--require` in a server's environment is code execution in
    every node process a window later starts. `PATH`, `HOME`, `TERM`, `SHELL`, `LANG` and
    `TMUX_TMPDIR` pass through; tmux needs the last to find its own socket.
    *The conductor's server is killed whole before its window opens.* The stale-name kill was a
    `kill-session`, which leaves the SERVER up — and whoever started a server owns its global
    environment. The socket label is as computable as the window name, so a session could
    pre-start a server on it carrying `NODE_OPTIONS=--require`, and the conductor's `claude`
    would inherit that at spawn: the isolation would have handed the attacker the window it was
    built to protect. `launchConductor` now runs `kill-server` on its socket first, so the
    conductor always opens on a server this process started, with the environment above.
    `pup conductor stop` keeps the name-pinned kills, which is what a leftover needs.
    *One field to distrust.* `ConductorHandle.paneId` is a `%N` with its server stripped off; a
    pane id is only meaningful together with its socket, and a future caller that passed this one
    to a default-socket kill would kill whatever pane wears that id there — a session's. Nothing
    reads the field today, and whatever does should take the socket with it.
    *Two smaller consequences.* `pup conductor stop` kills the pinned name on the conductor's
    socket AND on the default one, where nothing pup runs wears that name: what is there is a
    window from before this split, or one a session minted to look like the conductor. The
    probe is not symmetric — `isConductorRunning` asks only the conductor's socket, because a
    window on the default server is not the conductor and answering for one would report a
    conductor that is not there. It is no forgery defence: the conductor's socket is reachable
    by anything running as the same user, so a window minted on it passes the probe, and
    `pup status`'s conductor line stays the tmux server's word at decision 27's ceiling, like
    every other env-declared fact. And the attach is printed with its socket now
    (`tmux -L pup-conductor-<id> attach -t pup-conductor-<id>`), since a bare `tmux attach -t`
    no longer finds the window — in `pup conductor`, which is operator-only, and in
    `pup status` only when neither `PUP_SESSION_ID` nor `PUP_CONDUCTOR` is set: the operator is
    the only caller that attaches, and pup should not be the thing that hands a session the
    socket the conductor lives on. A session can still compute the label, as it could the name;
    not printing it is the same best effort as the rest.
    *Verified.* The suite's fake tmux models servers, not just panes: a leading `-L` selects a
    state directory, and a socket with no directory fails the way a socket with no server does.
    The conductor's launch, its stale-name kill, its kill, its probe and every command of its
    kickoff carry the flag; a steer and a kickoff addressed to the conductor's pane by a client
    with no `-L` raise `SessionPaneMissingError` and type nothing, on either server; a session
    launched with `$TMUX` naming the conductor's socket and `PUP_CONDUCTOR` set carries no
    `-L`, and no tmux call of that launch sees `TMUX`, `PUP_CONDUCTOR` or `PUP_SESSION_ID`,
    while the window's own `-e` still says `PUP_SESSION_ID=<id>`; a launch whose environment
    holds the messaging token, the session id, `CLAUDECODE`, an `ANTHROPIC_API_KEY` and a
    `NODE_OPTIONS=--require` hands tmux none of them and `TMUX_TMPDIR` and `HOME` unchanged; the
    conductor's launch kills its whole server before the stale-name kill and the spawn; and
    `pup status` prints the attach line to the operator and the bare `conductor running` to a
    session and to the conductor.
    *What this leaves open.* **The OS user is still the boundary.** Socket files live in
    `$TMUX_TMPDIR/tmux-<uid>/`, a directory the user owns and can list, so a session that
    thinks of it reaches the conductor with `tmux -L pup-conductor-<id> send-keys` as before —
    the label is as computable as the name was, and no label is secret from a shell running as
    the same user. What the split closes is the whole default-socket surface: the tool that
    inherits `$TMUX` and addresses a name, the stray keystroke, the transcript read from the
    server the session is already attached to, `kill-server`, and the pane moves decision 46
    describes. The sandbox is still the instrument for the rest, as decisions 44 and 45 said,
    and this is the same OS-user boundary the peer socket has — which is untouched: a session's
    SendMessage into the conductor remains the injection path the tier bounds. **Killed by name**
    stands: no pane is pinned for the conductor, so a rename from inside still survives
    `pup conductor stop`, now on a server the operator reaches only with `-L`.

48. **`pup audit` is operator-only: the thing that moves the bar is not the thing being
    judged (2026-09-12).** Decision 39 wrote the rule down — a baseline is re-stamped from the
    trusted checkout by `pup audit`, never from the worktree under judgement — and then left the
    command that does the stamping open to the worktree, which the security review raised on
    PR #61 and deferred as pre-existing. It was reachable in one Bash call: a session's launch
    exports `PUP_BIN`, and `node "$PUP_BIN" audit` is not a write pattern, so decision 6's scope
    layer passes it; `auditProject` then calls `initProject`, which writes the fresh measurement
    onto the project row as the new floor. In `--pr` mode — this repo's own workflow — that is
    not one path to moving the bar but the only one, since a PR merge never ratchets
    (decision 26). So the session whose duplication the next gate compares could measure main at
    a moment of its choosing, stamp the answer, and pass on the slack: no flag, no
    `--accept-debt`, no ledger entry — the silent permanent write-off decision 39's rule stamp
    exists to prevent, reached through the command rather than through the rule id.
    *The guard is decision 26's, unchanged in shape:* `callingSession(db)` refuses before
    anything measures, one line and exit 1 — "`pup audit` is operator-only; sessions cannot move
    the baseline." It covers `--sweep` on its own account: a sweep mints a task and launches a
    session for it with `allowOverlap: true`, so an open `--sweep` was a launch past decision
    42's guard and past decision 41's overlap refusal at once. The test is discriminating on the
    write, not only on the message — the project row's baseline is still null after the refusal,
    so removing the guard fails it by stamping.
    *What is not guarded, and why.* The conductor still audits. It runs in the main checkout,
    which is the trusted checkout the rule names; it holds no branch the baseline judges; and it
    may already plan and launch (decision 47), so refusing it would buy nothing the rule cares
    about. The ceiling is decision 27's, as for every guard of this family: a session that `cd`s
    out of its worktree and unsets `PUP_SESSION_ID` is an operator to `callingSession`. This
    makes the audit trail honest, not tamper-proof — the sandbox is the instrument for the rest
    (decisions 44, 45).

49. **A respawn kicks off on the document the session signalled for, or on nothing
    (2026-09-13).** Decision 44 closed the staged respawn — readiness needs a real
    `handoff-request` steer, so a `handoff_ready` nobody asked for no longer makes a session
    ready — and named what it left open: the file itself. `handoff.md` lives under the store's
    sessions directory, writable by anything running as this user, and nothing recorded or
    verified who wrote it. So the victim's own handoff-done, honestly steered and honestly
    signalled, still handed `pup respawn` a path rather than a document: `awaitHandoffReady`
    polls every 5 s and `respawnSession` reads the file afterwards, and whatever occupies that
    path at the moment of the read is what the fresh window is kicked off on. A session with
    nothing to do but watch could overwrite it in that window and author the victim's next
    context with no steer, no event and no trace on its own record.
    *The signal names the content, not the path.* `pup session handoff-done` now reads the
    document and records `{ hash }` — sha256 of the bytes — on the `handoff_ready` event, and
    `respawnSession` reads the file once, hashes that read, and refuses unless it equals what
    the event says, naming the session and the file. Hashing the read rather than the path is
    the point: two reads would be two chances for the file to change between them, so the
    bytes that are verified are the bytes that reach the kickoff. A signal with no document to
    hash is refused outright (`HandoffMissingError`, printed as a refusal by the CLI) — an
    agent reporting done a step early would otherwise arm a respawn on whatever wrote that
    path next, which is the hole in a different shape.
    *A new request answers with a new file.* `requestHandoff` removes any `handoff.md` before
    steering. Without that, an old document — the session's own from an earlier round, or one
    planted while waiting for this moment — sits there already satisfying a request the session
    has not answered yet.
    *Readiness is hash-aware, so tamper is a re-ask and not a wedge.* `isHandoffReady` takes
    the repo path and compares the file to the recorded hash, which is a change decision 44 did
    not ask for and the alternative made necessary: with readiness event-only, a tampered file
    left `pup respawn` looping — ready, refuse, ready, refuse — with `pup kill --respawn` and
    the loss of the whole handoff as the only exit. Hash-aware, a substituted document is
    simply not ready, so the command asks again, the stale file goes with the request, and the
    session writes a fresh one. The cost is that a session that keeps rewriting another's
    handoff can keep a respawn re-steering its victim; that is noise on a pane, not authored
    context, and it is bounded by the same sandbox everything else here is.
    *Proof by removal.* Each check has one test that fails when it is deleted, run against the
    mutated source: the comparison in `respawnSession` (the substituted document is kicked off
    on), the `rmSync` in `requestHandoff` (the stale file survives the steer), the hash on the
    event (four tests, readiness and respawn alike), and the CLI's refusal of a signal with no
    document.
    *What this leaves open.* The boundary is still the OS user, as in decisions 44, 45 and 47.
    This makes a substitution detectable and refused, not impossible: a session that can write
    the victim's `handoff.md` can also write it before handoff-done rather than after, and
    from inside the victim's worktree with the victim's id exported it is the victim to every
    check here. What is closed is the race the operator cannot see — the silent swap between a
    genuine signal and the read that acts on it.

50. **Git will not run at all while a filter or merge driver is armed (2026-09-13).**
    Decision 41 stated this as a ceiling and said what its honest fix was: "a smudge filter
    armed through the untracked `info/attributes` runs on `git worktree add` and on the gate's
    rebase, and has no `-c` disarm because its driver name is chosen by whoever wrote it."
    Verified reachable then, reproduced again here against Apple Git 2.39.5 before anything was
    written: `$GIT_COMMON_DIR/info/attributes` holding `* filter=pwn merge=pwn`, plus
    `filter.pwn.smudge` and `merge.pwn.driver` in the shared config — all three writable from a
    worktree with a plain `git config` and a redirect, none of them in any diff — and the
    script runs once per checked-out file under `launchTask`'s `worktree add`, and again on the
    gate's `git rebase`, with the operator's environment and ahead of the sandbox that is
    supposed to confine the session.
    *There is nothing to disarm, so the answer is to stop.* Every other key in this class went
    into `GIT_SAFE_CONFIG` as `-c key=`, because the key is fixed and pup can name it first.
    Here the key is `filter.<anything>.smudge`, and the `<anything>` is chosen by whoever armed
    it, so there is no command line that outranks it. That leaves decision 6's shape:
    `assertNoArmedGitDrivers` reads the two surfaces before each call and refuses loudly,
    naming the path and what is armed, because "clear it and retry" is only actionable if the
    operator knows which key and which file.
    *Armed means a key that names a command, not a namespace.* `filter.<name>.clean|smudge|process`
    and `merge.<name>.driver` execute; `merge.conflictstyle`, `merge.ff` and
    `filter.<name>.required` do not. Refusing on `^(filter|merge)\.` whole would refuse a repo
    whose operator set an ordinary preference, which is a defence nobody keeps switched on.
    `info/attributes` counts on its own, with no driver named anywhere: the file is inert until
    one is, but nothing else in a pup repo writes it, and a `-diff` pattern there already
    forges the diff the coverage stage reads (decision 41). The pair cannot be assembled
    without tripping one half.
    *`--list --show-scope`, not `--local --get-regexp`.* The obvious read misses a scope and
    cannot be fixed by adding `--worktree` beside it: with `extensions.worktreeConfig` off,
    `git config --worktree --get-regexp` silently answers out of the local file, so the two
    scopes cannot be asked for separately. They have to be, because `extensions.worktreeConfig`
    itself lives in the shared config — a session turns it on, writes `filter.pwn.smudge` into
    its own worktree's `config.worktree`, and a `--local` read from the main checkout sees
    nothing while the rebase, which runs *in that worktree*, runs the filter. Reproduced
    against the shipped gate, and it is why the gate asks at both paths: the rebase runs in the
    worktree, the ff-only merge in the main checkout. `global` and `system` are excluded on
    purpose — they are the operator's own, and a developer with git-lfs installed globally
    would otherwise never launch anything.
    *Read where git will run, which is the inverse of decision 30's rule and safe here.* That
    rule says measure from the trusted checkout so a session cannot aim the question at its own
    index. This reads at the path the command will use, including a session's worktree, because
    this measurement only ever *adds* findings: the config and the attributes file are shared,
    so a worktree reports everything the main checkout does plus its own scope, and there is no
    quieter answer for a session to point it at.
    *`pup new` asks before it writes,* the same reordering decision 41 made for the overlap
    check and for the same reason: a refusal inside `launchTask` alone would leave the spec the
    operator just abandoned sitting in the backlog, unclaimed and attributed to them.
    *The functional cost, stated.* A repo that legitimately configures git-lfs (or any clean/
    smudge pair) in its *local* config can no longer be launched or merged until that moves to
    the operator's global config or goes. That is the same trade as clearing the sign flags in
    decision 41 — loud, and the right direction, because the alternative is a documented and
    inert defence.
    *Ceilings.* This is check-then-run, not a lock: a driver armed in the window between the
    check and the command still runs, which narrows the exposure from always to milliseconds
    and does not close it. A tracked `.gitattributes` on the session's own branch is honoured
    by the rebase before the scope audit ever sees it, but it cannot execute without a driver
    in the config, which is refused — the attributes half alone is inert. Decision 41's other
    two open ceilings are untouched here and still open: the session-controlled push target
    (`url.<base>.insteadOf` or a rewritten `remote.origin.url`; the rewrite half closed by
    decision 54), and `gitDiffNumstat` forgeable
    by the same `* -diff` line (closed by decision 53). And the boundary remains the OS user
    (decisions 44, 45, 47):
    a session that can write the shared git dir can write a great deal else, and what is closed
    here is the specific path from that write to code running with the operator's environment
    on pup's own git calls.

51. **A session's code graph is an external index served over MCP, one per worktree
    (2026-09-13).** docs/05 asks a session to reuse what already exists, and the only instrument
    for it was the knowledge slice: a regex code map of files per module, churn, debt, "depends
    on / used by" at directory granularity. It answers *where roughly to look*, which is not the
    question a session has. "How does X work", "how does X reach Y" and "what breaks if I change
    Z" are about symbols and edges, so every session answered them the expensive way — grep,
    read, read again, and rebuild in context a call graph the parser had already built and thrown
    away. CodeGraph (github.com/colbymchenry/codegraph, npm `@colbymchenry/codegraph` 1.6.0, MIT)
    is that parser kept: a local SQLite graph of every symbol, edge and file, 130 files and 1,473
    nodes of this repo in 2.4s, no network, nothing tracked. The slice stays — it answers shape
    and debt at launch, the graph answers code on demand.
    *An external graph over growing our own.* A symbol-level indexer for 30+ languages is not
    adjacent to pup's job, and a regex over paths is not a foundation to build one on. The
    dependency is the cheap kind: one binary, MIT, local, invoked by argv, nothing to migrate if
    it goes.
    *MCP over injecting explore output,* which is what the slice does. Wrong shape twice: the
    questions are the session's, asked while it works and not guessable at launch, and the
    answers are large — the context budget (docs/03) exists because a profile that pastes
    everything useful arrives useless. A tool costs nothing until asked and returns source
    verbatim, line-numbered, ready to Edit. It also keeps pup out of the middle: the server sends
    its own usage instructions on connect, so the `## Code graph` section carries only the thing
    just pup knows — that the graph is *this worktree's*. `mcp.json` is compiled with the
    settings and hooks rather than written beside them, so which binary serves a session's graph
    is recorded in the profile hash at compile time — attribution, not detection: nothing
    re-reads the compiled dir to verify it, which is decision 46's ceiling. No
    `--strict-mcp-config`: it would drop the operator's own MCP
    servers, which decision 9 refuses — sessions inherit user config and pup adds to it.
    *One graph per worktree, which is the design and not a detail.* codegraph resolves a project
    by walking PARENT directories for a `.codegraph/`. A worktree sits at
    `<repo>/.worktrees/<id>`, so one with no index of its own resolves *up* into the main
    checkout and the session is answered out of main's graph while believing it reads its own
    branch — every answer plausible, subtly wrong, unfalsifiable from inside. Hence `--path
    <worktreePath>` pinned explicitly rather than left to the client's root, an index built from
    the worktree right after `worktree add`, and codegraph's watcher keeping it current.
    *So a failed index withholds the config rather than degrading into it.* The launch survives a
    machine with no codegraph and a worktree that will not index: both print one line and launch a
    normal session. But "degrade to no graph" has to mean no graph — launching with the config
    anyway is what hands the session main's index by the walk above. No graph is a poorer session;
    the wrong graph is a lying one. The residual, stated: the compile precedes `worktree add`
    (decision 40 — a throw after it orphans a worktree and branch), so on that path the context
    still carries the section and the session may call a missing tool once, which beats a
    silently wrong branch.
    *The exclude line over editing `.gitignore`.* codegraph's own `.codegraph/.gitignore` hides
    the database but leaves the directory untracked — `?? .codegraph/` in porcelain, which the
    gate and the overlap radar both read. One `.codegraph/` line in `info/exclude`, found through
    `git rev-parse --git-path`, lands in the COMMON dir and so covers the main checkout and every
    worktree including ones that do not exist yet. Not a tracked `.gitignore`: the exclusion is
    the operator's local tooling, not a fact about the project, so pup would be committing to
    every contributor's repo on its own account. Writing it needs the *resolved* path — git
    answers relative from a main checkout and absolute from a worktree, and appending to the
    relative one writes wherever pup's process is standing. Found by the test, not by review.
    *The daemon and the telemetry env.* `CODEGRAPH_TELEMETRY=0` on indexing and on the served
    server alike — the repositories it indexes are not ours to report on. The daemon is
    codegraph's to run and pup starts none: `serve --mcp` brings up one per project path and its
    watcher keeps that path's index current, which is why the graph lags a write by about a
    second, why nothing here polls or re-indexes mid-session, and why "one per worktree" is
    enough to keep two sessions' daemons off each other's index.
    *What stays open.* The conductor gets no graph — whether it should read main's index is a
    separate question with a separate answer (the next task). `pup init` and `pup audit` report
    nothing about the capability, so an operator learns it from a line at launch. And the slice is
    still the regex map: now that a real graph exists at launch it could be cut from one, which is
    why this keeps both rather than replacing either.
    *Addendum, from the security review of the branch (2026-09-13).* Five findings, all of them
    the same mistake in five places — treating a third-party binary and its server as part of
    pup rather than as something pup hands work to.
    1. `which codegraph` echoed the PATH ENTRY it matched, and pnpm prepends the relative
    `./node_modules/.bin`, so under `pnpm dev` the answer was `./node_modules/.bin/codegraph`: a
    gitignored path inside the repo that a session can plant a script at, executed by pup at the
    next launch, and written into `mcp.json` as a relative command every later session
    re-resolves against its own worktree. Now `which -a`, taking the first candidate that is
    both absolute and outside the repository — a repo-local shim is refused, not ranked last,
    so an operator who has only that one has no codegraph.
    2. The exclude line was unanchored, so `.codegraph/` matched at every depth in every
    worktree forever and `src/.codegraph/setup.ts` was invisible to the worktree-clean stage:
    uncommitted code the gate cannot see and a test run can read. Anchored to `/.codegraph/`,
    which hides the one directory codegraph creates and nothing else.
    3. Indexing ran with `{...process.env}`, handing a `#!/usr/bin/env node` shim every secret
    in the operator's environment, `NODE_OPTIONS` (whose `--require` executes inside it), and
    the `CODEGRAPH_DOWNLOAD_BASE` / `CODEGRAPH_INSTALL_DIR` pair its cold path uses to fetch and
    exec a bundle. Now built UP from an allowlist — PATH, HOME, LANG, LC_ALL, TMPDIR, USER —
    plus `CODEGRAPH_TELEMETRY=0` and `CODEGRAPH_NO_DOWNLOAD=1`. An allowlist and not a denylist
    because the variables to fear are the ones nobody has thought of yet.
    4. Claude Code spawns a stdio MCP server as its own child, so the server inherited
    `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` — the peer credentials that
    address other sessions and the conductor, which decision 47 keeps off the tmux server for
    exactly this reason. The served `env` block blanks both; a code indexer has no business
    holding the means to speak as the session.
    5. The index failure printed the CLI's `error.message` raw, ANSI and paths included, onto the
    terminal the operator reads a decision from. Through `failureSummary` now, like every other
    shell-out (decision 29).
    *And one left open by name:* `relaunchWindow` in `session-handoff.service.ts` respawns a
    session with the code-graph context section but without `--mcp-config`, so a respawned
    session is told to use a tool it does not have. It is out of this task's scope and the next
    task fixes it. Worth stating why it is a gap and not a vulnerability: the failure is a wasted
    tool call, and a respawn withholding the config is the same safe direction as a failed index.
    The lesson the five findings share is the one that generalises — every launch flag, env block
    and exclude pattern pup hands to a third party is part of the trust boundary, and the
    interesting half is always what it inherits rather than what it is passed.
    *Second addendum: the conductor's graph, the capability line, and the respawn gap closed
    (2026-09-13).*
    *The conductor gets a graph of the merge target, on the same terms a session gets its
    worktree's.* It plans and reviews from what has merged and edits nothing, so the merge target
    is the right index for it. Same client, same anchored exclude line, same compiled `mcp.json`
    recorded in its profile hash, same `--mcp-config` on its argv, same withholding when the index
    fails. The one thing that differs is the first sentence of the context section, which names
    WHAT the graph is of. That is not decoration: the failure this whole decision is shaped
    around is an answer out of one checkout believed to be about another, and the conductor
    reading one tree while believing it reads another is the same lie pointed the other way. So
    the section is one function with a parameterised opening rather than one constant used twice.
    (This paragraph first said the graph was built from the MAIN CHECKOUT and that main's tree is
    "what has merged". The third addendum below corrects both: a working tree is not what has
    merged, and the graph is now cut from a private detached checkout.)
    *`pup init` and `pup audit` print `codegraph: <version>` or `codegraph: not installed`,*
    beside the sandbox line and for decision 36's reason: an operator who never sees it cannot
    tell a fleet whose sessions query a graph from one whose sessions grep, and "my sessions got
    slower at finding things" is not a diagnosis anyone reaches unaided. The version is the
    binary's own stdout, so it goes through `sanitizeReason` (decision 29) before reaching the
    terminal. A binary that will not answer `--version` reports as installed-with-version-unknown,
    never as absent: pup would still index with it, and telling an operator to install what they
    already have is worse than telling them nothing. Probed at print time rather than carried on
    `InitReport`: what it reports is the operator's machine, not the baseline the stages measured,
    and the report is the baseline's record.
    *The respawn gap is closed.* `relaunchWindow` now re-runs the index on the worktree and passes
    the launch's compiled `mcp.json` when one exists. Three parts worth stating. It does not
    recompile: a respawn is the same session on a fresh context window and its profile hash must
    not move, so the binary and the path are the launch's. It re-INDEXES rather than only
    re-passing, because the previous run has been editing this worktree since the launch and an
    index its commits have outrun answers out of code that is no longer there — and it indexes
    after the kill, when the tree has stopped moving. And it withholds the config when the
    operator's codegraph has gone since the launch, which is the same safe direction as a failed
    index: a config naming an absolute command that no longer exists is a server that cannot
    start.
    *What the slice would cost, recorded and not taken.* `buildKnowledgeSlice` still cuts from the
    adapter import scan even where a graph exists. Reading `codegraph explore` instead would buy
    symbol granularity in the compiled context — the slice could name the functions a task will
    touch rather than the directories — and it would cost: a launch that blocks on a third-party
    binary before the profile can compile (today the index runs AFTER the compile, and a failure
    costs a graph and not a launch); a compile whose output differs by machine, so the profile
    hash stops being comparable across operators; and a second parse-and-shape layer over
    codegraph's output, which is prose for an agent rather than a data structure. The cheap half
    is available today and is the part that matters: the section tells the session to ask the
    graph BEFORE reading files, so the symbol-level answer arrives on demand instead of being
    guessed at compile time. Revisit if the import scan's module granularity is measurably what
    makes a session re-implement something — not before.
    *One duplication left standing, named.* `graphForWorktree` in `session-lifecycle.service.ts`
    is now the same code as `prepareGraph` in the client, which the conductor and the respawn both
    call. Folding it in was outside this task's scope-in list; it is a three-line change and the
    next thing to touch that file should make it.
    *Third addendum, from the operator's security review of the branch (2026-09-13).* Three
    findings, all reproduced against the real binary. Two of them are the same mistake the first
    addendum's five were: the graph is addressed by PATH, and a path is not a capability — whoever
    can write at that path decides what the index says.
    1. **Indexing through someone else's index (HIGH).** A session could replace its worktree's
    `.codegraph` with a symlink at another checkout's — the conductor's, created by `pup conductor
    start`. `existsSync` follows a symlink, so the "is it initialized" probe answered yes, the
    `index` branch was taken, and `codegraph index <worktree>` rebuilt the VICTIM's database from
    the attacker's files. Verified: main's own files vanished from the db. The result is a write
    through a path the attacker chose, and worse than a corrupted graph — the victim's agent is
    answered verbatim out of the attacker's tree, with the feature's whole promise ("this is the
    real source") carrying the lie. Fixed in `indexDirectory`, the one path every caller shares:
    both `.codegraph` and `.codegraph/codegraph.db` are `lstat`ed before anything runs, a symlink
    is refused outright, and anything whose real path lands outside the directory is refused too
    (a symlinked parent, a bind mount). Absent stays fine — that is the `init` path. It throws,
    which the callers' catch already turns into one printed line and no config.
    2. **A live working tree is not "what has merged" (MEDIUM).** The conductor's graph was built
    from the live main working tree, which carries untracked files — and a session's Bash is
    guarded only against `.claude/`, so a session can write into the repo root from its own
    worktree. Two levers, neither needing a privilege the session lacked. A root `codegraph.json`
    steers the indexer: `{"include":[".worktrees/**"]}` pulls every session's worktree into the
    conductor's graph, and an `exclude` blinds it to whatever the session would rather it not see.
    And an untracked source file is returned verbatim into the context of the one agent that
    plans, launches and steers every other one. The conductor is the highest-privilege reader in
    the system; its graph must not be writable by the things it supervises. Fixed structurally
    rather than by blacklisting the two known levers: `pup conductor start` cuts (or refreshes) a
    private detached checkout of the merge target at `~/.pupitre/<pid>/conductor/checkout`, indexes
    THAT, and pins `mcp.json` at it. (That path is derived in `conductor.service.ts` rather than
    added to `projectPaths` beside `conductorCompiledDir`, where the rest of the conductor's state
    layout lives: this is its only consumer, and a second one is the moment to move it.) Tracked content and nothing else, so both levers are gone at
    the root. Detached, so the branch stays free for the main checkout and for `pup merge`.
    Refreshed at start and not after, which the context section now says in as many words — the
    conductor is told its graph is a snapshot of a pristine copy, that it is not the tree it sits
    in, and that answers carry repo-relative paths to read where it stands. `pup conductor stop`
    leaves the checkout in place: it is a cache, and re-cutting it every start is the expensive
    half. The target branch is read the way `runMergeGate` reads it (`git branch --show-current`
    in the main checkout), so the conductor's graph and the gate's destination cannot disagree
    about which branch that is; a detached main checkout has no merge target and gets no graph,
    with the usual one line. One robustness note found while building it: clearing
    `~/.pupitre` leaves the worktree registration behind and `worktree add` then refuses that path
    forever, so the add is preceded by a `worktree prune` — which drops only registrations whose
    directory is already gone, and heals what would otherwise be a conductor that silently never
    gets a graph again.
    3. **Session worktrees swallowed whole (MEDIUM).** In a repo whose `.gitignore` does not list
    `.worktrees/`, the live-root index pulled every session worktree into the conductor's graph on
    its own, without anyone planting anything. Finding 2's private checkout removes this for the
    same reason it removes the other two: `.worktrees/` is not tracked content. Explicitly NOT
    fixed by adding `/.worktrees/` to the shared `info/exclude` — that line lands in the common
    dir and so would also hide a session-created `<worktree>/.worktrees/` from the gate's
    worktree-clean stage, which is the first addendum's finding 2 reintroduced one directory over.
    The through-line of all eight findings across the two reviews: pup's job at every one of these
    boundaries is to decide WHAT a third party is pointed at, and the answer is never "wherever
    the thing being supervised can write".

52. **`pup ui` is Ink over one snapshot, and it renders rather than decides (2026-09-13).**
    Decision 41 put the backlog into `pup status` and decision 35 put stalled sessions there, and
    the command has been printing a longer and longer list ever since: it is the one place the
    operator looks to decide what to do next, and it answers by scrolling. What the operator asked
    for is a screen that stays open. That is a different artefact from a printed list, and the
    first thing it needs is to stop being two artefacts: `pup status` and a dashboard querying the
    store separately is how a session reads STALLED on one and fine on the other. Part 1
    (`buildDashboardSnapshot`) settled that — one reading, taken at one instant, for both. This is
    the screen on top of it.
    *Ink, and the cost said out loud.* A live dashboard is panes that come and go — a header, a
    table, a radar, a footer, and the controls part 3 adds — and keeping them consistent while
    one of them changes is what a component model is for. React is also the one framework Claude
    Code itself ships, so the thing pupitre supervises and the thing that watches it are written
    the same way, and an operator who can read one can read the other. The price: two runtime
    dependencies in what was a four-dependency app, and a Node 22 floor, because Ink 7 declares
    one. The alternative was ANSI by hand, and it was rejected on the second pane rather than the
    first — cursor arithmetic is cheap once and compounding after that, and it is the part nobody
    writes a test for. `ink-testing-library` renders each component to a string, so every pane
    here has one.
    *No logic in a component.* Every value on screen is a field of the snapshot; a component that
    needed a value the snapshot does not carry could not be written against the fixtures its test
    renders from, which is the rule made enforceable rather than aspirational. `src/cli/ui/` holds
    the components, the hook and the words; nothing else imports Ink or React. The corollary for
    part 3: an action will call the same core function the CLI command calls, never a private path
    of its own — the rule the snapshot enforces for reads, kept for writes.
    *Two departures from what `pup status` prints, both because a screen is held open.* The goal
    moved to the end of a session row: a printed row is read once and leads with what the session
    is for, a row here is read fifty times to answer "what needs me", and the 44-char goal column
    pushed every marker that answers it past the end of an eighty-column terminal. And merged and
    killed sessions are a count, not rows — pupitre's own store had 27 of them the first time this
    rendered, which pushed the header, the radar and the footer off a 40-row screen to show work
    nobody can act on. Both are selections and reorderings of snapshot fields, not new readings;
    `pup status` still prints every session, and the counted line says so.
    *What the words are, both surfaces share.* `goalColumn`, the origin marker, the activity
    marker, the context reading, the gate and the steer moved out of `index.ts` into
    `src/cli/ui/dashboard-text.utils.ts`, and `pup status` now calls them too. One snapshot keeps
    the two from disagreeing about what is running; sharing these keeps them from disagreeing
    about what to call it, which is the same split one layer down.
    *A terminal that is not a terminal gets the text.* Piped, redirected or captured by a hook,
    `pup ui` prints what `pup status` prints — the same function, not a second rendering — and
    exits 0. Typing a dashboard command in a script is a reasonable thing to have done, and a
    refusal there buys nothing. On a TTY it takes the alternate screen, vim's and htop's buffer,
    so quitting hands the scrollback back untouched; `q`, Ctrl-C, SIGINT and SIGTERM all reach
    `unmount`, which is what restores it.
    *Who may see the attach command is still the reader's call.* The snapshot carries the
    conductor's attach command with its `-L` socket for every caller; decision 47 says the operator
    is the only one shown it. `pup ui` asks that question through the same `showAttachCommand` the
    status printer uses and passes the answer down as a prop — a component does not get to decide
    it, and the two surfaces cannot answer it differently.
    *Not built here, and why.* The detail pane this task described — goal, scope, acceptance
    criteria, the last gate's stages and the last five events behind a selected row — is not in
    this cut. Three of those five are not in the snapshot: a session row carries no scope, no
    acceptance list, and its `lastGate` is a verdict and a failed stage rather than the stage list,
    and there are no events on it at all. Adding them is a change to `src/core`, which this task's
    scope-in does not include, so the honest options were a pane missing three of its five sections
    or no pane. The cursor it would have opened from is here and working, because part 3's actions
    need it; `Enter` and `Esc` are unbound until there is something to open.
    *Addendum (2026-09-13, part 3): the keys, and the one rule they all obey.* The screen now
    launches, steers, interrupts, kills, unblocks, respawns, attaches, toggles the conductor and
    merges, so the operator's loop runs from one place. Every key goes through
    `src/cli/ui/actions.service.ts`, and every function there calls the same core function the
    command of that name calls — this is the corollary above, made a file rather than a habit: a
    component imports actions, an action imports core, and there is no third path. The result of
    a key is a line in the status bar rather than a print, because an action on a row three lines
    up leaves nothing on that row to read; the reading refreshes right after it, so the row
    catches up on its own.
    *Errors become lines, not stack traces.* A CLI command that hits something unexpected should
    die with its stack — the operator gets the shell back and can read it. A held-open screen that
    did the same would tear down the render and leave the terminal on the alternate buffer, so
    every action answers with a message and a failed flag. The refusals the core throws are
    already written for a person to read; this is where they are read.
    *`j`/`k` are gone from the cursor.* `k` is the kill. A key that sometimes moves the cursor and
    sometimes proposes killing a session is worse than either, and half a vim pair is worse still,
    so navigation is `↑`/`↓`. The confirmations are the operator's own: `y`/`n` on the kill and on
    the unblock, which shows the reason the gate recorded before it asks — unblocking is a claim
    that *that* was addressed, and the claim cannot be made about a reason nobody was shown. The
    merge is confirmed too, which the task did not ask for: a passing gate pushes a branch and
    opens a pull request, and `m` sits under the keys this screen is navigated with.
    *Two actions do not fit inside a frame, and each bends in its own direction.* The respawn's
    wait is `pup respawn`'s wait, except that the CLI's `awaitHandoffReady` sleeps the thread —
    here that would freeze the clock, the redraw and every keystroke for up to ten minutes, which
    is the one thing a screen held open must not do. Same poll, awaited instead of slept, with the
    elapsed seconds on screen. The merge runs as a child process, `pup merge <session> --pr` with
    this process's own bin: `runMergeGate` is one synchronous pipeline of clone, install, build,
    test and audit that returns a report at the end, so called in-process it would show nothing
    for the minutes the operator most wants to watch. The child prints a stage as it finishes and
    the pane fills as the gate runs. What the child does *not* do is decide who may merge: it is
    spawned with `cwd` at the repo root, where `callingSession`'s worktree detection finds
    nothing, so its tier check is weaker than the parent's, not a second opinion on it. The parent
    decides the tier — the rule below, applied before a key is bound at all — and the child
    re-checks what only it can: the session's state and whether there is an adoptable PR. `q`
    ends that child with SIGTERM rather than leaving Ctrl-C to signal it, because the gate's lock
    directory is released in a `finally` no signal-killed process reaches; `pup merge` now removes
    the lock on SIGINT and SIGTERM itself, so an interrupted gate cannot wedge the next one.
    *Attach is Ink's `suspendTerminal`, not an unmount.* Ink 7 leaves the alternate screen, hands
    the input stream back, runs the child and forces a full redraw after it. That is exactly an
    attach, and it costs nothing: the reading, the cursor and the status line are all still there
    when tmux lets go. The conductor's window is on a socket of its own (decision 47), so it is
    `A` with the `-L` on the argv rather than a row in a list it is not part of.
    *Operator-only, as a whole rather than per key.* Every key here runs a command that is
    operator-only somewhere — the launch, the kill and the steer are refused to sessions, and the
    merge, the respawn and the unblock to the conductor as well (decisions 42, 44, 47). A screen
    that offered all of them and refused each keystroke one at a time would be a menu of things
    that do not work, so `callingSession` or `callingConductor` unbinds and hides the whole set
    and puts the reason on screen instead. Looking, re-reading and leaving are not refused to
    anyone.
    *The dead exports part 2 left.* `GOAL_COLUMN_CHARS` and `SnapshotReading` were exported and
    imported by nothing, which is what ledger #18 recorded. Neither wanted an importer: the width
    is how `dashboard-text.utils.ts` fits a goal, and every caller that reached for it wanted the
    fitted string, while `SnapshotReading` names half of the hook's own return type. Both are now
    private to their file.
    *Addendum (2026-09-17): the detail pane, now that the snapshot carries it.* The pane the first
    cut left out is in, and it went in the order this decision's rule demands — the snapshot
    first, then the component. A session row now carries its task's `scope` and `acceptance`, its
    `lastGate` carries the stage list with each stage's status and detail, and `recentEvents`
    holds its five newest stored events, oldest of them first; a backlog row gains `acceptance`
    beside the scope it already had. All of it is sanitized in `buildDashboardSnapshot`, like
    every other string there: a stage detail is a failing test's output and an event payload is
    a session's own words, so each goes through `asStageArray`'s shape guard or a type check and
    then `sanitizeReason`, and each is tested against a real store with an escape in it. What an
    event says is decided there too — the transition and verdict on a gate result, a steer's kind
    and sender, a finished session's summary — as one `detail` line, because the alternative was
    a component reading raw payloads, which is a second reader of the store under another name.
    Five, because the pane answers "what happened to this last", and `pup report` holds the rest.
    `detail.component.tsx` draws a `DetailRow` the controls hook hands it — the selected session
    or planned task as the snapshot has it — and computes nothing. `Enter` and `Esc` are bound in
    `use-controls.hook.ts`, not `app.component.tsx` as the task first said: part 3 moved every key
    there, and the precedence is the point. An open prompt keeps `Esc` for cancelling, a finished
    merge log keeps `Enter` for closing, and only then does either reach the pane — a key that
    silently changed meaning because a new pane was added is the failure part 3's one modal hook
    exists to rule out. The pane is not a mode: it shows whatever row the cursor is on, the arrows
    still move it, and the action keys still act on the row it names, so nothing on screen can
    disagree about which row an action will hit. It replaces the table rather than sitting under
    it, because acceptance, stages and events run to twenty lines and would push the radar and the
    footer off a 40-row screen; the row's state and id head the pane, so the cursor is not lost.
    Read-only callers get it: reading a row is looking. The footer's two lines were re-packed to
    fit it — `a attach` joined the row actions, and the conductor keys shortened to
    `A conductor c on/off` — so both still fit eighty columns.

53. **A null numstat is a measurement, not a free skip (2026-09-17).** Decision 41 stated the
    ceiling: a `* -diff` line makes `git diff --numstat` emit `-\t-` for every file, `--text`
    does not restore it, and `countChangedLines` skipped a null count as a real binary — so a
    5 000-line diff counted zero, the `diff-size` stage passed and the review-queue risk score
    floored. Reproduced before anything was written, against Apple Git 2.39.5, and with two
    surfaces decision 50's refusal does not cover. `info/attributes` is refused at the gate,
    but the review queue runs no refusal, and **`core.attributesFile`** in the shared config
    points git at a `* -diff` file anywhere; **`core.bigFileThreshold=1`** does the same with
    no attribute at all. Neither names a command, so neither belongs in `armedGitDrivers`.
    *The patch cannot tell a forged null from a real one.* Decision 41's proposed fix was "a
    file git calls binary but which has parsed hunks is forged". It is not: `--text -U0` parses
    hunks out of a real binary too — a committed file holding `x\0y\n` yields `@@ -1 +1 @@` like
    any other — so that rule would flag every image a session commits and the skip for a real
    binary would be gone. The discriminator is the one git itself uses before anything tells it
    otherwise: a NUL in the first 8000 bytes (`buffer_is_binary`). `gitDiffBinaryRecount` reads
    both sides of the merge-base diff with `git cat-file blob`; binary on either side is a real
    binary and stays free, text on both is a forged null, recounted from the `--text -U0` hunk
    headers — adds *and* deletes, because the metric is both, and because keying on
    `gitDiffAddedLines` alone would miss a forged file that only deletes. The 8000 is
    load-bearing in the other direction: reading the whole blob would let a session append one
    NUL past git's window and have a text file it had also forged read as binary. Each rule has
    a discriminating test, proven by removing it: without the recount the forged diff passes,
    without the content check a real binary is flagged, and with the whole blob read the late
    NUL counts as binary.
    *Recounted and flagged, at any size.* The recount alone makes the size honest again, so a
    small forged diff would pass on a true count. It still flags, naming the files, because a
    text file git was told to call binary is a write no diff and no scope audit showed — the
    same "loud" decision 50 chose — and the operator decides with `--accept-debt`, which records
    it as its own ledger entry beside an oversize one. The review queue takes the recounted
    number and nothing else: its risk score is a size, and it is a size again.
    *The functional cost, stated.* A repo whose tracked `.gitattributes` legitimately marks a
    text format `binary` or `-diff` (a minified bundle, a generated SVG) now has those files
    counted toward the diff size and the stage flagged on every merge that touches them. The
    gate cannot tell a tracked attribute from a session-written one without reading every
    attribute source git consults, which is the list this decision just found to be longer than
    it looked. Loud, and the right direction: the alternative is a gate a session can zero.
    *Ceilings.* `buildSessionReview`'s per-file `files` list is still raw `gitDiffNumstat`, so
    the review detail shows a forged file as `-`; the stat type lives outside this change's
    scope, and the queue entry above it carries the true count. A file larger than the 64 MiB
    buffer throws, as the coverage stage's patch read already does — loud, not free.
55. **A package manager that cannot load is a broken cache, not a baseline (2026-09-17).**
    Twice (2026-08-31, 2026-09-05) a half-extracted corepack download left
    `pup-toolchain-cache/<projectId>/corepack/v1/pnpm/<version>/bin/` empty. It sticks, and
    corepack is the reason: the directory has no `.corepack` marker, so corepack downloads
    again, the rename into place fails because the directory exists, corepack reads that as
    "another instance installed it" and runs the empty one. Every sandboxed stage then died on
    `MODULE_NOT_FOUND` for `pnpm.cjs`, and `pup audit` stored build/test/lint FAIL, plus a
    `baseline_history` row, as the bar the next merge gated against.
    *Repaired before the first child.* `toolchainCacheDir` moves aside every
    `v1/<manager>/<version>` whose `bin/` is empty, renamed `<version>.corrupt-<ms>`, so the
    next stage downloads it again. It runs when a process first resolves a repo's cache, the
    same place the cache is created, so an install that breaks during a run is repaired by the
    next run, not mid-gate. An empty `bin/` is never a download still in progress, because
    corepack extracts into `v1/corepack-<pid>-<hex>` and renames the finished directory into
    place; those temp directories are skipped all the same, since another process may be
    filling one. Moved rather than deleted, so whoever wants to know how it broke still can.
    The trigger is the shape that was observed and nothing wider: a cache the rule
    misreads would cost a working package manager.
    *Recognised when it is not repaired.* `brokenPackageManagerInstall` reads a stage's output
    for Node's missing-entrypoint banner: `Cannot find module '<path>'`, `MODULE_NOT_FOUND`
    and an empty `requireStack`, with the path inside a corepack install tree. The empty
    require stack is the discriminator. A missing module the project's own code required has
    a stack, and that failure is the checkout's to answer.
    *Refused, not stored.* `initProject` runs that check on every failed stage and throws
    `BrokenToolchainError`, naming the install directory, before it writes the
    `baseline_history` row or `projects.baseline`. The check lives in `initProject` rather
    than `auditProject`, so `pup init` is covered as well as `pup audit`: both would otherwise
    store the crash as the bar. It runs straight after the stages, before the debt
    capabilities, because those call the same package manager and would only spend minutes
    failing the same way. Neither command catches it yet, so it surfaces as a crash: the
    message on the first line, then a stack. That is loud and stores nothing. Routing it
    through the guard that reports a repo with no adapter, as one line and exit 1, is a CLI
    change outside this task's scope. The project row itself may
    exist, because `ensureProject` runs before any stage. That row carries no baseline, so it
    is not a bar.

54. **`pup merge --pr` pushes to origin's configured URL, from a git dir that reads no shared
    config (2026-09-17).** Decision 41 left this open: "`url.<base>.insteadOf` or a rewritten
    `remote.origin.url` in the shared config sends `pushBranch` and `gh pr create` wherever the
    session says". Reproduced against Apple Git 2.39.5 before anything was written: `remote
    get-url origin` answers with the rewritten URL, and both `git push origin` and the gh
    `--repo` pin derived from that answer follow it.
    *The literal URL is not enough on its own.* The fix decision 41 named was to push to the
    literal URL instead of the remote name. Git rewrites a literal URL through `insteadOf` and
    `pushInsteadOf` exactly as it rewrites a remote's, verified by pushing to one. Nothing on
    the command line outranks it either: git picks the longest matching prefix, and on a tie
    the rule it read first, which is the local config, since `-c` is read last. So a
    `-c url.<origin>.insteadOf=<origin>` loses to a session's rule matching the whole URL.
    That is decision 50's situation, but here there is a way out that filters did not have:
    the push does not need the shared config at all. `pushBranch` runs `git push` from an
    empty scratch bare repo with `GIT_OBJECT_DIRECTORY` pointed at the repo's objects, so
    `url.*`, `remote.*` and `core.sshCommand` in the shared config are never read, while the
    operator's global and system config still are. An operator's own ssh-for-https rewrite
    keeps working, and the test fixture relies on exactly that to stay offline.
    *Read once, raw.* The URL comes from `git config --get remote.origin.url` in the main
    checkout, not from `remote get-url`, which applies the rewrites. It is read before the
    stages run and carried to the push, so the pushed-to URL and the `--repo` slug are one value.
    A rewrite written while the stages run cannot move it.
    *The lease names its value.* A push to a URL neither reads nor updates a remote-tracking
    ref, so a bare `--force-with-lease` has nothing to lease against. The lease is now `refs/heads/<branch>:<sha>`, read from
    `refs/remotes/origin/<branch>`, and pup moves that ref itself after the push. The test for
    a retry after the rebase rewrote the pushed branch covers this. `--set-upstream` went: the
    branch is deleted when the merge ends, so an upstream pointing at a URL served nothing.
    *The functional cost, stated.* `remote.origin.pushurl` is no longer honoured, and neither
    are `url.*`, `core.sshCommand`, `http.*` or `credential.helper` set in the repo's local
    config. The push goes to `remote.origin.url` with the operator's global config, and a
    read-over-https, push-over-ssh split has to move there as a `pushInsteadOf`. It is the same
    trade as clearing the sign flags in decision 41 and refusing local filters in decision 50.
    The shared config is session-writable, so a setting there cannot be told apart from a
    redirect.
    *Ceilings.* **A rewritten `remote.origin.url` still redirects the push and the PR**
    (closed by decision 56). The
    value is read from the same shared config a session can write, and there is no trusted
    copy to compare it against. The honest fix is to record origin's URL when the project is
    set up and refuse a merge where the two differ, which is its own change. What this change
    narrows: the push and the PR can no longer disagree, which `pushurl` allowed, and a target
    that names no host, owner and repo, like a local path, is refused by `originRepoSlug`
    before anything is pushed. The adoption probe and every gh call still carry the pinned
    `--repo`, and gh itself never pushes.

56. **The push target is recorded at setup, and a merge whose config disagrees is refused
    (2026-09-17).** Decision 54 pushed from a git dir that reads no shared config, which closed
    `url.*` rewrites, and stated the ceiling it could not close from there: `remote.origin.url`
    itself lives in that same session-writable config, so a session that rewrites the value
    rather than a rewrite rule still aims both the push and the gh `--repo` pin. Reproduced in
    the gate's own fixture before this was written, and again afterwards with the check taken
    back out: a `remote.origin.url` written from the worktree lands the session's branch in a
    second bare repo, and the pull request is pinned to that repo's slug.
    *The trusted copy is taken once, where trust actually exists.* `pup init` reads
    `git config --get remote.origin.url` from the checkout the operator is standing in — before
    any session for the project exists — and stores it on `projects.origin_url`; `pup audit`, operator-only
    since decision 48, records one the same way when there is none. Raw, through the
    same `readOriginUrl` the gate reads with, never `remote get-url`: one function, so the
    recorded value and the compared value cannot drift into being read two different ways. A repo
    with no origin records nothing; `--pr` there already refuses on the missing remote.
    *The gate pushes the record, and reads the config only to catch it moving.* `pushTarget`
    runs in `runMergeGate`, right after the `gh` probe and before the adoption probe, and what it
    returns — carried to the push and to `originRepoSlug` exactly as decision 54 carries it — is
    the recorded value, not the configured one. The live read is the tripwire, not the source:
    when the two disagree the merge is refused with both values named, and when nothing is
    recorded it is refused pointing at `pup init`. Both refusals land before the gate runs, so
    nothing is pushed, no PR is opened, and the session stays `awaiting-review`. This is decision
    6's loud backstop, decision 50's shape: pup could quietly push to the recorded URL and say
    nothing, but a `remote.origin.url` the operator did not write is a session that wrote it, and
    that is worth stopping for rather than working around.
    *Re-recording is a flag, and the flag is operator-only.* Origin does legitimately move — a
    repo renamed, a fork promoted — so `pup init --origin-moved` re-records from the current
    config. A plain `pup init` re-run never overwrites a disagreeing value; it reports it as a
    finding naming both, with the flag. That is the considered-override shape `--accept-debt` and
    `--allow-overlap` established: the flag refuses a calling session, because re-aiming where
    sessions' work is pushed is not a session's call (decisions 41, 48).
    *A session's own `pup init` records nothing at all.* The first record is as dangerous as a
    re-record — a project set up before this column existed has none, and a session that got
    there first would nominate the target the gate then holds it to. So the CLI passes `'skip'`
    when `callingSession` answers, and the row stays empty until an operator runs it. The merge
    refusing loudly on an unrecorded target is what makes that safe rather than silent.
    *The operator can see the value they are held to.* `push target: <url>` prints beside the
    `sandbox:` and `codegraph:` lines on `pup init` and `pup audit` alike, read from the row the
    gate reads, and says "not recorded" in as many words when there is nothing there
    (decisions 36, 51).
    *What is refused rather than recorded.* A configured URL that does not survive
    `sanitizeReason` — control characters, newlines, 300-plus characters — is reported as a
    finding and not stored: no remote URL anyone types needs an escape sequence, a stored one
    would repaint the terminal every time the line is printed, and a sanitized copy is not the
    value the gate could compare against. The print sanitizes too, for rows written before this.
    And the first record is only trust-on-first-use while nothing else has had the config: on a
    project that has already run sessions — every project set up before the column existed — it
    is held back with a finding, and `--origin-moved` is how the operator confirms it.
    *Ceilings.* **`pup init` is not operator-only**, unlike `pup audit` (decision 48), so a
    session can still re-run it and re-stamp the debt baseline through the command decision 48
    did not cover. The push target is defended against that by the `'skip'` above; the baseline
    is not, and closing it is decision 48's shape applied to one more command — its own change.
    **A project whose origin moved and whose operator has not re-recorded cannot merge with
    `--pr`** until they do; that is the intended refusal, but it is a stop-the-world one, and the
    same is true of every project set up before the column existed. **The record is only as good
    as the checkout `pup init` ran in:** an operator who onboards a repo whose `remote.origin.url`
    was already poisoned records the poison, and nothing here can tell — holding the first record
    back narrows this to a project with no sessions yet, where the operator is the only writer the
    config has had, but a repo cloned from a poisoned source is recorded as it stands.
    **The store is the root of trust:** the recorded URL is a row in the same SQLite store a
    session can reach on disk, so this is loud against a session that rewrites git config and
    silent against one that rewrites the store — decision 46's ceiling, and the one every check
    pup makes against its own rows stands on. **Decision 27's ceiling
    stands:** a session that `cd`s out of its worktree and unsets `PUP_SESSION_ID` is an operator
    to `callingSession`, so the `'skip'` and the flag's refusal make the audit trail honest, not
    tamper-proof — the sandbox is the instrument for the rest.

57. **A project has one brief, written by the operator, and it is split once: Destination and
    Constraints to every session, Priorities to the conductor (2026-09-18).** Everything a
    session knows about why it exists arrived through its task spec, which is one task wide. The
    direction the tasks serve — where the project is going, what it must not do — had nowhere to
    live, so it was either retyped into every spec or lost. `~/.pupitre/<id>/brief.md` is where
    it lives now: free Markdown, `pup brief edit` to write it, `pup brief show` to read it, one
    per project because a project with its conductor running IS the stream, and there is no
    second thing inside one for a second brief to belong to.
    *Pup never interprets it.* The template's three headings are the only structure the code
    knows, and they exist so the file can be split in exactly one place. Nothing is parsed out of
    the prose, nothing is stored from it, and a heading the operator renames simply stops
    carrying. The split itself is the decision: a session is given **Destination and
    Constraints** because where the project is going and what it may not do are direction to
    whoever writes the code, and is NOT given the **Priorities**, because what to do first is the
    conductor's to decide and a session reading it is a session invited to re-plan the task it
    was launched for. The conductor gets the file whole, with one line telling it which half its
    sessions saw. A brief still on its template carries nothing, so no section is emitted at all.
    *One door for every reader.* Both compilers and `pup brief show` read the brief through
    `readBrief`, so what it does is done once and cannot be walked around by a later reader. It
    strips C0 and C1 control characters, keeping newline and tab: the brief is printed to the
    operator's terminal and pasted into tmux as the kickoff, so an escape sequence would repaint
    the terminal and a bracketed-paste terminator or a bare carriage return would end the paste
    early and leave the rest of the file typed as commands — decision 29's shape, but not
    `sanitizeReason`, which collapses the whitespace a Markdown document is structured by. It
    then caps the brief at 8000 characters and refuses past it with `InvalidProfileError` naming
    the path, the length and `pup brief edit`. Without the cap an oversized brief surfaced as
    `ContextBudgetExceededError` naming a token count, which reads as "your task spec is too
    long" and sends the operator to the wrong file; the refusal is answerable at all three launch
    paths, `pup new`, `pup launch` and `pup audit --sweep`, whose expected-error list was empty
    and which therefore crashed. The hash covers the sanitized text, which is the text that was
    used.
    *Read at compile time, which is the whole of its lifecycle.* `compileProfile` and
    `compileConductorProfile` locate the brief themselves from the repo path, rather than take
    the text from their callers — one rule, one moment, and it is the moment that makes an edit
    land at the next launch and the next conductor start and never inside a window already open.
    `pup brief edit` says so in one line and names the conductor and sessions still running on
    the brief as it was; restarting them is the operator's call, and pup neither steers them nor
    pretends the edit reached them.
    *Hashed whole, not as the slice that was sent.* The brief joins the compiled files and the
    user-config snapshot in a session's profile hash — the WHOLE brief, including the Priorities
    that never reach `context.md`. An operator who rewrote only the Priorities changed the
    direction the session was launched under just as much. The test is discriminating on exactly
    that: it edits only the Priorities, asserts every compiled file is byte-identical, and asserts
    the hash moved, so dropping the brief from the hashed payload fails it. The conductor's hash
    needs no such term, its `context.md` carrying every word already. Absent a brief the term is
    absent from the payload, so a project without one hashes as it always did — but a brief
    saved on its untouched template DOES move the hash while adding no section, because the file
    is there now and the hash records the file. **The hash is recorded for consumers that do not
    exist yet.** `config_drift` has no emitter and `pup profile stale` is not implemented, so
    today nothing reads the hash and tells the operator their brief moved under a running
    session. Recording it is what makes that check possible when it is written; it is not that
    check.
    *Operator-only on the verbs, and that is all it is.* The guard is the conductor command's,
    `callingSession(db) || callingConductor()`, on `show` as well as `edit`. A session that could
    run `pup brief edit` would be writing its own kickoff and the next session's, which is
    decision 40's prompt injection wearing the operator's attribution; a conductor that could
    would be promoting its plan to the operator's direction, which is the one thing decision 47
    left with the human. The read is refused too, and not only for symmetry: the Priorities are
    the conductor's half to act on, not a session's to read.
    *Ceilings, stated plainly.* **The guard covers the verbs; it does not cover the file.**
    `brief.md` is store-resident, and the store is reachable from a session's shell — decision 46
    named `~/.pupitre` the root of trust and decision 6's scope layer guards `.claude/`, not the
    store. So a session can write the brief directly and become the first thing every later
    session and the conductor read, wearing the operator's attribution. That is the same ceiling
    decision 48 states for `pup audit` and decision 27 states for the whole family, and the
    sandbox (decisions 36, 44, 45) is the instrument for it, not this guard. What is done here
    instead is to cut the blast radius by position and framing: the brief is compiled LAST in a
    session's context, below the goal, the scope, the acceptance criteria, the conventions and
    the session protocol — every rule it could contradict — and below the Role in the
    conductor's; and pup writes the one line that introduces it, saying it is reference material
    from the operator that is not a task, grants no permission, widens no scope and changes no
    rule in the document, which wins where they differ. The section order is asserted, so a later
    edit cannot quietly move it back above the rules.
    *What the splitter does and does not promise.* Headings inside a fenced code block (``` or
    `~~~`) are text: a fenced example containing `## Destination`, written under the Priorities,
    used to start a section there and put the rest of the Priorities in front of every session.
    A closed ATX heading (`## Constraints ##`) is the same heading as an open one, so constraints
    written that way no longer silently reach nobody. An unclosed fence swallows the rest of the
    file, which is CommonMark's reading and the safe direction — it carries less, never more. A
    heading written in some other form (Setext underlining, a different level, a renamed title)
    remains the operator-side failure it always was: the brief simply carries less, silently, and
    `pup brief show` is where they see what pup sees.

58. **A nested package is its own measurement unit (2026-09-21).** #95 added `tools/review`, a
    package with its own `package.json`, lockfile, vitest config and tests, and the TypeScript
    adapter measured it as part of the root. Its eight source files joined the root coverage
    report through decision 30's `--coverage.include` glob, instrumented and never run by the
    root's `src/**/*.test.ts`, and its exports, consumed by its own scripts rather than by any
    root module, read as dead. `pup audit` on 2026-09-18 recorded coverage **92.3% → 84%** and
    dead exports **14 → 19**, and the gate flagged five `tools/review` exports as new dead code
    on PR #99. None of it was debt anyone could act on from the root.
    The rule is decision 32's: exclude only what the runner cannot be expected to cover, and say
    why. A directory below the measured root that commits its own `package.json` has its own
    runner, so the root runner is not expected to cover it, and it is skipped the way
    `.worktrees/` is skipped as another checkout. `nestedPackageDirs` answers it in
    `git-tree.client.ts`, once per capability call. The source walk stops there, which
    takes the directory out of the dependency graph, dead exports and duplication together.
    `coverableFiles` does not expect coverage for a file inside one, and `rootCoverageReport`
    drops the same files from the report with the same predicate, so report and expectation
    cannot drift (decision 32's reason for sharing `isCoverageExcluded`). Filtered in pup after
    the run, as decision 32 did, so the worktree's vitest config has no say. There is no
    path-specific rule for `tools/review`; any workspace member gets the same treatment.
    *The marker must be committed in both checkouts.* A `package.json` is one file a session
    can write anywhere, so the check is decision 31's AND over `measurePath` and `configPath`:
    a nested package a session creates is counted at the root in its own merge and leaves the
    metrics after it has landed. **The first cut read both sides from the filesystem, and the
    operator's security review found that the AND bought nothing:** an untracked
    `src/core/package.json` dropped into the main checkout from a session shell is diffed by
    nothing and hashed by nothing, and the gate checks only the worktree for dirt, so that file
    plus the same file committed on the branch exempted `src/core/` from dead code,
    duplication and coverage in the session's own gate with nothing merged. Markers now come
    from `git ls-tree -r HEAD` in each checkout, run with `GIT_SAFE_CONFIG`, `scrubbedGitEnv`
    and a timeout as `readOriginUrl` does. The review proposed `git ls-files`; that reads the
    index, and the main checkout's index is also the session's to `git add` an untracked file
    into, with nothing checking it, so only `HEAD`'s tree counts. Reading a tree also makes the
    symlink, directory and empty-file questions moot: a marker is whatever git committed at
    that path, and there is no filesystem type left to check. A checkout git cannot list
    contributes no markers, so nothing is exempt, the safe direction.
    Each direction is asserted, and each test was proven by mutation, each restored from a
    backup copy: making the set always empty fails the three tests that name a nested package;
    taking the union of the checkouts' markers instead of the intersection fails exactly the two
    that commit the marker in the worktree alone (weakening `every` to `some`, the first cut's
    mutation, is an equivalent mutant over two checkouts and was replaced by the union);
    reading the index (`ls-files`) fails the staged-marker test; reading untracked files too
    fails the three untracked- and staged-marker tests; dropping the coverage filter from
    `rootCoverageReport` fails its own test, which the first cut lacked, leaving the suite
    green with that line removed; and matching a nested directory as a string prefix fails the
    two tests that hold a sibling (`pkgs/` beside `pkg/`). A directory without its own
    `package.json` is still walked, with a test.
    *Ceilings, stated plainly.* **Closed by decision 59:** the gate now runs a touched nested
    package's own `test` and `typecheck`, the three debt stages name what they left out,
    `DUPLICATION_RULE_ID` is bumped, and the review workflow runs the merge base's
    `tools/review`, not the PR head's. As stated at the time: **`tools/review` is now measured
    by no stage except scope-audit and complexity.** Nothing invokes its own runner: the root `tsc` includes `src` only, the
    root vitest includes `src/**/*.test.ts` only, biome ignores `tools/review`, and the review
    workflow installs it and runs its scripts but never `pnpm --dir tools/review test`. That
    workflow executes the PR head's `tools/review` code with a write token, so this is the
    least-measured code in the repo with the most privilege. This decision takes it out of
    metrics it was only distorting; it does not measure it. The follow-up makes the gate run a
    touched nested package's own `test` and `typecheck` scripts, and makes dead-code,
    duplication and coverage print "N changed file(s) in a nested package not measured here"
    rather than pass silently (decision 29: a capability says what it did not measure).
    The trusted side is trusted one merge deep, so a PR that commits `src/core/package.json`
    and merges exempts `src/core/` from then on; that is decision 31's accepted residual, and
    it is a visible line in a PR diff. The root's runner is not consulted: a nested package
    whose tests the root vitest config *does* collect is still dropped, so its files leave the
    root's metrics although the root could measure them. That too needs the marker merged
    first, and is the price of not parsing runner config. Complexity is unaffected; it is
    measured per changed file and does not depend on which unit the file belongs to. vitest
    still instruments the nested package's files before pup discards them, decision 32's same
    bounded waste.
    *Python does not apply the rule.* The observed cost came from two things the TypeScript
    adapter owns and the Python adapter does not: a source walk of its own, and an include glob
    that reports unloaded files as 0%. Python's dead code and coverage are delegated to vulture
    and pytest-cov under the repo's own config, which decides their scope, and with no
    include-equivalent (decision 30) an unimported nested module is absent from the report
    rather than dragging the ratio down. What would carry over is `coverableFiles` flagging a
    changed file in a nested Python project as unreported, and the marker there
    (`pyproject.toml`, `setup.py`, `setup.cfg`) is a different question with no Python repo here
    to dogfood it against, so it is deferred rather than guessed at.
    *Observed cost, and the re-stamp.* The 84% and 19 baselines stamped on 2026-09-18 were
    counted under the old rule. As decision 39 learned, a gate change cannot be validated by the
    gate: `pup merge` runs the main checkout's adapter, so this change was judged by the rule it
    replaces, and nothing was run against itself to prove it. The operator re-runs `pup audit`
    on main after it lands to re-stamp the baseline. Measured directly on this tree before
    landing, dead exports are 15 with none under `tools/`; the one above the pre-#95 14 is a
    genuine dead export added since, not this rule. Until that audit the three metrics differ:
    - *Coverage* carries no rule id, so a baseline counted the old way (84%) sits below what
      the new rule measures (about 92%), and a merge can drop coverage by up to that gap
      unflagged.
    - *Dead exports* have no window. They are compared as sets of file and export name, so the
      stale `tools/review` keys in the stored baseline are simply entries nothing can reach
      again, and a new dead export is still new.
    - *Duplication* keeps `DUPLICATION_RULE_ID` unchanged, so it compares a new-rule number
      against an old-rule baseline until the follow-up bumps the id or `pup audit` re-stamps.
      Today the gap is zero, because `tools/review` holds no counted duplicate block, but it is
      the check decision 39 built the id for, and it is not being made here.
    The re-stamp has a cost of its own: it *raises* the bar a PR's patch coverage is held to from 84% to about 92%, so
    an unrelated later PR landing at 85–90% patch coverage will be flagged for a move it did
    not cause. That is the honest number arriving, not a regression, and the operator should
    expect it rather than reach for `--accept-debt`.

59. **A nested package's own runner is a gate stage, and what the root leaves out is said
    (2026-09-21).** Decision 58 took nested packages out of the root's metrics on the claim that
    their own runner covers them, and stated the ceiling: nothing invoked that runner, so
    `tools/review` was measured by scope-audit and complexity alone while the review workflow
    executed the PR head's copy of it with a write token. This closes the four gaps it named.
    *The runner runs.* When the diff touches a file inside a nested package, the gate runs that
    package's `test` and `typecheck` scripts as hard stages, after the root's build, test and
    lint and before the scope audit, named `test (<dir>)` and `typecheck (<dir>)`. They
    resolve from the trusted checkout's `<dir>/package.json` through its own package manager,
    decision 11's manifest-wins rule as `gateCommands` applies it to the root, so a session that
    deletes its package's test script fails the stage rather than skipping it. They run with
    the package directory as cwd through the same `runGateChild` the root stages use, one
    shared closure in the gate, so the sandbox, the timeout, the env scrub and the
    failure-detail cleaning are the root's by construction. A file belongs to its innermost
    nested package. Any changed file triggers the stages, a deletion or a README included,
    since a deleted test is a change the package's tests are for. The adapter answers through
    one optional capability, `touchedNestedPackages`, reusing decision 58's resolver and
    predicate, so the packages the gate runs are exactly the ones the root measurements drop;
    an adapter without it has no nested packages, which is Python's position under decision 58.
    *A missing script is a flag, not a skip.* A nested package whose trusted manifest declares
    no `test` or no `typecheck` gets a flagged stage per missing script, with a ledger entry
    when accepted. A root with no test script is skipped as "not measured", but that is a
    whole-repo configuration; here the diff has changed code that no stage of any kind
    measures, which is decision 30's "changed source plus no measurement is a flag". The
    scripts are required by name, with no `tsc` fallback: the package's own manifest is the
    only statement of how it is checked. A flagged stage now sits among the hard ones, so
    `flaggedDebt` and its detail builder moved above them; its text is pup's own plus a
    `quotePath`-sanitized directory, so steering it after a later hard failure is safe.
    *What was left out is said (decision 29).* Dead code, duplication and coverage append
    "; N changed file(s) in a nested package not measured here (<dirs>)" to every detail they
    print, pass, skip or flag, ahead of the accept hint, the way duplication already names its
    uncounted fixture blocks. N counts changed source files that still exist, the ones the
    root walk and `coverableFiles` would otherwise have seen; directories past three are
    elided. Before this, a PR touching only `tools/review` read "no instrumentable changed
    lines" on coverage, a pass that described an exclusion as an absence.
    *The duplication rule id is bumped* to `tests-excluded+nested-packages`, so a baseline
    stamped before decision 58 skips with "run `pup audit`" instead of comparing (decision
    39's mechanism). Decision 58 left the id unchanged with a gap of zero; the bump makes the
    check real rather than coincidental, at the cost of one skipped duplication stage until the
    operator re-stamps.
    *The workflow runs the base's tooling.* `claude-code-review.yml` extracts `tools/review`
    at the merge base into `.review-tooling/` with `git archive`, installs it there, and runs
    every script step from it. Restoring in place, as AGENTS.md is restored, would dirty the
    tree before the preflight, which refuses a dirty tree, and would hide the head's copy from
    the reviewers who are meant to read it; the directory is added to `.git/info/exclude` so
    it never reads as dirt. **The operator's security review of the first cut found it
    bypassable,** and three guards now hold it. pnpm walks up from `--dir` to find a workspace
    root, and `.review-tooling/` sits inside the head's checkout, so a head-committed root
    `pnpm-workspace.yaml` listing the directory had its root `preinstall` run by the
    token-carrying install and its `nodeOptions: --require` injected into every script step
    (reproduced with the pinned pnpm 10.34.5); the install and all four run steps pass
    `--ignore-workspace`, verified to suppress both. `tar -x` never removes a file the base
    archive lacks, so a head that commits `.review-tooling` itself is refused before the
    archive is unpacked. And the pnpm binary was chosen by `packageManager` in the merge ref's
    `tools/review/package.json`, the head's copy; `pnpm/action-setup` now pins `version:
    10.34.5` and reads no manifest for it (it still compares the root manifest's field, so a
    head that changes it fails the run rather than choosing the binary). The restore runs
    under `pipefail`, so a failed `git archive` is not masked by `tar`. The early install from
    the merge ref is gone, so a run that dies at the head checkout now leaves no metrics
    record. **The remaining ceiling:** on `pull_request` the head's own copy of this workflow
    file is what runs, so a PR that edits the workflow can drop every guard above; those runs
    are reviewed as workflow changes, not protected by them. An `@claude review` comment runs
    `main`'s copy, which is the only run the guards bind.
    *Tests, and the mutation.* Unit tests on temp repos, never the gate run on itself (decision
    39): a nested test script that exits non-zero refuses the merge with its output in the
    detail; removing the stage loop from the gate fails five of the nested-package tests,
    including that one, with the file restored from a backup copy. Others assert the stage
    order and pass, the package directory as cwd, the env scrub, the trusted manifest winning
    in both directions, no stage for a diff outside every package, the flag and its ledger
    entries, the note on all three debt stages and its elision, the innermost-package rule, and
    the rule-id skip. The first full-suite run also exposed a test-isolation leak: a test whose
    gate never steered left a throwing once-implementation queued on `steerPane`, which
    `clearAllMocks` keeps, and the suite now resets that mock before each test.
    *Ceilings.* The stages run the scripts the trusted manifest names, but the bodies come from
    the worktree's manifest, as the root's do. Nothing installs the nested package's
    dependencies in the worktree, so a package whose runner needs them fails its stage until
    they are installed there: a loud failure, the safe direction, and an environment question
    rather than a gate one. The flag fires for any touched package, so a package that means to
    have no typecheck has to be accepted as debt each time it changes, or declare the script.

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

## Implementation notes

- Shared SQLite store in WAL mode so concurrent hook writes from multiple worktrees don't contend.
- Node >= 22, TypeScript, commander, better-sqlite3, and ink + react for `pup ui` (per 08-roadmap
  stack decision, amended by decision 52; the Node floor is Ink 7's).
