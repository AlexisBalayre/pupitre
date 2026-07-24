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

## Implementation notes

- Shared SQLite store in WAL mode so concurrent hook writes from multiple worktrees don't contend.
- Node >= 20, TypeScript, commander, better-sqlite3 (per 08-roadmap stack decision).
