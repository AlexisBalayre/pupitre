# 0195. `pup land` takes several sessions and audits once (2026-11-17)

- Status: accepted
- Amends: [0084](0084-pup-land-session-closes-the-github-half-of.md), [0132](0132-pup-land-no-audit-lets-several-lands-share-one.md)

195. **`pup land` takes several sessions and audits once (2026-11-17).**
    On 2026-11-16 three PRs merged within minutes. Their three `pup land` runs each held the merge
    lock for a full audit (build, an instrumented test run of about 330 s, lint), one after
    another: about 25 minutes of lock, and only the last baseline was of any use. Decision 132's
    `--no-audit` avoids that only if the operator remembers it on every land but the last, and
    the conductor never passes it.
    *The rule.* `pup land <session> <session> ...` lands several sessions under one hold of the
    merge lock and audits once. Each session first gets every check `pup land` makes before the
    lock (decisions 84, 86, 146), outside it, as today. Under the lock, the sessions that passed
    land in the order GitHub merged them. That order is ancestry on origin's target: after each
    session come those whose merge commit descends from its own. Origin's target is fetched once
    per origin and target before the sessions are ordered. Only the order rests on that read, and
    each land still checks its own merge commit against what it fetches. Each session is checked,
    fast-forwarded, torn down, steered and given its `landed` event exactly as a single land
    does. The first land moves the local target to origin's tip, and the later ones find it
    already there. Then the audit runs once, still under the lock, on the final target, and
    refreshes the baseline once (decision 88's reason holds: no gate measures against the
    baseline from before the lands or writes over the refresh). `--no-audit` still skips it.
    *A refused session.* A session that fails its own checks, before the lock or under it, is
    reported with its refusal and skipped, and the others still land. It gets no `landed` event,
    as a single refused land does, but main may already hold its merge commit: an earlier land
    moved main to origin's tip. Its refusal says so in place of a single land's "Nothing was
    landed". The CLI prints each land, then the audit, then each refusal, and exits non-zero once
    all have run. When every session is refused, no lock is taken and no audit runs. An audit that
    fails after the lands is reported, not thrown: the lands stand, their lines are printed, and
    the run exits non-zero with `pup audit` for the operator to re-run.
    *What stops the batch.* An interrupt or a kill stops it, and so does a lost merge lock.
    Decision 88's lock keeps node alive through a signal and discards one that kills no child,
    for example during a steer's waits. For one land that only lets the land finish, but a batch
    would land every session after it. So the batch records any interrupt under the lock itself,
    and before each land and before the audit it stops on one with `GateInterruptedError`, as a
    killed child does. Before each land and before the audit, the batch also checks that it still
    holds the lock as it took it. Once the lock is lost, no further session lands and no audit runs, since another
    merge or land may be running and the audit keeps the baseline it writes. The sessions not
    yet tried are reported as refused, and the release throws `MergeLockLostError` carrying the
    batch's outcome. The run prints that outcome and then fails, as decision 88 has it for one
    land.
    *One session's flags stay with one session.* `--accept-head` (decision 164) and `--remeasure`
    (decision 185) vouch for one PR's moved head. `--abandon-closed` (decision 146) records one
    closed PR. Each is refused with more than one session, so an operator's word for one head
    cannot ride along on another's land. Such a PR is landed alone. A session named twice lands
    once. `pup land <session>` with one session is unchanged, flags and all.
    *Not taken.* A loop over single lands with the audit only on the last one was not taken. It
    would release the lock between lands, so a waiting gate could ratchet the baseline from before
    the lands and the audit would then write over it. Ordering by GitHub's `mergedAt` was not taken
    either: it is one more `gh` read per PR, and a clock where the commit graph already holds the
    order.
