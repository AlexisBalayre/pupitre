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

## Safety & enforcement

5. **Sessions run with permissions bypassed; compiled hooks are the enforcement layer.**
   Scope-in globs on Edit/Write; deny-patterns on Bash.
6. **Bash scope checking is best-effort**: a real shell parser denies clear write patterns
   (`>`, `>>`, `tee`, `sed -i`, `rm`/`mv`/`cp`, `git apply`…) whose resolved target is out of scope
   or inside `.claude/`. Unparseable commands pass. The authoritative backstop is the gate:
   diff-vs-scope is a hard fail, and a `.claude/` drift-hash mismatch is a hard fail.
7. **Rejection→re-steer is capped at 2.** A third gate failure parks the session as
   `blocked — needs human`, surfaced at the top of `pup status` with the failure history.

## Merge semantics

8. **Fresh-base gating**: the gate refuses branches that are stale vs main. **Pupitre auto-rebases
   mechanically**; only conflicts go back to the session as a re-steer ("rebase onto main and
   resolve"). Merges are serialized under a lock.

## Config & profiles

9. **Full isolation via `CLAUDE_CONFIG_DIR`**: each session gets a compiler-owned config dir, so
   the profile hash covers the entire behavior surface. User-level `~/.claude` never leaks in.
10. **A repo's committed `.claude/` is a native fourth layer.** Compiled output lives at the
    isolated user level; the repo's skills/agents/CLAUDE.md ride along untouched as the project
    layer. The compiler reads the repo layer to count it against the context budget and flag
    convention conflicts at init. The compiler never modifies tracked files.
11. **Gate-time Claude work runs as one-shot `claude -p` utilities** (reviewer pass, decision-record
    drafting, init audit): fixed prompt in, structured output out, same config isolation, read-only
    tools. Not sessions — no state machine entry, just a logged `utility_call` event.

12. **Session auth via `claude setup-token`** (2026-07-22 spike finding): an isolated
    `CLAUDE_CONFIG_DIR` has no login state, so every session gets `CLAUDE_CODE_OAUTH_TOKEN`
    injected into its environment. The token comes from a one-time interactive `claude
    setup-token` and lives in the repo-root `.env` (gitignored). No keychain/oauth internals
    are replicated into session config dirs.

## Gate metrics

13. **Coverage = patch coverage vs a ratcheting baseline**: only added/modified lines are measured;
    their coverage ratio must meet the repo baseline. Deletions are free by construction.
14. **v1 gate slims to**: build, tests, lint, scope audit, diff-size flag, minimal ledger with
    `--accept-debt`. Patch coverage and the full debt-delta stage (duplication, dead code,
    complexity) move to v1.1 with the ratchet.

## Implementation notes

- Shared SQLite store in WAL mode so concurrent hook writes from multiple worktrees don't contend.
- Node >= 20, TypeScript, commander, better-sqlite3 (per 08-roadmap stack decision).
