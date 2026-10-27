# 0048. `pup audit` is operator-only: the thing that moves the bar is not the thing being judged (2026-09-12)

- Status: accepted

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
