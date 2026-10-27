# 0088. The merge lock records its holder, survives every exit pup can catch, is reclaimed from a dead holder, and `pup merge` and `pup land` wait for a live one; the gate waits for the machine's load before its tests (2026-10-26, amends 8, 84, 95 and 96)

- Status: accepted
- Amends: [0008](0008-fresh-base-gating.md), [0084](0084-pup-land-session-closes-the-github-half-of.md), [0095](0095-the-gate-pup-audit-and-pup-land-run.md), [0096](0096-test-runs-queue-for-a-few-machine-wide.md)

88. **The merge lock records its holder, survives every exit pup can catch, is reclaimed from a
    dead holder, and `pup merge` and `pup land` wait for a live one; the gate waits for the
    machine's load before its tests (2026-10-26, amends 8, 84, 95 and 96).**
    Four ways the lock in `.git/pup-merge.lock` stopped work it should not have. `withMergeLock`
    listened for SIGINT and SIGTERM only, so closing the terminal (a SIGHUP) killed node in the
    middle of the locked section and left the lock behind. A SIGKILL or a crash left one too, and
    every later merge and land refused until the operator removed it by hand. The post-merge
    `git worktree remove --force` could throw past the baseline ratchet, which then never ran
    although the target held the sha. And a held lock or a loaded machine was the conductor's to
    wait out: from 10-13 to 10-23 it ran 22 load-average wait loops of its own and the console
    sent 14 lock hand-offs to the operator, about $23.
    The rules:
    - The listener covers SIGHUP as well as SIGINT and SIGTERM, for as long as the lock is held,
      and only then.
    - Taking the lock writes the holder's pid into it (`pid`, a regular file, created exclusively
      after the `mkdir`). The lock sits in a `.git` a session can write, so the take records the
      directory's dev and inode right after the `mkdir`, and every later step requires a real
      directory with that identity: after the pid write, before the undo of a failed one, and
      after the rename aside on release or reclaim. A directory swapped for a link or another
      directory (another project's lock, whose pid a removal through the link would delete) is
      left as it is and named, and a take that finds the swap after its pid write takes nothing.
      A pid write that fails removes the pid and the directory again, since a lock with no pid
      would refuse every later run. The lock is released by renaming it aside and removing it
      there, so no reader ever finds the lock without its pid. Only the pid file and the empty
      directory are removed; anything else found in it is left in the aside directory and named,
      never removed recursively. Release checks that the directory is the one the take made, not
      that its pid file still names this process.
    - A run that finds the lock reads the pid only from a real directory, without following a
      link or opening a fifo. A pid that is no longer alive (`kill(pid, 0)` fails with anything
      but EPERM) is reclaimed under a second lock, `pup-merge.lock.reclaim`, and the pid is read
      again under it, so two runs that both read the dead pid cannot both reclaim. A reclaim lock
      older than 10 s, or dated in the future, was stranded by a run killed mid-reclaim (which
      takes a few syscalls) or planted, and is replaced. A live pid, or EPERM (another user's
      process), is held, and the refusal names the pid and says not to remove the lock; a dead
      pid another run is reclaiming refuses in words of its own, naming the reclaim lock. A lock
      with no pid file, or one that does not hold a positive whole number, is looked at again
      every 100 ms for a second, since a taker writes its pid in the same tick as its `mkdir`,
      and then refuses as before: an earlier pup or a hand-made lock is not guessed at.
    - `pup merge` and `pup land` wait for a live holder, polling once a second, for up to
      `MERGE_LOCK_WAIT_MS`: what a gate with one suite can hold the lock for, its build, test run
      and that run's re-run each bounded by a stage's timeout, plus its slot wait and its load
      wait (50 minutes). Each nested package's suite adds a stage, so a gate over such a repo can
      outlast it, and the waiter then refuses rather than wait on. They print one line when the
      wait starts, naming the pid, and refuse with `MergeLockHeldError` only once it runs out.
      Only the CLI opts in (`MergeRequest.wait`, `wait` on `pup land`'s request). `pup fix` and
      every other caller still refuse at once. The wait runs with node's default disposition, so
      a Ctrl-C ends it before any lock is taken.
    - The gate plans again under the lock (`planMerge`, every refusal `runMergeGate` makes before
      the lock) whenever its take waited, or the session's state, reject count or newest event
      changed since the first plan began: a holder released during that plan's gh calls, or a
      dead one reclaimed, may have changed it without any wait, so the mark is taken before the
      plan reads anything. Taken last, it held the change and the stale plan went on to the
      fast-forward or push. The run that held the lock may have
      rejected and re-steered the session, merged it, re-gated it or opened its fix round, or a
      driver may have been armed during the wait. Gated on the stale plan, a second `pup merge`
      would fast-forward main for a session already rejected and then fail its `merged`
      transition, or record a merged session's merge and ratchet the baseline twice.
    - `pup land` writes its `landed` event as the last step under the lock, and refuses under the
      lock a session that has one. Before, the event came after the release and the audit, so a
      second land waiting on the first's lock found the session still merged and landed it
      again: a second audit, a second event, and every overlapping session steered twice. The
      overlapping sessions are steered right after the release, before the audit: once the event
      is written a re-run refuses and nothing else steers them (decision 99), so an audit that
      threw first, on an interrupt, a missing adapter or a sandbox refusal, would leave them
      unsteered for good. An audit that fails after both is `pup audit`'s to re-run, and
      `pup land` refuses the landed session.
    - A gate asked to wait (`waitForLoad`) waits, before it takes its test slot and before the
      stages that run alongside its suites, until the 1-minute load average is under the
      machine's available parallelism, so the load it reads is not its own lint, typecheck and
      debt children. It polls every 5 s for up to `GATE_SLOT_WAIT_MS`, prints one line when the
      wait starts and one when it runs out, and then runs the tests anyway. An interrupt during
      the wait unwinds as a stage child's would (`GateInterruptedError`). A platform with no load
      average reads zeros and never waits.
    - The gate's post-merge worktree remove is swallowed, as the branch delete after it already
      was. The worktree is kept with its branch, git's refusal is printed, the outcome names it
      (`MergeOutcome.keptWorktree`, which `pup merge` prints as `pup land` prints its own), and
      the ratchet and the decision draft run. A gitfile the session swapped, which the remove
      refuses, now reads as a merge with a kept worktree and git's words, no longer a throw.
    - The conductor's standing orders say that `pup merge` and `pup land` wait for the lock and
      the load themselves, and forbid it to loop on the load average or to ask the operator to
      release the lock. A refusal on a held lock is reported to the operator as it stands, and
      the conductor never deletes the lock.
    Owed, from the security reviews of this change:
    - `withTestSlot`'s wait (`test-slot.service.ts`, outside this task's scope) listens for
      SIGINT and SIGTERM only. With the lock now holding node through a SIGHUP, closing the
      terminal during a gate's slot wait is discarded and the gate carries on to merge. The slot
      wait should listen for SIGHUP as well.
    - The holder is known by its pid alone. A pid reused by another process, or one a session
      plants (pid 1 reads as alive through EPERM), holds every waiting gate for the whole wait
      and then refuses, the same denial a pid-less lock already causes at once. Recording the
      process's start time beside the pid, and counting the holder alive only when both match,
      closes it.
    - `MergeLockHeldError`'s own message still says to remove a stale lock. The gate replaces it
      when the lock names a pid; the class should take the holder instead.
    - Two runs that find one stranded reclaim lock in the same instant can both replace it, and
      the second can then move aside the lock the first just took. That needs a run killed
      mid-reclaim and then two runs interleaving in a few syscalls.
    - The identity checks narrow the swap to the moment between a check and the call after it;
      path-based fs calls cannot close it.
    Also from the decision 86 review (PR #150): `land.service.ts` imports `COMMIT_SHA` from
    `merge-gate.constants.ts`, and `merge-gate.service.ts` drops the re-export it kept for it
    (docs/conventions/general.md: no compatibility re-exports).
    Tests: a SIGHUP listener is held with the other two and gone after; the lock holds the taker's
    pid; a lock whose pid is dead is reclaimed and the merge lands with nothing left in `.git`; a
    lock held by a live pid, by a file that is not a pid, or by an empty file refuses and is left
    as it was, a live one saying not to remove it; a lock path that is a link refuses and nothing
    it points at is read or removed; a lock swapped for a link while held, before its pid write
    or before the undo of a failed one leaves the other lock's pid in place and is named, and the
    take after a swap takes nothing; a stranded reclaim lock and one dated in the future are
    replaced, a fresh one is left with its own refusal, and a stale one that cannot be removed is
    treated as held; a take whose pid write fails leaves no lock; a release leaves a planted file
    in the aside directory and names it; a merge and a land asked to wait take a live holder's
    lock once it is released, printing one line; a merge that waited while the holder rejected
    and re-steered the session, or merged it, and one whose session was rejected between its plan
    and its take with no wait, refuse with main unmoved, no reject counted and no merge recorded;
    of two lands of one session waiting on one lock, the second refuses under it with one
    `landed` event; under a fake clock the wait takes the lock once it is released and refuses at
    the timeout, leaving the holder its lock, waits out a pid written after the `mkdir`, and
    refuses a lock still without one after a second; under a fake load source the load wait
    returns at once under the ceiling, waits for the load to fall with one line, runs the tests
    after its timeout with a one-line note, and on an interrupt rejects with
    `GateInterruptedError` and leaves no listener; a failing post-merge worktree remove (a fake
    git) still ratchets the baseline, keeps the worktree and its branch, and names it in the
    outcome; the conductor context forbids the load loops and the lock hand-offs.
