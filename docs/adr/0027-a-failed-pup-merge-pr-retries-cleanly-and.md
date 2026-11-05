# 0027. A failed `pup merge --pr` retries cleanly, and the ledger names the real acceptor (2026-07-25)

- Status: accepted
- Amended by: [0105](0105-a-branch-an-open-pr-holds-is-never.md)

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
    *Amended by decision 105:* the lease is kept only for a branch no open PR holds; an open
    PR's branch is merged with the target rather than rebased, and pushed without force.
    Still accepted: a PR closed without merging leaves a `merged` session whose commits
    live only on the remote branch; the between-open-and-merge baseline gap stands until
    the post-merge `pup audit`; adoption inherits everything about the PR except title and
    body (labels, reviewers, comments) — only armed auto-merge is refused, since that one
    would land the commits without the operator click the CLI tells them to make; and the
    adoption checks are a probe, so a base flipped on GitHub afterwards is not re-checked.
