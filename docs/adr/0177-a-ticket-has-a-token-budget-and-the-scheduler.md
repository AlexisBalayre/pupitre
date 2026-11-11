# 0177. A ticket has a token budget, and the scheduler launches within machine load and usage (2026-11-11)

- Status: accepted
- Amends: [0096](0096-test-runs-queue-for-a-few-machine-wide.md)
- Amends: [0156](0156-launches-hold-while-the-plan-s-usage-windows-run-low.md)
- Amends: [0144](0144-the-session-cap-counts-working-sessions-not-those.md)

177. **A ticket has a token budget, and the scheduler launches within machine load and usage (2026-11-11).**
    *The budget.* Spend is recorded per ticket. For the first 30 tickets the budget only warns. Then
    it is set at about twice the median ticket spend. When a ticket's spend reaches it, the scheduler
    stops launching sessions for that ticket and puts it in the operator's queue with the spend so
    far. The operator extends, re-slices or cancels, and no budget is ever extended automatically.
    The per-commit review of decision 174 is the first spender to stop at the budget.
    *Capacity.* The scheduler launches a slice only while machine load and the plan's 7-day usage
    allow it, up to a ceiling the operator sets, starting at 8. The hold of decision 156, which stops
    launches while a usage window runs low, stays and joins the load check. It backs off when load passes a
    threshold, instead of letting the hook time out. This replaces the fixed `--max-sessions` that a
    bare conductor start reset to 4.
    *Reach.* A session touches only its own worktree and pushes only its own branch. It adds no
    dependency, which is a design trigger in decision 176.
    *An outage.* When GitHub is unavailable or rate-limited, the scheduler stops launching, running
    sessions finish their local work, and the dashboard shows what is waiting. Nothing is dropped.
    *The queue.* The operator sees one queue in `pup dashboard`, sorted by age, with each row opening
    its one-screen brief, and `pup queue` prints the same list. The brief opens with what blocks the
    merge, then the change, the slice's design reference, the review result (rounds, importants
    fixed, follow-ups filed), size against the cap and cost.
    *When it applies.* After the rollout setting of decision 178 is on for the project. Until then
    decisions 96, 144 and 156 govern.
    *Why.* No per-ticket cost exists today: the best proxy is about $19 per merged PR, and a load of
    60 to 100 with 14 sessions made the hook time out.
