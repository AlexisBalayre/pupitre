# 0007. Rejection→re-steer is capped at 2

- Status: accepted
- Amended by: [0090](0090-pup-fix-session-hands-the-ci-review-s.md)

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
