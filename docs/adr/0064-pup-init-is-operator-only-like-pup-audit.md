# 0064. `pup init` is operator-only, like `pup audit` (2026-09-22)

- Status: accepted

64. **`pup init` is operator-only, like `pup audit` (2026-09-22).** Decision 56 named this as a
    ceiling: `pup init` calls the same `initProject` the audit calls. That function stamps
    `projects.baseline` and appends a `baseline_history` row, so a session that could not run
    `pup audit` (decision 48) could still re-stamp its own bar through `pup init`.
    *The guard is the audit's.* The init action asks `callingSession(db)` first. If a session is
    calling, it refuses with `` `pup init` is operator-only; sessions cannot move the baseline. ``
    and exits 1. That happens before `initProject` runs, so nothing is measured, recorded or
    stamped. The conductor is not refused, for the reason decision 48 lets it audit: setup is
    part of the operator work it is delegated. Decision 27's ceiling still applies. A session
    that `cd`s out of its worktree and unsets `PUP_SESSION_ID` looks like an operator.
    *What the guard made dead is deleted.* Decision 56 had a session's `pup init` run with
    `OriginRecording = 'skip'`, so the push target was left alone while the baseline was still
    stamped. It also had a separate refusal for a session's `--origin-moved`. A session can no
    longer reach either path. `'skip'` is removed from the type and from `recordOriginUrl`, and
    the session branch is removed from the action, along with both tests. `--origin-moved` is
    covered by the whole-command refusal, so there is one refusal and one message.
    `'record'` and `'re-record'` remain, and both are the operator's.
    *Tests,* in `index.test.ts`, on a temp store with a seeded session. `init` and
    `init --origin-moved` are each refused with the one line, print nothing else, exit 1, and
    leave `projects.baseline` and `origin_url` null. With `PUP_CONDUCTOR` set, `init` records
    the push target and stores a baseline.
    *The discriminating mutations*, each run against a backup copy of `index.ts` and restored
    from it. Removing the guard fails both refusal tests. Keeping the refusal line but dropping
    its `return`, so the command goes on, fails both on the output. With the output and exit-code
    assertions also taken out of a scratch copy of the test, removing the guard still fails both
    on the rows. Bare `init` re-stamps the baseline. `--origin-moved` writes the push target.
