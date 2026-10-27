# 0044. A session reports only its own state, and `merge` and `respawn` are operator-only (2026-09-06)

- Status: accepted

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
