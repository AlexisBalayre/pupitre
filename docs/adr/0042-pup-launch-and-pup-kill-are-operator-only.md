# 0042. `pup launch` and `pup kill` are operator-only, so admission control is a control (2026-09-05)

- Status: accepted

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
