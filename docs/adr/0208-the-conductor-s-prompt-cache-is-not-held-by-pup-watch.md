# 0208. The conductor's prompt cache is not held by `pup watch` (2026-11-23)

- Status: accepted
- Amends: [0179](0179-pup-watch-holds-a-waiting-worker-s-prompt-cache.md)

208. **The conductor's prompt cache is not held by `pup watch` (2026-11-23).**
    The retro of 2026-11-23 counted 4 conductor requests that came after an idle hour and wrote
    the whole context back: 308865 tokens, about 3.09 USD in a week. Decision 179 holds a waiting
    worker's cache and rejects holding the conductor. This looked at whether that rejection
    still stands. It does, and no behaviour changes.
    The conductor's window is skipped today because `holdIdleCaches` lists session rows in
    `awaiting-review` or `running`, and the conductor has no row: it is not a session (decision
    47). It also holds no state to wait in. That is the smaller reason. The larger one is that
    the hold has no clock for it. A worker's hold is timed on the mtime of its events file, which
    trails its last request by the idle notice. The conductor's profile has no event hook (decision
    47), so it has no events file, and the store records none of its turns: a prompt the operator
    types into it, and the turn that follows, leave nothing pup reads. The one conductor event
    pup keeps, `turn_died`, is filed against no session and says only when a nudge was typed.
    A hold sent without a clock is a guess about the hour. The cache is an hour from the last
    request, and neither the last request nor the end of the last turn is known. A hold typed
    too early starts nothing the next one would not, and one typed too late pays the write it
    exists to avoid. The alternatives all fail:
    - Holding on a fixed period from the sweep (say every 50 minutes) spends a hold per period
      for as long as the window is open, whether or not the operator is at it. A working
      conductor does not need one, and an idle one is held all night with no `CACHE_HOLD_LIMIT`
      to stop it, since the limit counts events against a session and the conductor has none.
    - Reading the pane for the time of the last turn: the transcript carries no time, only a
      status line's elapsed counters while a turn runs.
    - Reading Claude Code's own transcript file for the conductor: it is the conductor's to
      write, lives in the checkout's transcript directory shared with the operator's own Claude
      windows in the same checkout, and decision 179 rejects a transcript as a clock for the
      worker case already.
    - Adding an event hook to the conductor's profile: it would give a clock, but it changes the
      conductor's compiled profile, which is out of scope here and is a decision of its own.
    The unsent draft is not the obstacle. The conductor's box can be read as a worker's is
    (`readInputBox`) and a hold left alone when it holds text, and the `--name` check of decision
    179 would carry over to the conductor's pane. Both are cheap. What cannot be made safe is
    when to type, and, because the conductor is also the operator's own console, a hold typed
    at the wrong moment lands in a turn the operator may be in the middle of.
    The cost stays: a conductor left idle past the hour pays one write when it wakes, about 77k
    tokens a time on the retro's figures, and about 3 USD a week. Reopening this needs a clock:
    an event hook in the conductor's profile whose file the hold can read as it reads a worker's,
    with the same 50-to-58-minute window, the same dormant-project skip (decision 62), a draft
    check and a hold limit counted for the project rather than a session.
    Rejected: holding the conductor on a timer with no clock, as above. Respawning it on a fresh
    window before the hour: it would lose the conductor's context for the price of the write it
    avoids.
