# 0186. A task carries a copy of its ticket, and the kickoff and the review show its design (2026-11-13)

- Status: accepted
- Amends: [0176](0176-a-ticket-has-a-type-and-only-some-types-need.md)

186. **A task carries a copy of its ticket, and the kickoff and the review show its design (2026-11-13).**
    *The copy.* A task launched from a ticket of decision 176 holds `ticket` on its spec: the
    tracker's reference, the type, the labels, the design triggers that fired, the design note and
    this slice's acceptance criteria. It is a copy taken when the task is written, not a read of
    the tracker at launch: the spec freezes once a session claims it, and the ticket with it, so
    the gate, the review and the kickoff all see the design the session was given. A stored ticket
    of the wrong shape is a refusal naming the task, as a bad scope is (decision 68).
    *Who writes it.* Step 4's intake, which does not exist yet. No command writes it in this
    slice: `pup plan add` takes no ticket, because the `design-approved` label is the operator's
    validation, and a flag the conductor could pass would let an agent claim it.
    *The refusal.* The plannable checks of decision 40 refuse a task whose ticket lacks
    `design-approved` when the ticket needed a design: a feature, or any type a design trigger
    fired on. A bug, chore, refactor, docs, spike or follow-up no trigger fired on needs no label.
    A type the check does not know needs the label, as a feature does. The checks run at
    `pup plan add`, `pup plan edit`, the launch and every read of the spec, so the gate and
    `pup review` refuse such a task too.
    *The kickoff.* A task with a ticket gains a `## Ticket` section below the session protocol:
    the design note and the slice's criteria, each line quoted, framed as the brief is (decision
    57). Issue text is written by whoever files the issue, so it reaches the prompt as quoted data
    (decision 176) that changes no task, scope or rule. A task with no ticket compiles exactly as
    before, to the same hash.
    *The review.* `pup review <session>` prints the ticket's slice criteria, one per line, above
    the diff's file list, so the reviewer reads what the slice owes before what it changed.
    *Advisory only.* No gate stage checks the criteria. `pup intent` (decision 126) stays until
    step 4 retires it. No setting of decision 178 guards this slice: a ticket reaches a spec only
    through intake, which ships behind that step's setting, and a task without one is unchanged.
